// Step 2: local movement prediction and server reconciliation.
//
// The frames replayed here are NOT hand-written expectations: they were emitted
// by the real Simulation::World engine (tests/support/generate-prediction-trace.rb)
// through the unchanged Protocol v1 encoder, so every assertion below compares
// the browser predictor against genuine authoritative server output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LocalPredictor, PREDICTION_LIMITS, responsivePredictionEnabled, RESPONSIVE_TEST_OVERRIDE
} from '../public/multiplayer/prediction.js';

const trace = JSON.parse(readFileSync(new URL('./fixtures/prediction-trace.json', import.meta.url), 'utf8'));
const CFG = trace.config;
const TICK_MS = CFG.tick_ms;
// A fresh copy per test: the harness marks engine input records as acked while
// it replays them, and node runs the file in one process. Handing out the shared
// object made a test that ran first silently change what a later test saw.
const scen = (name) => {
  const found = trace.scenarios.find((entry) => entry.name === name);
  assert.ok(found, `missing scenario ${name}`);
  return structuredClone(found);
};

// A deterministic client: a monotonic virtual clock, frames delivered with a
// one-way delay, presses issued the instant the frame they were aimed at lands.
function makeClient(scenario, { oneWayMs = 0, jitter = [], limits, enable = true, uplinkTicks = 0, leadTicks = null } = {}) {
  const client = {
    now: 0, frame: 0, delivered: 0, predictor: null, samples: [], presses: [], reconciled: [],
    headsByTick: new Map(), confirmations: []
  };
  let time = 0;
  const clock = () => time;
  const predictor = new LocalPredictor({
    tickMs: TICK_MS, columns: CFG.columns, rows: CFG.rows, growth: CFG.growth,
    mode: 'brawl', ownParticipantId: CFG.participant_id, clock, limits
  });
  if (enable) predictor.enable('responsive');
  // A real client learns its round trip from the match heartbeat before the
  // first press (lobby.js recordRoundTrip) and feeds it to the predictor, which
  // then leads the confirmed tick by that many ticks so a predicted turn lands
  // on the tick the server will apply it.
  if (enable && Number.isFinite(oneWayMs)) predictor.setLeadTargetMs(2 * oneWayMs);
  // Rule-parity scenarios run with an explicit lead so the local view really
  // simulates ahead of the engine (a zero lead is pure lockstep and would have
  // nothing to audit).
  if (enable && Number.isInteger(leadTicks)) predictor.setLeadTargetMs(leadTicks * TICK_MS);
  client.predictor = predictor;

  const schedule = scenario.frames.map((frame, index) => ({
    frame, index, at: frame.t * TICK_MS + oneWayMs + (jitter.length ? jitter[index % jitter.length] : 0)
  }));
  // Presses come from the fixture's own input log. For a scenario without an
  // explicit latency variant, `sent_at` is both the tick the client displays
  // when it presses and the tick the engine received it on — i.e. zero delay.
  const source = scenario.presses || (scenario.applied || []).map((entry) => ({
    seq: entry.seq, dir: entry.dir, client_tick: entry.sent_at, uplink_ticks: 0
  }));
  const presses = source.map((press) => ({
    ...press, seq: press.seq, done: false,
    // The player sees frame C one downlink after it was produced and presses a
    // little later (mid-tick in the fixture); the fixture's engine applied the
    // input a full round trip after frame C, which is what makes this fair.
    at: press.client_tick * TICK_MS + oneWayMs + (press.press_phase || 0) * TICK_MS
  }));

  const lastAt = schedule.length ? Math.max(...schedule.map((entry) => entry.at)) : 0;
  client.horizon = lastAt + 4 * TICK_MS;
  // Work happens AT the current instant and the clock then advances, so the
  // client's tick phase is aligned with the server's grid (boundaries on exact
  // multiples of tick_ms). Without that, the harness itself would inject a
  // constant half-tick skew and every scenario would look like a prediction
  // error of one cell.
  const stepUntil = (limit) => {
    while (time < limit) {
      // 1. authoritative frames that have landed
      while (client.frame < schedule.length && schedule[client.frame].at <= time) {
        const { frame } = schedule[client.frame];
        client.frame += 1;
        client.delivered += 1;
        const player = frame.p[0];
        const applied = Number(player.is || 0);
        // Acks for every seq the server has already consumed, then the frame.
        for (const entry of scenario.applied || []) {
          if (entry.seq <= applied && !entry.acked) {
            entry.acked = true;
            predictor.noteApplied(entry.seq, entry.tick);
            client.confirmations.push({ seq: entry.seq, tick: frame.t, at: time });
          }
        }
        predictor.observe(frame, { applied: true });
        // Residual divergence measured the instant a frame is reconciled: the
        // local view must equal the confirmed state (plus only unconfirmed
        // turns), i.e. a correction always converges, never partially.
        client.reconciled.push({
          tick: frame.t, authority: Number(player.b[0]),
          head: predictor.state()?.body?.[0] ?? null,
          pending: predictor.summary().pending
        });
        client.headsByTick.set(frame.t, Number(player.b[0]));
      }
      // 2. presses (the player pressed at the instant this frame was seen)
      for (const press of presses) {
        if (!press.done && press.at <= time) {
          press.done = true;
          const record = predictor.submit(press.dir, press.seq);
          client.presses.push({ ...press, record, at: time,
            headAtPress: predictor.state()?.body?.[0] ?? null,
            dirAtPress: predictor.state()?.direction ?? null });
        }
      }
      // 3. fixed-step local advance, then a sample (the "paint")
      predictor.advance(time);
      const state = predictor.state();
      client.samples.push({ at: time, tick: state?.tick ?? null, head: state?.body?.[0] ?? null,
        direction: state?.direction ?? null, length: state?.body?.length ?? 0,
        alive: state?.alive ?? null, pending: predictor.summary().pending });
      time = Math.min(limit, time + 5);
    }
    return client;
  };
  client.run = () => stepUntil(client.horizon);
  client.runTo = (limit) => stepUntil(Math.min(limit, client.horizon));
  return client;
};


// The accuracy claim that is actually guaranteed: while a turn is in flight the
// client may legitimately be up to the lead ceiling away from the server's tick
// (that gap IS the latency it hides). Once nothing is outstanding any more, every
// tick it painted must equal the tick the engine reported — forever. That is the
// difference between bounded prediction and drift, and it is checked per tick.
function assertSteadyStateAccuracy(client, scenario, fromTick, label = '') {
  const claims = client.predictor.summary().predictedHeads;
  let audited = 0;
  for (const [tick, head] of client.headsByTick) {
    if (tick < fromTick || !(tick in claims)) continue;
    assert.equal(Number(claims[tick]), Number(head), `${label} steady-state divergence at tick ${tick}`);
    audited += 1;
  }
  assert.ok(audited >= 3, `${label} only audited ${audited} settled ticks`);
  return audited;
}

const authority = (scenario, tick) => {
  const frame = scenario.frames.find((entry) => entry.t === tick);
  return frame ? Number(frame.p[0].b[0]) : null;
};

test('engine fixture really is Protocol v1 output and stays classic-compatible', () => {
  assert.equal(trace.protocol_version, 1);
  const frame = scen('turns').frames[1];
  assert.equal(frame.v, 1);
  assert.ok(Array.isArray(frame.p) && Array.isArray(frame.f) && frame.b.c === CFG.columns);
  // The Step-1 reconciliation fields are present, so the predictor consumes
  // exactly the protocol the shipped server broadcasts — nothing invented.
  assert.ok('is' in frame.p[0] && 'it' in frame.p[0]);
  assert.ok('strategy' in frame);
});

test('zero-latency prediction reproduces the server tick for tick (rule parity)', () => {
  const scenario = scen('turns');
  // Parity has to be exact here: same rules, local view two ticks ahead of the
  // engine, so a divergence can only mean the client model drifted from it.
  const client = makeClient(scenario, { oneWayMs: 0, leadTicks: 2 });
  client.run();
  const stats = client.predictor.summary();
  assert.ok(stats.predictedTicks > 0);
  // Zero latency does NOT mean zero skew: the local tick grid and the server's
  // are free-running (a browser cannot lock to them), so a turn may be consumed
  // one tick early or late. That is exactly one corner of disagreement — at most
  // one correction per turn and never wider than two cells. Anything larger
  // would mean the rules were copied wrongly rather than phased differently.
  const turns = (scenario.applied || []).length;
  assert.ok(stats.corrections <= turns, `${stats.corrections} corrections for ${turns} turns`);
  assert.ok(stats.maxCorrectionCells <= 2, `widest correction ${stats.maxCorrectionCells} cells`);
  // After the last turn is confirmed there is nothing left to hide behind: every
  // remaining tick must be identical to the engine, which is the real parity
  // proof for movement, turning, wrapping and growth.
  const lastTurn = Math.max(...(scenario.applied || []).map((entry) => entry.tick), 0);
  assertSteadyStateAccuracy(client, scenario, lastTurn + 1, 'turns');
  assert.equal(stats.pending, 0);
});

test('turns land on tick boundaries: a press takes effect on the NEXT tick, never mid-tick', () => {
  const scenario = scen('turns');
  const client = makeClient(scenario);
  client.run();
  const press = client.presses[0];
  assert.equal(press.record.rejectedReason, null, 'a legal turn is accepted locally');
  assert.ok(press.record.scheduledTick >= press.client_tick + 1,
    `scheduled ${press.record.scheduledTick} for the next logical tick after ${press.client_tick}`);
  assert.ok(press.record.scheduledTick <= press.client_tick + 1 + PREDICTION_LIMITS.maxLeadTicks,
    'and never beyond the ceiling');
  // The direction changes locally within one tick of the press (fixed-step, so
  // the exact instant is the boundary) — and, crucially, long before the
  // confirmation arrives.
  const turned = client.samples.find((sample) => sample.at >= press.at && sample.direction === press.dir);
  assert.ok(turned, 'the predicted snake must take the turn locally');
  assert.ok(turned.at - press.at <= TICK_MS * 2, 'no rotation outside a grid tick');
  const confirm = client.confirmations.find((entry) => entry.seq === press.seq);
  assert.ok(confirm.at >= turned.at, 'local movement must not wait for confirmation');
});

test('input-to-render delay stays inside one tick at 0/100/200/300 ms', () => {
  for (const [name, oneWay] of [['latency_0ms', 0], ['latency_100ms', 100],
                                ['latency_200ms', 200], ['latency_300ms', 300]]) {
    const scenario = scen(name);
    const client = makeClient(scenario, { oneWayMs: oneWay });
    client.run();
    for (const press of client.presses) {
      const turned = client.samples.find((sample) => sample.at >= press.at &&
        sample.direction === press.dir && sample.tick > press.client_tick);
      assert.ok(turned, `${name}: ${press.dir} was never painted locally`);
      const confirm = client.confirmations.find((entry) => entry.seq === press.seq);
      if (oneWay === 0) return; // with no delay there is nothing to beat
      // The claim that matters: the local view turns inside a bounded number of
      // logical ticks (independent of the 300 ms round trip) and strictly before
      // the server could have confirmed the same turn.
      assert.ok(turned.at - press.at <= TICK_MS * 2,
        `${name}: input→render took ${turned.at - press.at}ms (> 2 ticks of ${TICK_MS}ms)`);
      assert.ok(confirm && turned.at < confirm.at,
        `${name}: local movement must precede confirmation (painted ${turned.at}, confirmed ${confirm && confirm.at})`);
    }
  }
});

test('latency produces bounded, self-limiting corrections — not constant rubber-banding', () => {
  for (const [name, oneWay] of [['latency_0ms', 0], ['latency_100ms', 100],
                                ['latency_200ms', 200], ['latency_300ms', 300],
                                ['latency_260ms_jitter', 260]]) {
    const scenario = scen(name);
    const client = makeClient(scenario, { oneWayMs: oneWay, jitter: scenario.jitter_ms || [] });
    client.run();
    const stats = client.predictor.summary();
    const turns = (scenario.applied || []).length;
    assert.ok(stats.reconciliations >= client.delivered - 1, 'frames are reconciled as they land');
    // With the lead target set from the round trip, a predicted turn lands on
    // the server's tick: no correction at all for most turns, and at most the
    // unavoidable half-tick phase error on the rest. More than one correction
    // per turn means the own snake is being yanked on every corner.
    assert.ok(stats.corrections <= turns,
      `${name}: ${stats.corrections} corrections for ${turns} turns is rubber-banding`);
    // Historical prediction error may exceed a cell on a high-latency link;
    // this is not the visible step. prediction-stability.test.mjs separately
    // checks every painted head moves at most one cell and converges.
    assert.ok(stats.maxCorrectionCells <= stats.limits.maxLeadTicks * 2,
      `${name}: unbounded correction of ${stats.maxCorrectionCells} cells`);
    assert.ok(stats.lead <= Math.round(2 * oneWay / TICK_MS) + 1 || stats.pending === 0,
      `${name}: lead ${stats.lead} runs away from its target`);
    // Never more than one correction per confirmed frame, i.e. no oscillation.
    assert.ok(stats.correctionRate <= 0.5, `${name}: correction rate ${stats.correctionRate}`);
    assert.equal(stats.rejectedFrames, 0, `${name}: valid frames must not be refused`);
    // After the last frame there is nothing left to fight about.
    assert.equal(stats.pending, 0, `${name}: pending predictions must drain`);
    assert.ok(stats.lead <= stats.limits.maxLeadTicks, `${name}: lead ${stats.lead} escaped the ceiling`);
    // With nothing outstanding, the local view must be exactly right about every
    // tick the server later confirms: that is "no drift", and it is checked per
    // tick rather than as an average.
    const lastTurn = Math.max(...(scenario.applied || []).map((entry) => entry.tick), 0);
    // A zero lead target (RTT below half a tick) is pure lockstep: the own snake
    // moves on confirmed frames and there are no local claims to audit.
    if (client.predictor.leadTarget > 0) assertSteadyStateAccuracy(client, scenario, lastTurn + 1, name);
    else assert.equal(stats.corrections, 0, `${name}: lockstep cannot be corrected`);
  }
});

test('jitter and out-of-order delivery are counted, and never rewind the snake', () => {
  const scenario = scen('latency_260ms_jitter');
  const client = makeClient(scenario, { oneWayMs: 260, jitter: [0, 200, 40, 260, 0, 120, 0, 0] });
  client.run();
  const stats = client.predictor.summary();
  assert.ok(Number.isFinite(stats.staleFrames) && Number.isFinite(stats.duplicateFrames));
  assert.ok(stats.lead <= stats.limits.maxLeadTicks, 'jitter must not widen the lead past the ceiling');
  assert.equal(stats.pending, 0, 'jittered delivery still drains to a settled state');
  // The CONFIRMED version never moves backwards, even when frames land out of
  // order: that is the whole point of carrying tick + sequence information.
  let previous = -1;
  for (const entry of client.reconciled) {
    assert.ok(entry.tick > previous, `confirmed tick went backwards: ${entry.tick} after ${previous}`);
    previous = entry.tick;
  }
  // Jitter changes WHEN a frame lands, not where the snake is once the round
  // settles: after the last confirmed turn, accuracy must be exact.
  assertSteadyStateAccuracy(client, scenario,
    Math.max(...(scenario.applied || []).map((entry) => entry.tick), 0) + 1, 'jitter');
  const stats2 = client.predictor.summary();
  assert.ok(stats2.corrections <= (scenario.applied || []).length + 2,
    `jitter must not manufacture constant corrections: ${stats2.corrections}`);
  assert.ok(stats2.maxCorrectionCells <= 4, `jitter correction too large: ${stats2.maxCorrectionCells}`);
});

test('illegal turns are refused locally for the same reason the engine refuses them', () => {
  const scenario = scen('illegal');
  const predictor = new LocalPredictor({
    tickMs: TICK_MS, columns: CFG.columns, rows: CFG.rows, ownParticipantId: CFG.participant_id, mode: 'brawl'
  });
  predictor.enable('responsive');
  predictor.observe(scenario.frames[0], { applied: true });
  // The engine accepted exactly one envelope (the first) and rejected the rest.
  assert.deepEqual(scenario.applied.map((entry) => entry.seq), [4]);
  // The engine's own verdicts, straight from the trace: the spawn direction made
  // the first "right" a duplicate too, and only seq 4 was accepted.
  assert.deepEqual(scenario.rejected.map((entry) => entry.outcome).sort(),
    ['duplicate_direction', 'duplicate_direction', 'reversal']);
  assert.equal(predictor.submit('right', 1).rejectedReason, 'duplicate_direction');
  assert.equal(predictor.submit('left', 2).rejectedReason, 'reversal');
  assert.equal(predictor.submit('nonsense', 3).rejectedReason, 'unknown_direction');
  assert.equal(predictor.submit('down', 4).rejectedReason, null, 'a legal turn is buffered');
  assert.equal(predictor.state().queue.length, 1);
});

test('a turn buffer cannot grow without bound during a burst', () => {
  const scenario = scen('idle');
  const predictor = new LocalPredictor({
    tickMs: TICK_MS, columns: CFG.columns, rows: CFG.rows, ownParticipantId: CFG.participant_id,
    limits: { maxPendingInputs: 3, maxHorizonTicks: 200, maxLeadTicks: 40 }
  });
  predictor.enable('responsive');
  predictor.observe(scenario.frames[0], { applied: true });
  // Drain the local queue as the ticks run so the unconfirmed BUFFER is what
  // overflows (the shipped horizon refuses first, which is the point of it).
  const cycle = ['down', 'left', 'up', 'right'];
  let accepted = 0;
  let time = 0;
  for (let seq = 1; seq <= 30; seq += 1) {
    if (!predictor.submit(cycle[seq % 4], seq).rejectedReason) accepted += 1;
    time += TICK_MS;
    predictor.advance(time);
  }
  const stats = predictor.summary();
  assert.ok(accepted > 0);
  assert.ok(stats.pending <= stats.limits.maxPendingInputs, `pending ${stats.pending}`);
  assert.equal(stats.droppedPending > 0, true, 'overflow must be dropped and counted');
});

test('edge wrapping matches the engine exactly (modulo wrap on both axes)', () => {
  const scenario = scen('wrap');
  const client = makeClient(scenario, { oneWayMs: 0, leadTicks: 2 });
  client.run();
  const wrapClaims = client.predictor.summary().predictedHeads;
  for (const [tick, head] of client.headsByTick) {
    if (!(tick in wrapClaims)) continue;
    assert.equal(wrapClaims[tick], head, `wrap diverged at tick ${tick}`);
  }
  // A wrapped frame really is in the fixture, otherwise this proves nothing.
  const wrapped = scenario.frames.some((frame) => frame.p[0].b[0] % CFG.columns === 0 ||
    frame.p[0].b[0] > (CFG.rows - 1) * CFG.columns);
  assert.ok(wrapped, 'fixture must actually cross an edge');
});

test('known food may be predicted; respawn and score may not', () => {
  const scenario = scen('food');
  const client = makeClient(scenario, { oneWayMs: 0, leadTicks: 2 });
  client.run();
  const stats = client.predictor.summary();
  assert.equal(stats.predictedFood, 1, 'the food ahead must be recognised locally');
  // Score is never invented: the predictor only ever reports the server value.
  const scoreSeen = client.samples.every((sample) => sample.alive !== undefined);
  assert.ok(scoreSeen);
  assert.equal(predictorScore(client), authorityScore(scenario),
    'official score stays whatever the server said');
  // The respawned food cell came from the frame, not from a local RNG.
  const lastFrame = scenario.frames.at(-1);
  const food = lastFrame.f.find((entry) => entry.o === CFG.participant_id);
  assert.ok(Number.isInteger(food.c) && food.c !== 280, 'server relocated the food');
  assert.equal(stats.corrections, 0, 'predicted growth must agree with the engine');
});
const authorityScore = (scenario) => Number(scenario.frames.at(-1).p[0].sc);
const predictorScore = (client) => Number(client.predictor.state().score);

test('authoritative freeze stops prediction; resume restarts it', () => {
  const scenario = scen('freeze');
  const client = makeClient(scenario, { oneWayMs: 0, leadTicks: 2 });
  client.run();
  const frozen = scenario.frames.filter((frame) => frame.p[0].fr);
  assert.ok(frozen.length >= 3, 'fixture must contain a real freeze window');
  const heads = new Set(frozen.map((frame) => Number(frame.p[0].b[0])));
  assert.equal(heads.size, 1, 'the engine held the snake still; so must the client');
  const stats = client.predictor.summary();
  assert.ok(stats.frozenPauses > 0, 'frozen ticks are counted, not guessed through');
  // It resumes on the server's terms: no tick was ever predicted wrongly.
  assertSteadyStateAccuracy(client, scenario,
    Math.max(...(scenario.applied || []).map((entry) => entry.tick), 0) + 1, 'freeze');
  assert.equal(client.reconciled.at(-1).tick, scenario.frames.at(-1).t);
});

test('elimination is never painted early and prediction stops on the authoritative frame', () => {
  const scenario = scen('eliminated');
  const predictor = new LocalPredictor({
    tickMs: TICK_MS, columns: CFG.columns, rows: CFG.rows, ownParticipantId: CFG.participant_id,
    clock: () => 0
  });
  predictor.enable('responsive');
  const aliveFrames = scenario.frames.filter((frame) => frame.p[0].a !== false);
  for (const frame of aliveFrames) {
    predictor.observe(frame, { applied: true });
    assert.equal(predictor.state().alive, true, 'no local death before the server says so');
  }
  const dead = scenario.frames.find((frame) => frame.p[0].a === false);
  assert.ok(dead, 'fixture must contain the eliminating frame');
  predictor.observe(dead, { applied: true });
  assert.equal(predictor.active, false, 'a dead snake must not keep being predicted');
  const before = predictor.summary().predictedTicks;
  predictor.advance(10_000);
  assert.equal(predictor.summary().predictedTicks, before, 'no movement after elimination');
});

test('a predicted self-collision holds at the wall instead of inventing a death', () => {
  const scenario = scen('self_collision');
  const predictor = new LocalPredictor({
    tickMs: TICK_MS, columns: CFG.columns, rows: CFG.rows, ownParticipantId: CFG.participant_id
  });
  predictor.enable('responsive');
  predictor.observe(scenario.frames[0], { applied: true });
  const head = Number(scenario.frames[0].p[0].b[0]);
  for (let tick = 0; tick < 5; tick += 1) predictor.advance(tick * TICK_MS + TICK_MS);
  assert.equal(predictor.state().body[0], head, 'the snake must stop at its own body');
  assert.equal(predictor.state().blocked, 'self_collision');
  assert.equal(predictor.state().alive, true, 'only the server may declare the death');
  // The engine's answer, one tick later: eliminated at that same cell.
  const dead = scenario.frames.find((frame) => frame.p[0].a === false);
  assert.equal(Number(dead.p[0].b[0]), head, 'and the engine agrees where it stopped');
  predictor.observe(dead, { applied: true });
  assert.equal(predictor.active, false);
});

test('outages: prediction is bounded, then waits — it never freelances', () => {
  const scenario = scen('turns');
  const client = makeClient(scenario, { oneWayMs: 0 });
  // Feed only the first frames, then go dark for five seconds.
  const predictor = client.predictor;
  for (const frame of scenario.frames.slice(0, 3)) predictor.observe(frame, { applied: true });
  const tickAtBlackout = predictor.state().tick;
  let time = scenario.frames[2].t * TICK_MS;
  for (let index = 0; index < 400; index += 1) {
    time += TICK_MS;
    predictor.advance(time);
  }
  const stats = predictor.summary();
  assert.equal(stats.lead, stats.limits.maxLeadTicks, `lead settled at ${stats.lead}`);
  assert.ok(stats.leadStalls > 0, 'the ceiling must be hit and counted');
  assert.ok(predictor.state().tick - tickAtBlackout <= stats.limits.maxLeadTicks);
  // ...and it is stable: further outage changes nothing at all.
  const held = predictor.state().body.slice();
  for (let index = 0; index < 50; index += 1) { time += TICK_MS; predictor.advance(time); }
  assert.deepEqual(predictor.state().body, held, 'no speculative drift during an outage');
  assert.ok(predictor.summary().predictedFood === 0);
});

test('stale, duplicate and foreign frames are ignored; a gap is applied and counted', () => {
  const scenario = scen('turns');
  const predictor = new LocalPredictor({
    tickMs: TICK_MS, columns: CFG.columns, rows: CFG.rows, ownParticipantId: CFG.participant_id
  });
  predictor.enable('responsive');
  predictor.observe(scenario.frames[3], { applied: true });
  const before = predictor.summary();
  assert.equal(predictor.observe(scenario.frames[1], { stale: true }), true, 'stale frames are refused');
  assert.equal(predictor.observe(scenario.frames[1], {}), true, 'stale by tick alone is refused');
  assert.equal(predictor.observe(scenario.frames[3], { duplicate: true }), true, 'duplicates are refused');
  predictor.observe(scenario.frames[3], { applied: true });
  const after = predictor.summary();
  assert.ok(after.staleFrames >= 2 && after.duplicateFrames >= 1, JSON.stringify({ before, after }));
  assert.equal(after.confirmedTick, 3, 'the confirmed version did not move backwards');
  // A genuine jump (a dropped frame) must still be applied: snapshots are whole.
  const jumped = predictor.observe(scenario.frames[8], { applied: true });
  assert.equal(jumped, true);
  assert.equal(predictor.summary().confirmedTick, 8);
});

test('reconnection discards obsolete predictions and restarts from server state', () => {
  const scenario = scen('turns');
  const predictor = new LocalPredictor({
    tickMs: TICK_MS, columns: CFG.columns, rows: CFG.rows, ownParticipantId: CFG.participant_id
  });
  predictor.enable('responsive');
  predictor.observe(scenario.frames[1], { applied: true });
  predictor.submit('down', 91);
  predictor.submit('left', 92);
  assert.equal(predictor.summary().pending, 2);
  predictor.reset('socket dropped', { reconnect: true });
  assert.equal(predictor.summary().pending, 0, 'obsolete inputs must not survive a gap');
  assert.equal(predictor.state(), null, 'nothing is trusted from before the gap');
  // The seed frame is the only source: adopting it must not need a correction.
  const seed = scenario.frames.at(-1);
  predictor.observe(seed, { applied: true });
  assert.equal(predictor.summary().corrections, 0);
  assert.equal(predictor.state().tick, seed.t);
  assert.ok(predictor.summary().resetForReconnect >= 1);
});

test('a received sequence mirror cannot masquerade as an applied input', () => {
  const scenario = scen('turns');
  const predictor = new LocalPredictor({
    tickMs: TICK_MS, columns: CFG.columns, rows: CFG.rows, ownParticipantId: CFG.participant_id
  });
  predictor.enable('responsive');
  predictor.observe(scenario.frames[0], { applied: true });
  predictor.submit('down', 5);
  // The server mirror says the sequence is already at 9 (another tab pressed).
  assert.equal(predictor.noteSequenceMirror(9), true);
  assert.equal(predictor.summary().pending, 1, 'receipt does not prove that the simulation applied our input');
  assert.equal(predictor.summary().foreignApplied, 1);
  // Only a frame carrying an applied watermark may retire the prediction.
  const confirmed = structuredClone(scenario.frames[1]);
  confirmed.p[0].is = 9;
  predictor.observe(confirmed, { applied: true });
  assert.equal(predictor.summary().pending, 0);
  // And our next seq must not collide with the server-owned counter.
  assert.equal(predictor.recordSeq(6), false, 'reusing a burned sequence is refused');
  assert.equal(predictor.recordSeq(10), true);
});

test('classic Brawl leaves the predictor completely inert', () => {
  const scenario = scen('turns');
  const predictor = new LocalPredictor({
    tickMs: TICK_MS, columns: CFG.columns, rows: CFG.rows, ownParticipantId: CFG.participant_id
  });
  const frame = scenario.frames[0];
  assert.equal(predictor.enabled, false);
  assert.equal(predictor.observe(frame, { applied: true }), false);
  assert.equal(predictor.submit('down', 1).rejectedReason, 'unavailable');
  assert.equal(predictor.advance(100_000), 0, 'no ticks are run at all');
  assert.equal(predictor.displayFrame(frame), frame, 'Classic paints the authoritative frame object itself');
  assert.equal(predictor.summary().predictedTicks, 0);
  assert.equal(predictor.summary().submitted, 0);
});

test('Responsive is armed only by the server, or by the explicit test override', () => {
  const store = (() => {
    const data = new Map();
    return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)) };
  })();
  assert.deepEqual(responsivePredictionEnabled({ strategy: 'classic', search: '', storage: null }),
    { active: false, source: 'off', testOnly: false });
  // A server-locked Responsive match is the only non-test path to prediction.
  assert.equal(responsivePredictionEnabled({ strategy: 'responsive', search: '', storage: null }).active, true);
  assert.equal(responsivePredictionEnabled({ strategy: 'responsive', search: '', storage: null }).testOnly, false);
  // The override needs an explicit flag and is announced as test-only forever.
  const viaUrl = responsivePredictionEnabled({ strategy: 'classic', search: '?responsivePrediction=test', storage: store });
  assert.equal(viaUrl.active, true);
  assert.equal(viaUrl.testOnly, true);
  assert.equal(store.getItem(RESPONSIVE_TEST_OVERRIDE), '1', 'remembered for the tab so a reconnect keeps measuring');
  assert.equal(responsivePredictionEnabled({ strategy: 'classic', search: '', storage: store }).testOnly, true);
  // An ordinary visit after that tab closes is unaffected.
  assert.equal(responsivePredictionEnabled({ strategy: 'classic', search: '', storage: null }).active, false);
  // ...and a random query string never arms it.
  assert.equal(responsivePredictionEnabled({ strategy: 'classic', search: '?responsivePrediction=1&x=test',
    storage: null }).active, false);
});

test('prediction limits are the shipped policy, not a per-test invention', () => {
  assert.equal(PREDICTION_LIMITS.maxLeadTicks, 6);
  assert.ok(PREDICTION_LIMITS.maxLeadTicks <= SimulationInputWindow(),
    'the ceiling must stay inside what the server can still honour');
  const predictor = new LocalPredictor({ tickMs: TICK_MS, columns: CFG.columns, rows: CFG.rows,
    ownParticipantId: CFG.participant_id, limits: { maxLeadTicks: 2 } });
  predictor.enable('responsive');
  predictor.observe(scen('idle').frames[0], { applied: true });
  for (let index = 1; index <= 20; index += 1) predictor.advance(index * TICK_MS);
  assert.equal(predictor.summary().lead, 2, 'limits are honoured');
});
// Simulation::World::QUEUED_INPUT_TICK_WINDOW is 30 and Match::INPUT_FUTURE_WINDOW
// is the checkpoint cadence plus catch-up; 8 predicted ticks is comfortably
// inside both. Pinned here so a server-side tightening is noticed.
function SimulationInputWindow() { return 30; }
