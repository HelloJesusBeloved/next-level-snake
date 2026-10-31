import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// The multiplayer page busts caches with `?v=` tags on every module reference,
// and nothing else: Rails serves public/ without Cache-Control, and Cloudflare
// caches .js/.css at the edge by URL. A module that changed while its tag did
// not is served stale for hours — which is how a fixed lobby.js can keep showing
// a disabled Start button. These checks make a partial bump impossible to miss.
const root = new URL('../', import.meta.url).pathname;
const dir = join(root, 'public/multiplayer');
const erb = readFileSync(join(root, 'rails/app/views/snake/multiplayer.html.erb'), 'utf8');
const modules = readdirSync(dir).filter((name) => name.endsWith('.js'));
const references = new Map(); // file -> Set of tags
const record = (file, tag, from) => {
  if (!references.has(file)) references.set(file, new Map());
  references.get(file).set(from, tag);
};
for (const match of erb.matchAll(/\/multiplayer\/([a-z0-9.-]+\.(?:js|css))\?v=([A-Za-z0-9.-]+)/g)) record(match[1], match[2], 'multiplayer.html.erb');
for (const name of modules) {
  const source = readFileSync(join(dir, name), 'utf8');
  for (const match of source.matchAll(/from '\.\/([a-z0-9.-]+\.js)(\?v=([A-Za-z0-9.-]+))?'/g)) {
    record(match[1], match[3] || null, name);
  }
}

test('every local module import carries a cache-busting tag', () => {
  const untagged = [];
  for (const [file, byImporter] of references) {
    if (file === 'actioncable.esm.js') continue; // vendored, never edited
    for (const [from, tag] of byImporter) if (!tag) untagged.push(`${from} -> ${file}`);
  }
  assert.deepEqual(untagged, []);
});

test('all references to one module agree on its tag (no half-bumped import graph)', () => {
  const disagreements = [];
  for (const [file, byImporter] of references) {
    const tags = new Set([...byImporter.values()].filter(Boolean));
    if (tags.size > 1) disagreements.push(`${file}: ${[...byImporter].map(([from, tag]) => `${from}=${tag}`).join(', ')}`);
  }
  assert.deepEqual(disagreements, []);
});

test('the entry points the page loads are tagged with the current release', () => {
  const page = references.get('page.js')?.get('multiplayer.html.erb');
  const css = references.get('lobby.css')?.get('multiplayer.html.erb');
  const lobby = references.get('lobby.js')?.get('page.js');
  assert.ok(page && css && lobby, 'page.js, lobby.css and lobby.js must be referenced with tags');
  // Anything that changed in the Responsive Brawl work must not be served under
  // a step-10 tag: that URL is what every browser and edge cache already holds.
  for (const [file, byImporter] of references) {
    for (const [from, tag] of byImporter) {
      if (['lobby.js', 'game-renderer.js', 'configuration.js', 'prediction.js', 'playback.js', 'page.js', 'lobby.css'].includes(file)) {
        assert.ok(!/^step10-/.test(tag || ''), `${from} still loads ${file} under the pre-Responsive tag ${tag}`);
      }
    }
  }
});

test('select options stay short enough for a phone', () => {
  // A <select> is sized by its longest option in several mobile engines, and a
  // long option is wider than a 320 px screen: the page then zooms out to fit.
  for (const match of erb.matchAll(/<option[^>]*>([^<]*)<\/option>/g)) {
    assert.ok(match[1].trim().length <= 28, `option label too long for mobile: "${match[1].trim()}"`);
  }
});
