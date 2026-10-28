import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GridCadence, MovementTimings } from '../public/multiplayer/grid-cadence.js';

const frame = (t, extras = {}) => ({ m: 1, t, s: 'running', ts: 10_000 + 105 * t, ...extras });

test('clean 105ms snapshots add no intentional hold and invent no frames', () => {
  const clock = new GridCadence();
  for (let t = 0; t < 100; t++) {
    const f = frame(t);
    clock.receive(f, t * 105);
    assert.equal(clock.take(t * 105), f, 'the exact received object is displayed');
    assert.equal(clock.take(t * 105 + 100), null, 'no client-generated movement');
    assert.equal(clock.waitMs, 0);
  }
});

test('the queue absorbs moderate jitter while keeping complete grid frames', () => {
  const clock = new GridCadence();
  const delays = [0, 38, 5, 52, 12, 26, 0, 44];
  const events = Array.from({length: 150}, (_, i) => ({ f: frame(i), at: i * 105 + delays[i % delays.length] }));
  let cursor = 0;
  const painted = [];
  let maxWait = 0;
  for (let at = 0; at < 16000; at += 5) {
    while (events[cursor]?.at <= at) {
      const e = events[cursor++]; clock.receive(e.f, e.at);
    }
    const f = clock.take(at);
    if (f) { painted.push({ tick: f.t, at }); maxWait = Math.max(maxWait, clock.waitMs); }
    assert.ok(clock.queue.length <= 3);
  }
  const steady = painted.slice(30);
  const errors = steady.slice(1).map((e, i) => Math.abs((e.at - steady[i].at) - 105));
  assert.ok(errors.reduce((a,b) => a+b,0) / errors.length < 8, 'spacing, not body interpolation');
  assert.ok(maxWait <= 55, '50ms bound + 5ms test display granularity');
  assert.equal(new Set(painted.map(e => e.tick)).size, painted.length);
  for (const p of painted) assert.ok(events.find(e => e.f.t === p.tick && e.at <= p.at));
});

test('a local turn or death/freeze/status transition discards any held history', () => {
  const clock = new GridCadence();
  clock.receive(frame(1), 0);
  clock.take(0);
  // A received frame deliberately held to a future nominal slot.
  clock.receive(frame(2), 50);
  const important = frame(3, { s: 'completed' });
  clock.receive(important, 60, true);
  assert.equal(clock.take(60), important);
  assert.equal(clock.take(999), null);
  assert.equal(clock.phase, 0);
});

test('ordered TCP catch-up bursts paint only the newest already-received frame', () => {
  const clock = new GridCadence();
  clock.receive(frame(1), 0); clock.take(0);
  clock.receive(frame(2), 330);
  clock.receive(frame(3), 331);
  const latest = frame(4);
  clock.receive(latest, 332);
  assert.equal(clock.take(333), latest);
  assert.equal(clock.pending, false, 'no delayed trail after a stall');
  assert.ok(clock.coalesced >= 2);
});

test('a tick gap is never filled by extrapolation', () => {
  const clock = new GridCadence();
  clock.receive(frame(1), 0); clock.take(0);
  const next = frame(5);
  clock.receive(next, 420);
  assert.equal(clock.take(420), next);
  assert.equal(clock.take(525), null);
});

test('old/reordered packets can never move a snake backwards', () => {
  const clock = new GridCadence();
  clock.receive(frame(8), 0); clock.take(0);
  assert.equal(clock.receive(frame(6), 5), false);
  assert.equal(clock.take(100), null);
});

test('same-tick authoritative changes are allowed without moving the tick', () => {
  const clock = new GridCadence();
  clock.receive(frame(8), 0); clock.take(0);
  const frozen = frame(8, { fr: true });
  clock.receive(frozen, 8, true);
  assert.equal(clock.take(8), frozen);
});

test('reset, rematch, and disabled pacing retain no stale queued state', () => {
  const clock = new GridCadence();
  clock.receive(frame(50), 0); clock.take(0);
  clock.receive(frame(51), 50);
  clock.reset();
  assert.equal(clock.pending, false);
  const newRound = frame(0, { m: 2 });
  clock.receive(newRound, 100);
  assert.equal(clock.take(100), newRound);
  clock.configure({ enabled: false });
  const immediate = frame(1, { m: 2 });
  clock.receive(immediate, 101);
  assert.equal(clock.take(101), immediate);
});

test('fast presets cap hold at half a tick, not an entire movement step', () => {
  for (const tickMs of [42, 60, 80, 105, 165]) {
    const clock = new GridCadence({ tickMs });
    assert.equal(clock.maxWait, Math.min(50, tickMs / 2));
  }
});

test('diagnostics distinguish server timing from delivery variation with bounded storage', () => {
  const d = new MovementTimings(10);
  for (let i = 0; i < 30; i++) {
    d.receive(frame(i), i * 105 + (i % 2 ? 40 : 0));
    d.draw(0.4, 6);
  }
  const report = d.summary();
  assert.equal(report.serverTickMs.p95, 105);
  assert.equal(report.deliveryVariationMs.p95, 40);
  assert.equal(report.drawCostMs.max, 0.4);
  assert.equal(report.receiveToPaintMs.max, 6);
  assert.equal(d.arrivalMs.length, 10);
  assert.equal(report.skippedServerTicks, 0);
});

import { FrameGate } from '../public/multiplayer/grid-cadence.js';
function gateHarness() {
  let raf, timer, id = 0, writes = 0;
  const gate = new FrameGate({
    request: (cb) => { raf = cb; return ++id; }, cancel: () => { raf = null; },
    later: (cb, ms) => { assert.equal(ms, 32); timer = cb; return ++id; }, clear: () => { timer = null; },
  });
  return { gate, schedule: () => gate.schedule(() => writes++), raf: () => raf?.(), timer: () => timer?.(), get writes() { return writes; } };
}

test('normal display callback cancels the watchdog without double-painting', () => {
  const h = gateHarness();
  h.schedule(); h.schedule();
  h.raf(); h.timer();
  assert.equal(h.writes, 1);
  assert.equal(h.gate.fallbacks, 0);
  assert.equal(h.gate.pending, false);
});

test('a delayed WebKit display callback cannot hold a received board indefinitely', () => {
  const h = gateHarness();
  h.schedule();
  h.timer(); h.raf();
  assert.equal(h.writes, 1);
  assert.equal(h.gate.fallbacks, 1);
});

test('disconnect/teardown cancels both display paths', () => {
  const h = gateHarness();
  h.schedule(); h.gate.cancel();
  h.timer(); h.raf();
  assert.equal(h.writes, 0);
  assert.equal(h.gate.pending, false);
});


// Replay real captured receive times at simulated display rates. This is not
// a claim of physical 30/60/120/144Hz device certification.
import { readFileSync } from 'node:fs';
const traces = JSON.parse(readFileSync(new URL('./fixtures/mobile-arrival-traces.json', import.meta.url)));
function replay(events, hz, enabled) {
  const cadence = new GridCadence({ enabled });
  const shown = [];
  let cursor = 0;
  for (let at = 0; at <= events.at(-1).at + 150; at += 1000 / hz) {
    while (events[cursor]?.at <= at) {
      const received = events[cursor++];
      cadence.receive(frame(received.tick), received.at);
    }
    const view = cadence.take(at);
    if (view) {
      const source = events.find(e => e.tick === view.t);
      assert.ok(source && source.at <= at, 'no frame from the future');
      assert.ok(at - source.at <= cadence.maxWait + 1000 / hz + .01, 'bounded hold + one simulated refresh');
      shown.push({ at, tick: view.t });
    }
  }
  assert.deepEqual(shown.map(e => e.tick), [...new Set(shown.map(e => e.tick))].sort((a,b)=>a-b));
  const errors = shown.slice(1).map((e,i) => Math.abs((e.at-shown[i].at)-105));
  return errors.reduce((a,b)=>a+b,0) / errors.length;
}
for (const hz of [30, 60, 120, 144]) {
  test(`captured Wi-Fi trace at ${hz}Hz improves spacing without inventing positions`, () => {
    const immediate = replay(traces.samples.wifi, hz, false);
    const paced = replay(traces.samples.wifi, hz, true);
    assert.ok(paced < immediate * .75, `mean cadence error ${immediate.toFixed(1)} -> ${paced.toFixed(1)}ms`);
  });
  test(`captured clean trace at ${hz}Hz does not acquire a permanent buffer`, () => {
    const immediate = replay(traces.samples.clean, hz, false);
    const paced = replay(traces.samples.clean, hz, true);
    assert.ok(paced <= immediate + 3, `clean-link error ${immediate} vs ${paced}`);
  });
}


test('cacheable multiplayer entry points and modified dependency imports carry the new release', () => {
  const root = new URL('../', import.meta.url);
  const read = (path) => readFileSync(new URL(path, root), 'utf8');
  const release = 'step10-mobile3';
  const view = read('rails/app/views/snake/multiplayer.html.erb');
  assert.ok(view.includes(`/multiplayer/page.js?v=${release}`));
  assert.ok(view.includes(`/multiplayer/lobby.css?v=${release}`));
  assert.ok(read('public/multiplayer/page.js').includes(`./lobby.js?v=${release}`));
  assert.ok(read('public/multiplayer/lobby.js').includes(`./game-renderer.js?v=${release}`));
  assert.ok(read('public/multiplayer/game-renderer.js').includes(`./grid-cadence.js?v=${release}`));
  assert.ok(read('public/multiplayer/lobby.js').includes(`./snapshot-chunks.js?v=${release}`));
});
