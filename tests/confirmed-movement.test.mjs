import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RemotePlayback } from '../public/multiplayer/playback.js';
const pb = new RemotePlayback({ columns: 24, rows: 18 });

const old = { cells: [125, 124, 123] };
const body = (entry, before = old) => pb.reconstructConfirmedBody(entry, before);

test('straight movement and growth reconstruct exact authoritative bodies', () => {
  assert.deepEqual(body({ h: 126, l: 3, a: true, fr: false }), [126, 125, 124]);
  assert.deepEqual(body({ h: 126, l: 4, a: true, fr: false }), [126, 125, 124, 123]);
});

test('a frozen or eliminated player holds every segment, across many ticks', () => {
  let before = old;
  for (let tick = 0; tick < 50; tick++) {
    const next = body({ h: 125, l: 3, a: true, fr: true }, before);
    assert.deepEqual(next, old.cells);
    before = { cells: next };
  }
  assert.deepEqual(body({ h: 125, l: 3, a: false, fr: false }), old.cells);
  assert.deepEqual(body({ h: 126, l: 3, a: true, fr: false }, before), [126, 125, 124]);
});

test('edge wraps remain a single legal step, never a screen-wide flight', () => {
  assert.deepEqual(body({ h: 120, l: 3, a: true }, { cells: [143, 142, 141] }), [120, 143, 142]);
  assert.deepEqual(body({ h: 5, l: 3, a: true }, { cells: [413, 389, 365] }), [5, 413, 389]);
});

test('a gap, impossible stationary transition or malformed frame requires a full resync', () => {
  assert.equal(body({ h: 128, l: 3, a: true }), null);
  assert.equal(body({ h: 150, l: 3, a: true }), null); // diagonal
  assert.equal(body({ h: 126, l: 3, a: true, fr: true }), null);
  assert.equal(body({ h: 125, l: 3, a: true, fr: false }), null);
  assert.equal(body({ h: 126, l: 5, a: true }), null);
  assert.equal(body({ h: 126, l: 2, a: true }), null);
  assert.equal(body({ h: 99999, l: 3, a: true }), null);
  assert.equal(pb.reconstructConfirmedBody({ h: 1, l: 3 }, null), null);
});
