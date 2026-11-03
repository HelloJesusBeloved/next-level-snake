// Two clients, one authoritative tape. The tape is produced by Simulation::World
// (tests/support/generate-authority-trace.rb), not by a second snake engine.
// Loss, jitter and catch-up bursts are applied here. The assertions are the
// invariants Responsive Brawl was missing: one shared tick for heads and
// pellets, a pellet on every tick, growth only when the server ate, and a
// render offset that does not grow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { LocalPredictor } from '../public/multiplayer/prediction.js';
import { RemotePlayback } from '../public/multiplayer/playback.js';

const tape = JSON.parse(execFileSync('ruby', ['tests/support/generate-authority-trace.rb'], {
  cwd: new URL('..', import.meta.url),
  maxBuffer: 64 * 1024 * 1024,
  env: { ...process.env, PATH: `/opt/hostedtoolcache/Ruby/3.3.6/x64/bin:${process.env.PATH || ''}` }
}).toString());

const TICK = tape.tick_ms;
const authority = new Map(tape.states.map((state) => [state.t, state]));

function deliver(frames, { lossSeed, jitter }) {
  const out = [];
  frames.forEach((frame, index) => {
    const drop = ((index * 17 + lossSeed) % 20) === 0 && index > 0;
    if (drop) return;
    const swing = jitter[index % jitter.length];
    out.push({ frame, at: frame.t * TICK + 80 + swing });
  });
  out.sort((a, b) => a.at - b.at || a.frame.t - b.frame.t);
  return out;
}

function client(ownId, delivered) {
  let time = 0;
  const clock = () => time;
  const predictor = new LocalPredictor({
    tickMs: TICK, columns: tape.columns, rows: tape.rows, growth: tape.growth,
    mode: 'brawl', ownParticipantId: ownId, clock
  });
  predictor.enable('responsive');
  const playback = new RemotePlayback({ tickMs: TICK, columns: tape.columns, rows: tape.rows, clock });
  playback.enable('responsive');
  return { time, set(now) { time = now; }, predictor, playback, delivered, cursor: 0, newest: null };
}

function pump(view, now) {
  view.set(now);
  while (view.cursor < view.delivered.length && view.delivered[view.cursor].at <= now) {
    const { frame } = view.delivered[view.cursor];
    view.cursor += 1;
    view.newest = frame;
    view.predictor.observe(frame, { applied: true });
    view.playback.pushSnapshot(frame, now);
  }
  view.predictor.advance(now);
  const sample = view.playback.sample(now);
  const base = sample?.frame || view.newest;
  if (!base) return null;
  const painted = view.predictor.active ? view.predictor.displayFrame(base) : base;
  return {
    tick: base.t,
    foods: (base.f || []).map((food) => ({ o: Number(food.o), c: food.c, g: food.g ?? null })),
    players: (painted.p || []).map((player) => ({
      id: Number(player.i),
      head: player.b[0],
      length: player.b.length,
      score: player.sc,
      dir: player.d
    })),
    lag: view.newest ? view.newest.t - base.t : 0
  };
}

const jitter = [0, 120, -120, 40, -80, 110, -40, 90, -110, 20];

function freshPair() {
  return {
    left: client(1, deliver(tape.wire, { lossSeed: 1, jitter })),
    right: client(2, deliver(tape.wire, { lossSeed: 3, jitter: jitter.slice().reverse() }))
  };
}

function samplesOf(view) {
  const seen = [];
  const end = tape.wire.at(-1).t * TICK + 400;
  for (let now = 0; now <= end; now += TICK) seen.push(pump(view, now));
  return seen.filter(Boolean);
}

test('the wire carries tick_ms, a monotonic tick stamp, food generation and eaten events', () => {
  assert.ok(tape.wire.length > 600);
  for (const frame of tape.wire) {
    assert.equal(frame.tick_ms, TICK);
    assert.equal(frame.tm, frame.t * TICK);
    assert.ok(Array.isArray(frame.fe));
    assert.ok(frame.f.length >= 1);
    for (const food of frame.f) assert.equal(typeof food.g, 'number');
  }
  const ticks = tape.wire.map((frame) => frame.t);
  for (let index = 1; index < ticks.length; index += 1) {
    assert.equal(ticks[index], ticks[index - 1] + 1, `wire skipped tick ${ticks[index - 1] + 1}`);
  }
});

test('a full snapshot stays small enough to send every tick', () => {
  assert.ok(tape.snapshot_bytes < 4000, `snapshot is ${tape.snapshot_bytes} bytes`);
});

test('both clients draw the server pellet for the tick they are showing, and the offset does not grow', () => {
  const { left, right } = freshPair();
  const a = samplesOf(left);
  const b = samplesOf(right);
  for (const series of [a, b]) {
    let maxLag = 0;
    const late = [];
    for (const sample of series) {
      maxLag = Math.max(maxLag, sample.lag);
      const state = authority.get(sample.tick);
      assert.ok(state, `no authority for tick ${sample.tick}`);
      assert.equal(sample.foods.length, state.foods.length, `tick ${sample.tick} pellet count`);
      for (const food of state.foods) {
        const drawn = sample.foods.filter((pellet) => pellet.o === food.o);
        assert.equal(drawn.length, 1, `owner ${food.o} pellets at tick ${sample.tick}`);
        assert.equal(drawn[0].c, food.c);
        assert.equal(drawn[0].g, food.g);
      }
      for (const player of sample.players) {
        const server = state.players.find((entry) => entry.i === player.id);
        assert.equal(player.head, server.h, `head ${player.id} at tick ${sample.tick}`);
        assert.equal(player.length, server.l, `length ${player.id} at tick ${sample.tick}`);
        assert.equal(player.score, server.sc, `score ${player.id} at tick ${sample.tick}`);
      }
      if (sample.tick > 400) late.push(sample.lag);
    }
    assert.ok(maxLag <= 8, `lag grew to ${maxLag}`);
    const tail = late.slice(-80);
    assert.ok(tail.every((lag) => lag <= 2), `settled lag ${tail.slice(-5)}`);
  }
});

test('eating grows the displayed body by one and an empty cell does not', () => {
  const { left } = freshPair();
  const series = samplesOf(left);
  let previous = null;
  let eats = 0;
  for (const sample of series) {
    const state = authority.get(sample.tick);
    if (!previous || previous.tick === sample.tick) { previous = sample; continue; }
    for (const player of sample.players) {
      const server = state.players.find((entry) => entry.i === player.id);
      assert.equal(player.score, server.sc, `score at ${sample.tick}`);
      assert.equal(player.length, server.l, `length at ${sample.tick}`);
      const eaten = (state.fe || []).find((event) => event.o === player.id);
      const priorState = authority.get(sample.tick - 1);
      const prior = priorState && priorState.players.find((entry) => entry.i === player.id);
      if (eaten) {
        eats += 1;
        assert.equal(server.h, eaten.c, `eat cell at ${sample.tick}`);
        if (prior) {
          assert.equal(server.l, prior.l + tape.growth, `growth at ${sample.tick}`);
          assert.equal(server.sc, prior.sc + 1, `score at ${sample.tick}`);
        }
      } else if (prior && sample.tick === previous.tick + 1) {
        assert.equal(server.l, prior.l, `empty cell grew at ${sample.tick}`);
        assert.equal(server.sc, prior.sc, `empty cell scored at ${sample.tick}`);
      }
    }
    previous = sample;
  }
  assert.ok(eats > 20, `only saw ${eats} eats`);
});

test('a dropped frame and a 100ms delay still match the server within 3 ticks', () => {
  const { left } = freshPair();
  const series = samplesOf(left);
  const pressed = series.filter((sample) => sample.tick > 10);
  for (const sample of pressed) {
    assert.ok(sample.lag <= 3, `tick ${sample.tick} is ${sample.lag} behind the newest frame`);
  }
});

test('a 3-tick hole is the next real frame, not an invented body or a resync storm', () => {
  let now = 0;
  const playback = new RemotePlayback({
    tickMs: TICK, columns: tape.columns, rows: tape.rows, clock: () => now
  });
  playback.enable('responsive');
  const early = tape.wire.filter((frame) => frame.t <= 10);
  early.forEach((frame, index) => playback.pushSnapshot(frame, index * TICK));
  for (let step = 0; step < 30; step += 1) {
    now += TICK;
    playback.sample(now);
  }
  const before = playback.summary().resyncs;
  const late = tape.wire.find((frame) => frame.t === 14);
  playback.pushSnapshot(late, now);
  let saw = null;
  for (let step = 0; step < 2; step += 1) {
    now += TICK;
    const sample = playback.sample(now);
    if (sample?.tick >= 14) { saw = sample; break; }
  }
  assert.ok(saw, 'the hole did not recover within 2 frames');
  assert.equal(saw.interpolated, false);
  assert.equal(playback.summary().bridgedGaps, 0);
  assert.equal(playback.byTick.has(11), false, 'the missing tick was not invented');
  assert.equal(playback.byTick.has(12), false);
  assert.equal(playback.byTick.has(13), false);
  assert.ok(playback.summary().resyncs - before <= 1);
  const state = authority.get(saw.tick);
  const player = saw.players.get(1);
  assert.deepEqual(player.cells, state.players[0].b);
});

test('a key changes the next cell within one tick and does not wait for the server', () => {
  const predictor = new LocalPredictor({
    tickMs: TICK, columns: tape.columns, rows: tape.rows, growth: 1,
    mode: 'brawl', ownParticipantId: 1, clock: () => 0
  });
  predictor.enable('responsive');
  const frame = tape.wire[0];
  predictor.observe(frame, { applied: true });
  const before = predictor.displayFrame(frame).p.find((player) => player.i === 1);
  predictor.submit('down', 1);
  predictor.advance(TICK - 1);
  const mid = predictor.displayFrame(frame).p.find((player) => player.i === 1);
  assert.equal(mid.d, before.d, 'a press must not turn mid-tick');
  predictor.advance(TICK);
  const turned = predictor.state();
  assert.equal(turned.direction, 'down');
  assert.notEqual(turned.body[0], before.b[0]);
  assert.ok(predictor.summary().predictedFood === 0, 'the overlay must not eat');
});
