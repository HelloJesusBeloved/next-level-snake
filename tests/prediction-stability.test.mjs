import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalPredictor } from '../public/multiplayer/prediction.js';

const COLS = 24, ROWS = 18, TICK = 100;
const frame = (t, overrides = {}) => ({
  v: 1, type: 'snapshot', m: 42, s: 'running', t, r: 'brawl',
  b: { c: COLS, r: ROWS }, f: [], q: [],
  p: [{ i: 1, n: 'You', c: '#00ff00', a: true, fr: false,
        b: [125, 124, 123], d: 'right', l: 3, sc: 0, is: 0,
        it: null, dq: [], gr: 0, ...overrides }]
});
const make = () => {
  let at = 0;
  const local = new LocalPredictor({ clock: () => at, tickMs: TICK,
    columns: COLS, rows: ROWS, ownParticipantId: 1, growth: 1 });
  local.enable('responsive');
  return { local, set: ms => { at = ms; }, now: () => at };
};
const distance = (a, b) => {
  const x = Math.abs((a % COLS) - (b % COLS));
  const y = Math.abs(Math.floor(a / COLS) - Math.floor(b / COLS));
  return Math.min(x, COLS - x) + Math.min(y, ROWS - y);
};

test('applied event does not discard a turn before a confirming frame', () => {
  const { local } = make();
  local.observe(frame(0));
  const turn = local.submit('down', 1);
  assert.equal(turn.rejectedReason, null);
  local.noteQueued(1);
  local.noteApplied(1, 1);
  assert.equal(local.pending.length, 1, 'applied-to-queue event is not an authoritative state');
  assert.equal(local.confirmed.appliedSeq, 0, 'event must not rewrite the confirmed frame');
  local.observe(frame(0));
  assert.equal(local.pending.length, 1, 'a pre-turn snapshot cannot erase the turn');
  local.observe(frame(1, { b: [149, 125, 124], d: 'down', is: 1, it: 1 }));
  assert.equal(local.pending.length, 0, 'frame with applied sequence retires the input');
});

test('two accepted turns in one server tick preserve the remaining server queue', () => {
  const { local } = make();
  local.observe(frame(0));
  local.submit('down', 1);
  local.submit('left', 2);
  local.noteApplied(1, 1);
  local.noteApplied(2, 1); // server accepted both into its queue, not both moved
  local.observe(frame(1, { b: [149, 125, 124], d: 'down', is: 2, it: 1, dq: ['left'] }));
  assert.equal(local.pending.length, 0);
  assert.equal(local.runTick(), true);
  assert.equal(local.state().direction, 'left');
  assert.deepEqual(local.state().body, [148, 149, 125], 'the second turn must not disappear');
});

test('large RTT estimates never create a multi-cell jump in one animation frame', () => {
  const { local, set } = make();
  local.observe(frame(0));
  local.setLeadTargetMs(600);
  let previous = local.state().body[0];
  assert.equal(local.advance(0), 0);
  assert.equal(local.state().body[0], previous);
  for (const time of [16, 32, 50, 99, 100, 200, 500, 1000]) {
    set(time);
    const moved = local.advance(time);
    const head = local.state().body[0];
    assert.ok(moved <= 1, `executed ${moved} movement ticks in one paint`);
    assert.ok(distance(previous, head) <= 1, `head jumped ${previous} -> ${head}`);
    previous = head;
  }
});

test('growth is one body segment per tick, with no duplicated tail', () => {
  const { local } = make();
  local.observe(frame(0, { gr: 2 }));
  local.runTick();
  assert.deepEqual(local.state().body, [126, 125, 124, 123]);
  local.runTick();
  assert.deepEqual(local.state().body, [127, 126, 125, 124, 123]);
  local.runTick();
  assert.deepEqual(local.state().body, [128, 127, 126, 125, 124]);
});

test('known food grows the same tick and only by the authoritative growth amount', () => {
  const { local } = make();
  const snapshot = frame(0);
  snapshot.f = [{ c: 126, o: 1 }];
  local.observe(snapshot);
  local.runTick();
  assert.deepEqual(local.state().body, [126, 125, 124, 123]);
  local.runTick();
  assert.deepEqual(local.state().body, [127, 126, 125, 124]);
  assert.equal(local.state().score, 0, 'score is never predicted');
});

test('reset clears sequence and timing state for a new match', () => {
  const { local } = make();
  local.observe(frame(0));
  local.submit('down', 50);
  local.reset('new match', { reconnect: true });
  local.observe({ ...frame(0), m: 43 });
  assert.equal(local.submit('down', 1).rejectedReason, null);
  assert.equal(local.summary().confirmedTick, 0);
});

test('predicted own head never inherits remote playback coordinates', () => {
  const { local } = make();
  local.observe(frame(0));
  local.runTick();
  const input = frame(0, { bp: new Float32Array([1, 1]), points: [[1, 1]] });
  input.p.push({ i: 2, b: [200, 199], bp: new Float32Array([8, 8]) });
  const display = local.displayFrame(input);
  assert.equal(display.p[0].b[0], local.state().body[0]);
  assert.equal(display.p[0].bp, undefined, 'stale interpolation coordinates must not detach the head ring');
  assert.equal(display.p[1], input.p[1], 'remote state is not modified by local prediction');
});

test('late authoritative corrections never make the rendered head skip cells', async () => {
  const { readFileSync } = await import('node:fs');
  const trace = JSON.parse(readFileSync(new URL('./fixtures/prediction-trace.json', import.meta.url), 'utf8'));
  const tickMs = trace.config.tick_ms;
  for (const delay of [0, 100, 200, 300]) {
    const scenario = structuredClone(trace.scenarios.find((item) => item.name === `latency_${delay}ms`));
    let now = 0, frameIndex = 0, lastHead = null, rendered = null;
    const local = new LocalPredictor({ clock: () => now, tickMs, columns: COLS, rows: ROWS, ownParticipantId: 1 });
    local.enable('responsive');
    local.setLeadTargetMs(delay * 2);
    const presses = scenario.presses.map((item) => ({ ...item, done: false,
      time: item.client_tick * tickMs + delay + (item.press_phase || 0) * tickMs }));
    const finish = (scenario.frames.at(-1).t + 30) * tickMs + delay;
    for (now = 0; now <= finish; now += 5) {
      while (frameIndex < scenario.frames.length && scenario.frames[frameIndex].t * tickMs + delay <= now) {
        const next = scenario.frames[frameIndex++];
        for (const applied of scenario.applied) {
          if (!applied.sent && applied.seq <= (next.p[0].is || 0)) {
            applied.sent = true;
            local.noteApplied(applied.seq, applied.tick);
          }
        }
        local.observe(next);
        rendered = next;
      }
      for (const press of presses) if (!press.done && press.time <= now) {
        press.done = true;
        local.submit(press.dir, press.seq);
      }
      local.advance(now);
      if (!rendered || !local.active) continue;
      const player = local.displayFrame(rendered).p[0];
      const head = player.b[0];
      if (lastHead !== null) assert.ok(distance(lastHead, head) <= 1,
        `${delay}ms: visible head skipped from ${lastHead} to ${head} at ${now}ms`);
      for (let part = 1; part < player.b.length; part++) {
        assert.ok(distance(player.b[part - 1], player.b[part]) <= 1,
          `${delay}ms: visual body broke apart at segment ${part}`);
      }
      lastHead = head;
    }
    assert.equal(lastHead, local.state().body[0], `${delay}ms: visual correction failed to converge`);
  }
});

test('a burst of confirmed updates is painted at a bounded grid cadence', () => {
  const { local, set } = make();
  const seed = frame(0);
  local.observe(seed);
  assert.equal(local.displayFrame(seed).p[0].b[0], 125);
  set(16); local.runTick();
  assert.equal(local.displayFrame(seed).p[0].b[0], 125, 'do not sprint on the first burst packet');
  set(32); local.runTick();
  assert.equal(local.displayFrame(seed).p[0].b[0], 125, 'do not paint two cells in one refresh');
  set(70);
  assert.equal(local.displayFrame(seed).p[0].b[0], 126);
  set(140);
  assert.equal(local.displayFrame(seed).p[0].b[0], 127);
});

test('disabling and re-enabling never paints a prior match body', () => {
  const { local } = make();
  const first = frame(0);
  local.observe(first);
  local.displayFrame(first);
  local.disable('classic');
  local.enable('responsive');
  const next = { ...frame(0, { b: [220, 219, 218] }), m: 43 };
  local.observe(next);
  assert.equal(local.displayFrame(next).p[0].b[0], 220);
});

test('jitter, duplicates, dropped ticks and outages keep the displayed snake connected', () => {
  const { local, set } = make();
  local.setLeadTargetMs(200);
  const updates = [];
  for (let tick = 0; tick <= 12; tick++) {
    if (tick === 7) continue; // missed snapshot
    const delay = tick === 3 ? 250 : tick % 2 ? 20 : 70; // tick 3 arrives late
    updates.push({ at: tick * TICK + delay, value: frame(tick, {
      b: [125 + tick, 124 + tick, 123 + tick], is: 0, dq: [], gr: 0
    }) });
  }
  updates.push({ ...updates[4], at: updates[4].at + 10 }); // duplicate
  updates.sort((a, b) => a.at - b.at);
  let next = 0, painted = null, priorHead = null;
  for (let at = 0; at <= 3_000; at += 5) {
    set(at);
    while (next < updates.length && updates[next].at <= at) {
      const incoming = updates[next++].value;
      local.observe(incoming);
      if (!painted || incoming.t > painted.t) painted = incoming;
    }
    local.advance(at);
    if (!painted || !local.active) continue;
    const own = local.displayFrame(painted).p[0];
    if (priorHead !== null) assert.ok(distance(priorHead, own.b[0]) <= 1);
    for (let i = 1; i < own.b.length; i++) assert.ok(distance(own.b[i - 1], own.b[i]) <= 1);
    priorHead = own.b[0];
  }
  assert.ok(local.summary().staleFrames > 0, 'late frames are ignored');
  assert.ok(local.summary().lead <= local.summary().limits.maxLeadTicks, 'outage does not run away');
  assert.equal(priorHead, local.state().body[0], 'the visual path settles');
});
