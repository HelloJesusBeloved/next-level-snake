import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, cp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const ignore = require('ignore');
const root = process.cwd();
const contents = (file) => readFile(path.join(root, file), 'utf8');

async function filesIn(dir, prefix = '') {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix + entry.name;
    if (entry.isDirectory()) out.push(...await filesIn(path.join(dir, entry.name), rel + '/'));
    else out.push(rel);
  }
  return out;
}

// The reported failure came from referencing a generated-image directory that
// wasn't in a checkout. Exercise ALL the current Dockerfile COPY instructions
// using a text-only source checkout (no public/img at all), not just this repo's
// working tree where photos happen to exist.
test('every COPY source exists in a source-only checkout without images', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'snake-source-only-'));
  try {
    await mkdir(path.join(dir, 'public'));
    await cp(path.join(root, 'rails'), path.join(dir, 'rails'), { recursive: true });
    for (const filename of await filesIn(path.join(root, 'public'))) {
      if (filename.startsWith('img/')) continue;
      await mkdir(path.dirname(path.join(dir, 'public', filename)), { recursive: true });
      await cp(path.join(root, 'public', filename), path.join(dir, 'public', filename));
    }
    await assert.rejects(access(path.join(dir, 'public/img')));
    const source = await contents('Dockerfile');
    const instructions = source.split('\n').filter((line) => /^COPY\s/.test(line));
    assert.ok(instructions.some((line) => line === 'COPY public/ /app/public/'));
    assert.ok(!instructions.some((line) => /public\/img/.test(line)));
    for (const line of instructions) {
      // Cross-stage COPY reads the image filesystem, not a repository path.
      if (/--from=/.test(line)) continue;
      const parts = line.replace(/^COPY\s+/, '').trim().split(/\s+/);
      for (const input of parts.slice(0, -1)) await access(path.join(dir, input));
    }
    await access(path.join(dir, 'public/violet-mist.svg'));
    // The photo-backed Violet skin is optional; the text asset is still
    // shipped even when public/img is missing from the source checkout.
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('build ignore rules include optional photos and exclude secrets and preview dependencies', async () => {
  const rules = ignore().add(await contents('.dockerignore'));
  for (const input of ['Dockerfile', 'rails/Gemfile', 'rails/app/models/user.rb', 'public/game.js', 'public/profile.js', 'public/violet-mist.svg', 'public/img/metal.jpg', 'public/img/violet-swirl.jpg']) {
    assert.equal(rules.ignores(input), false, input + ' must be in the context');
  }
  for (const input of ['.env', 'node_modules/something.js', '.next/server/a.js', 'rails/.env', 'rails/config/master.key', 'rails/tmp/pids/server.pid', 'rails/log/production.log', 'rails/public/img/duplicate.jpg']) {
    assert.equal(rules.ignores(input), true, input + ' must not be in the context');
  }
});

test('native Compose uses private SELinux-labeled storage, with no unsafe security overrides', async () => {
  const source = await contents('compose.yaml');
  const config = yaml.load(source);
  assert.equal(config.services.app.build.context, '.');
  assert.equal(config.services.app.build.dockerfile, 'Dockerfile');
  assert.equal(config.services.app.volumes, undefined, 'application files should be in the image, not a home bind mount');
  assert.deepEqual(config.services.db.volumes, ['pgdata:/var/lib/postgresql/data:Z']);
  assert.equal(config.services.db.image, 'docker.io/library/postgres:16-alpine');
  assert.deepEqual(config.services.app.networks, ['snakenet']);
  assert.deepEqual(config.services.db.networks, ['snakenet']);
  assert.ok(config.volumes.pgdata === null || typeof config.volumes.pgdata === 'object');
  for (const service of Object.values(config.services)) {
    assert.ok(!service.privileged);
    assert.ok(!(service.security_opt || []).includes('label=disable'));
  }
  assert.match(config.services.app.environment.SECRET_KEY_BASE, /\$\{SECRET_KEY_BASE:\?/);
  assert.match(await contents('Dockerfile'), /^USER rails$/m);
  assert.match(await contents('rails/bin/docker-entrypoint'), /pg_isready/);
});

test('bare-metal asset sync works when public/img is absent', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'snake-sync-without-images-'));
  try {
    await mkdir(path.join(dir, 'rails/bin'), { recursive: true });
    await mkdir(path.join(dir, 'public'));
    await cp(path.join(root, 'rails/bin/sync-assets'), path.join(dir, 'rails/bin/sync-assets'));
    for (const filename of ['game.js', 'app.js', 'profile.js', 'game.css', 'styles.css', 'violet-mist.svg']) {
      await cp(path.join(root, 'public', filename), path.join(dir, 'public', filename));
    }
    execFileSync('bash', [path.join(dir, 'rails/bin/sync-assets')], { cwd: dir });
    await access(path.join(dir, 'rails/public/profile.js'));
    await access(path.join(dir, 'rails/public/violet-mist.svg'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('both page templates keep the heading and document native Podman commands', async () => {
  for (const file of ['src/app/page.tsx', 'rails/app/views/snake/index.html.erb']) {
    const text = await contents(file);
    assert.match(text, /One container\. Two commands\. Yours\./);
    assert.match(text, /podman compose up --build -d/);
    assert.doesNotMatch(text, /\.\/snake|CONTAINER_ENGINE/);
    assert.match(text, /data:Z/);
    assert.match(text, /scoreboard/);
    assert.match(text, /controls-card/);
  }
});

// ---- Cloudflare Tunnel (optional profile) -----------------------------------
// The connector must be the OFFICIAL image, strictly opt-in via the Compose
// "tunnel" profile (read from .env as COMPOSE_PROFILES), fed its token through
// the documented TUNNEL_TOKEN variable, and must never weaken the default
// stack: a soft ${VAR:-} default, because Compose interpolates the whole file
// even for profile-disabled services — a :? guard here would break plain
// `compose up` for everyone not using the tunnel.
test('the Cloudflare Tunnel connector is official, opt-in and token-configured from .env', async () => {
  const source = await contents('compose.yaml');
  const config = yaml.load(source);
  const tunnel = config.services.cloudflared;
  assert.ok(tunnel, 'compose.yaml must define the cloudflared service');
  assert.equal(tunnel.image, 'docker.io/cloudflare/cloudflared:latest');
  assert.deepEqual(tunnel.profiles, ['tunnel'], 'disabled unless the tunnel profile is enabled');
  assert.equal(tunnel.command, 'tunnel --no-autoupdate run');
  assert.match(tunnel.environment.TUNNEL_TOKEN, /\$\{CLOUDFLARE_TUNNEL_TOKEN:-\}/,
    'token comes from .env via the documented TUNNEL_TOKEN variable');
  assert.doesNotMatch(source, /CLOUDFLARE_TUNNEL_TOKEN:\?/,
    'a hard :? guard would break non-tunnel startups during interpolation');
  assert.equal(tunnel.ports, undefined, 'the connector dials out; it never publishes a port');
  assert.deepEqual(tunnel.networks, ['snakenet'], 'reaches the app over the private network');
  assert.deepEqual(tunnel.depends_on, { app: { condition: 'service_healthy' } });
  assert.equal(tunnel.restart, 'unless-stopped');
  // Distroless image: the health probe must be the cloudflared binary itself.
  assert.deepEqual(tunnel.healthcheck.test,
    ['CMD', 'cloudflared', 'tunnel', '--metrics', '127.0.0.1:20241', 'ready']);
  assert.equal(tunnel.environment.TUNNEL_METRICS, '127.0.0.1:20241');
  // The app already understands proxy deployments; compose must pass the
  // knobs through so a tunnel setup is .env-only.
  assert.match(config.services.app.environment.MULTIPLAYER_PUBLIC_ORIGIN, /\$\{MULTIPLAYER_PUBLIC_ORIGIN:-\}/);
  assert.match(config.services.app.environment.ACTION_CABLE_ALLOWED_ORIGINS, /\$\{ACTION_CABLE_ALLOWED_ORIGINS:-\}/);
});

test('.env.example and the README document the tunnel switch, token and domain linking', async () => {
  const env = await contents('.env.example');
  for (const key of ['COMPOSE_PROFILES=', 'CLOUDFLARE_TUNNEL_TOKEN=', 'MULTIPLAYER_PUBLIC_ORIGIN=', 'ACTION_CABLE_ALLOWED_ORIGINS=']) {
    assert.ok(env.includes(key), `.env.example must document ${key}`);
  }
  const readme = await contents('README.md');
  assert.match(readme, /## Expose it with a Cloudflare Tunnel \(optional\)/);
  assert.match(readme, /COMPOSE_PROFILES=tunnel/);
  assert.match(readme, /CLOUDFLARE_TUNNEL_TOKEN=/);
  assert.match(readme, /Networks → Tunnels/, 'dashboard path for creating the tunnel');
  assert.match(readme, /Public Hostname/, 'domain linking happens on the tunnel page');
  assert.match(readme, /`app:3000`/, 'the service URL is the Compose service name, not localhost');
  assert.match(readme, /MULTIPLAYER_PUBLIC_ORIGIN=https:\/\/snake\.example\.com/);
  assert.match(readme, /podman-compose --profile tunnel up -d/, 'fallback for providers without COMPOSE_PROFILES');
  assert.match(readme, /BIND_ADDRESS=127\.0\.0\.1/, 'hardening note once the tunnel is the only entrance');
});
