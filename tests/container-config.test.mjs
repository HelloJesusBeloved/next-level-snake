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
    assert.match(await contents('public/styles.css'), /url\('violet-mist\.svg'\)/);
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
    assert.match(text, /score-stack/);
    assert.match(text, /controls-card/);
  }
});
