import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LocalPredictor, PREDICTION_LIMITS, responsivePredictionEnabled } from '../public/multiplayer/prediction.js';

// The frames replayed here come from the real Ruby engine
// (tests/support/generate-prediction-trace.rb) through the unchanged Protocol v1
// encoder, so the client is checked against genuine authoritative output.
const trace = JSON.parse(readFileSync(new URL('./fixtures/prediction-trace.json', import.meta.url), 'utf8'));
const CFG = trace.config, TICK = CFG.tick_ms;
const scen = (name) => structuredClone(trace.scenarios.find((entry) => entry.name === name));
const frame = (t, overrides = {}) => ({
  v: 1, type: 'snapshot', m: 42, s: 'running', t, r: 'brawl', b: { c: CFG.columns, r: CFG.rows },
  f: [], q: [], p: [{ i: 1, n: 'You', c: '#00ff00', a: true, fr: false, b: [125, 124, 123],
    d: 'right', l: 3, sc: 0, is: 0, it: null, dq: [], gr: 0, sv: t, lg: 3, fz: 0, ...overrides }]
});
const make = () => {
  let at = 0;
  const local = new LocalPredictor({ clock: () => at, tickMs: TICK, columns: CFG.columns,
    rows: CFG.rows, ownParticipantId: 1 });
  local.enable('responsive');
  return { local, set: (v) => { at = v; } };
};
const dist = (a, b) => {
  const x = Math.abs((a % CFG.columns) - (b % CFG.columns));
  const y = Math.abs(Math.floor(a / CFG.columns) - Math.floor(b / CFG.columns));
  return Math.min(x, CFG.columns - x) + Math.min(y, CFG.rows - y);
};

test('the own snake is painted from confirmed cells only, at every latency', () => {
  for (const delay of [0, 100, 200, 300]) {
    const { local, set } = make();
    const scenario = scen(`latency_${delay}ms`);
    let now = 0, index = 0, painted = null, previous = null;
    const presses = (scenario.presses || []).map((press) => ({ ...press, done: false,
      at: press.client_tick * TICK + delay }));
    for (now = 0; now <= (scenario.frames.at(-1).t + 10) * TICK + delay; now += 5) {
      set(now);
      while (index < scenario.frames.length && scenario.frames[index].t * TICK + delay <= now) {
        const next = scenario.frames[index++];
        local.observe(next);
        if (!painted || next.t > painted.t) painted = next;
      }
      for (const press of presses) if (!press.done && press.at <= now) {
        press.done = true;
        assert.equal(local.submit(press.dir, press.seq).rejectedReason, null);
      }
      assert.equal(local.advance(now), 0, `${delay}ms: the client stepped the snake itself`);
      if (!painted) continue;
      const head = local.displayFrame(painted).p[0].b[0];
      if (previous !== null) assert.ok(dist(previous, head) <= 1, `${delay}ms: ${previous} -> ${head}`);
      previous = head;
    }
    assert.equal(local.summary().predictedTicks, 0, `${delay}ms: speculative movement ran`);
    assert.equal(local.summary().lead, 0, `${delay}ms: a local lead reappeared`);
  }
});

test('a pressed turn is sent at once but never paints an unconfirmed cell', () => {
  const { local, set } = make();
  local.observe(frame(0));
  const record = local.submit('down', 1);
  assert.equal(record.rejectedReason, null, 'the intent is accepted for sending');
  local.noteQueued(1);
  for (const at of [16, TICK, TICK * 3, TICK * 10]) {
    set(at);
    assert.equal(local.advance(at), 0);
    assert.equal(local.displayFrame(frame(0)).p[0].b[0], 125, `painted an unconfirmed cell at ${at}ms`);
  }
  local.observe(frame(1, { b: [149, 125, 124], d: 'down', is: 1, it: 1 }));
  assert.equal(local.displayFrame(frame(1)).p[0].b[0], 149, 'the confirmed turn is painted');
});

test('turn rules still mirror the engine: duplicate, reversal and queue depth', () => {
  const { local } = make();
  local.observe(frame(0));
  assert.equal(local.submit('right', 1).rejectedReason, 'duplicate_direction');
  assert.equal(local.submit('left', 2).rejectedReason, 'reversal');
  assert.equal(local.submit('nonsense', 3).rejectedReason, 'unknown_direction');
  assert.equal(local.submit('down', 4).rejectedReason, null);
  const depth = local.maxQueuedDirections;
  let accepted = 1;
  for (let seq = 5; seq < 5 + depth * 3; seq += 1) {
    if (!local.submit(['down', 'left', 'up', 'right'][seq % 4], seq).rejectedReason) accepted += 1;
  }
  assert.ok(local.summary().pending <= local.limits.maxPendingInputs, 'the buffer stays bounded');
  assert.ok(accepted >= 1 && accepted <= depth + 1, `accepted ${accepted} of a ${depth}-deep queue`);
});

test('authority stays with the server: no score, death or position is asserted', () => {
  const { local } = make();
  local.observe(frame(0));
  assert.equal(local.displayFrame(frame(0, { sc: 999 })).p[0].sc, 999, 'server score passes through');
  local.observe(frame(1, { a: false }));
  assert.equal(local.state().alive, false);
  assert.equal(local.advance(10_000), 0, 'nothing runs after elimination');
});

test('freeze and reconnection stop and restart cleanly', () => {
  const { local, set } = make();
  local.observe(frame(0));
  set(300);
  local.observe(frame(1, { fr: true }));
  assert.equal(local.advance(300), 0);
  local.reset('socket dropped', { reconnect: true });
  assert.equal(local.summary().pending, 0, 'obsolete inputs do not survive a gap');
  assert.equal(local.state(), null, 'nothing is trusted from before the gap');
  local.observe(frame(9, { b: [300, 299, 298] }));
  assert.equal(local.displayFrame(frame(9)).p[0].b[0], 300, 'restarts from the seed frame');
});

test('a rejected input is withdrawn and never painted', () => {
  const { local } = make();
  local.observe(frame(0));
  local.submit('down', 1);
  local.noteRejected(1, 'reversal');
  assert.equal(local.summary().pending, 0);
  assert.equal(local.displayFrame(frame(0)).p[0].b[0], 125);
});

test('an input_applied event is not treated as a confirming frame', () => {
  const { local } = make();
  local.observe(frame(0));
  local.submit('down', 1);
  local.noteApplied(1, 1);
  assert.equal(local.pending.length, 1, 'queued != applied; only a frame retires it');
  local.observe(frame(1, { b: [149, 125, 124], d: 'down', is: 1, it: 1 }));
  assert.equal(local.pending.length, 0);
});

test('Classic Brawl leaves the predictor completely inert', () => {
  const local = new LocalPredictor({ tickMs: TICK, columns: CFG.columns, rows: CFG.rows, ownParticipantId: 1 });
  const snapshot = frame(0);
  assert.equal(local.enabled, false);
  assert.equal(local.observe(snapshot, { applied: true }), false);
  assert.equal(local.submit('down', 1).rejectedReason, 'unavailable');
  assert.equal(local.advance(), 0);
  assert.equal(local.displayFrame(snapshot), snapshot, 'Classic paints the authoritative frame itself');
  assert.equal(local.summary().predictedTicks, 0);
});

test('Responsive is armed by the server; the test override is always labelled', () => {
  assert.deepEqual(responsivePredictionEnabled({ strategy: 'classic', search: '', storage: null }),
    { active: false, source: 'off', testOnly: false });
  const server = responsivePredictionEnabled({ strategy: 'responsive', search: '', storage: null });
  assert.equal(server.active, true);
  assert.equal(server.testOnly, false);
  const override = responsivePredictionEnabled({ strategy: 'classic',
    search: '?responsivePrediction=test', storage: null });
  assert.equal(override.active, true);
  assert.equal(override.testOnly, true, 'a URL flag can never claim a Classic match is Responsive');
});

test('prediction limits stay bounded', () => {
  assert.ok(PREDICTION_LIMITS.maxLeadTicks >= 1 && PREDICTION_LIMITS.maxLeadTicks <= 6);
  assert.ok(PREDICTION_LIMITS.maxPendingInputs >= 1);
  assert.ok(PREDICTION_LIMITS.maxCatchupTicks >= 1);
});
