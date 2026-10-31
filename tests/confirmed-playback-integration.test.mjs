import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RemotePlayback } from '../public/multiplayer/playback.js';

const snapshot = (t, overrides = {}) => ({
  v: 1, type: 'snapshot', m: 42, s: 'running', t,
  b: { c: 24, r: 18 }, f: [], q: [],
  p: [{ i: 1, n: 'Player', c: '#00ff00', b: [125, 124, 123],
    d: 'right', l: 3, sc: 0, a: true, fr: false, is: 0, it: null,
    sv: 0, lg: 3, fz: 0, ...overrides }]
});
const compact = (t, overrides = {}) => ({
  v: 1, type: 'movement', m: 42, s: 'running', t, f: [],
  p: [{ i: 1, h: 125, d: 'right', l: 3, sc: 0, a: true, fr: true, is: 0, it: null, ...overrides }]
});
const setup = (first = snapshot(0, { fr: true })) => {
  const pb = new RemotePlayback({ tickMs: 105, columns: 24, rows: 18, clock: () => 0 });
  pb.enable('responsive');
  assert.ok(pb.pushSnapshot(first, 0));
  return pb;
};

test('compact frozen frames preserve the entire body until authoritative resume', () => {
  const pb = setup();
  for (let tick = 1; tick <= 15; tick++) {
    assert.equal(pb.pushMovement(compact(tick), tick * 105), true);
    assert.deepEqual(pb.newest().players.get(1).cells, [125, 124, 123]);
  }
  const resumed = snapshot(16, { b: [126, 125, 124], fr: false });
  assert.ok(pb.pushSnapshot(resumed, 16 * 105));
  assert.equal(pb.pushMovement(compact(17, { h: 127, fr: false }), 17 * 105), true);
  assert.deepEqual(pb.newest().players.get(1).cells, [127, 126, 125]);
});

test('duplicates and late frames do not trigger a false gap; real gaps request recovery', () => {
  const pb = setup(snapshot(0));
  assert.equal(pb.pushMovement(compact(1, { h: 126, fr: false }), 105), true);
  assert.equal(pb.pushMovement(compact(1, { h: 126, fr: false }), 110), false);
  assert.equal(pb.pushMovement(compact(0, { h: 125, fr: false }), 111), false);
  assert.ok(!pb.takeResyncRequest(), 'no resync is requested for a duplicate or late packet');
  assert.equal(pb.pushMovement(compact(4, { h: 129, fr: false }), 420), false);
  assert.ok(pb.takeResyncRequest(), 'a missing tick needs an authoritative snapshot');
  assert.ok(pb.pushSnapshot(snapshot(4, { b: [129, 128, 127] }), 420));
  assert.equal(pb.pushMovement(compact(5, { h: 130, fr: false }), 525), true);
  assert.deepEqual(pb.newest().players.get(1).cells, [130, 129, 128]);
});

test('materialized compact state preserves queued directions, growth, and identity', () => {
  const pb = setup(snapshot(0));
  const movement = compact(1, { h: 126, fr: false, dq: ['down', 'left'], gr: 2, is: 7, it: 1 });
  assert.equal(pb.pushMovement(movement, 105), true);
  const out = pb.materialize(movement, snapshot(0));
  assert.equal(out.t, 1);
  assert.deepEqual(out.p[0].b, [126, 125, 124]);
  assert.deepEqual(out.p[0].dq, ['down', 'left']);
  assert.equal(out.p[0].gr, 2);
  assert.equal(out.p[0].is, 7);
  assert.equal(out.p[0].c, '#00ff00');
});

test('an impossible compact jump fails closed and requests a full snapshot', () => {
  const pb = setup(snapshot(0));
  assert.equal(pb.pushMovement(compact(1, { h: 130, fr: false }), 105), false);
  assert.ok(pb.takeResyncRequest());
  assert.equal(pb.newest().tick, 0);
});
