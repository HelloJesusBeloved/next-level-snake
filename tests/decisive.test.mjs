import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DecisiveSnake } from '../public/multiplayer/decisive.js';

const COLS = 24;
const ROWS = 18;
const TICK = 100;

function frame(body, extras = {}) {
  return {
    v: 1, type: 'snapshot', m: 9, s: 'running', t: 3, b: { c: COLS, r: ROWS },
    f: [], tick_ms: TICK,
    p: [{ i: 1, n: 'P', c: '#00FF00', b: body, l: body.length, a: true, d: 'right', sc: 0,
          fr: false, cy: 'connected', ...extras.player }],
    ...extras.frame,
  };
}

function snake(now = { t: 0 }) {
  const local = new DecisiveSnake({
    tickMs: TICK, columns: COLS, rows: ROWS, ownParticipantId: 1, growth: 1,
    clock: () => now.t,
  });
  local.enable('responsive');
  return local;
}

function delta(from, to) {
  let dx = (to % COLS) - (from % COLS);
  let dy = Math.floor(to / COLS) - Math.floor(from / COLS);
  if (dx > COLS / 2) dx -= COLS;
  if (dx < -COLS / 2) dx += COLS;
  if (dy > ROWS / 2) dy -= ROWS;
  if (dy < -ROWS / 2) dy += ROWS;
  return [dx, dy];
}

const VECTORS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

test('a turn at any phase of the tick is the next cell, not a slide', () => {
  const starts = { up: 'right', down: 'right', left: 'up', right: 'up' };
  const bodyBehind = (heading) => {
    const head = 8 * COLS + 8;
    if (heading === 'right') return [head, head - 1, head - 2];
    if (heading === 'left') return [head, head + 1, head + 2];
    if (heading === 'up') return [head, head + COLS, head + 2 * COLS];
    return [head, head - COLS, head - 2 * COLS];
  };
  for (const direction of ['up', 'down', 'left', 'right']) {
    for (const phase of [0, 0.25, 0.5, 0.99]) {
      const now = { t: 0 };
      const local = snake(now);
      const seed = frame(bodyBehind(starts[direction]), { player: { d: starts[direction] } });
      local.observe(seed);
      now.t = Math.floor(phase * TICK);
      const press = local.submit(direction);
      assert.equal(press.rejectedReason, null, `${direction} at ${phase}`);
      assert.equal(local.advance(now.t), 0, 'a partial tick does not move');
      assert.equal(local.body[0], seed.p[0].b[0], 'the press itself does not move the head');
      now.t = TICK;
      assert.equal(local.advance(now.t), 1);
      const moved = local.body[0];
      assert.deepEqual(delta(seed.p[0].b[0], moved), VECTORS[direction], `${direction} at phase ${phase}`);
      assert.equal(local.direction, direction);
      assert.equal(local.queue.length, 0);
    }
  }
});

test('the snake keeps stepping straight when no packet and no key arrives', () => {
  const now = { t: 0 };
  const local = snake(now);
  local.observe(frame([10, 9, 8]));
  let head = 10;
  for (let tick = 1; tick <= 5; tick += 1) {
    now.t = tick * TICK;
    assert.equal(local.advance(now.t), 1);
    assert.equal(local.body[0], head + 1);
    head += 1;
    assert.equal(delta(local.body[1], local.body[0])[0], 1);
    assert.equal(local.direction, 'right');
  }
});

test('a later snapshot with a different body does not move the local head', () => {
  const now = { t: 0 };
  const local = snake(now);
  local.observe(frame([10, 9, 8]));
  now.t = TICK;
  local.advance(now.t);
  const head = local.body.slice();
  local.observe(frame([80, 79, 78], { frame: { t: 8 }, player: { d: 'down', sc: 4 } }));
  assert.deepEqual(local.body, head);
  assert.equal(local.direction, 'right');
  assert.equal(local.shownScore, 4, 'a higher server score is kept, the body is not');
  const painted = local.displayFrame(frame([80, 79, 78], { player: { d: 'down' } }));
  assert.deepEqual(painted.p[0].b, head);
  assert.equal(painted.p[0].d, 'right');
});

test('the head delta matches the heading on every step, including a turn', () => {
  const now = { t: 0 };
  const local = snake(now);
  local.observe(frame([5 * COLS + 2, 5 * COLS + 1, 5 * COLS]));
  const plan = ['right', 'right', 'down', 'down', 'left', 'left', 'up', 'right'];
  let previous = local.body[0];
  plan.forEach((direction, index) => {
    if (direction !== local.direction) {
      assert.equal(local.submit(direction).rejectedReason, null);
    }
    now.t = (index + 1) * TICK;
    assert.equal(local.advance(now.t), 1);
    assert.deepEqual(delta(previous, local.body[0]), VECTORS[local.direction]);
    previous = local.body[0];
  });
});

test('food from the snapshot grows once and a catching-up score does not double', () => {
  const now = { t: 0 };
  const local = snake(now);
  const reports = [];
  local.onStep = (report) => reports.push(report);
  const bite = 11;
  local.observe(frame([10, 9, 8], { frame: { f: [{ c: bite, o: 1 }] } }));
  assert.equal(local.food, bite);
  now.t = TICK;
  local.advance(now.t);
  assert.equal(local.body[0], bite);
  assert.equal(local.body.length, 4);
  assert.equal(local.score, 1);
  assert.equal(local.food, null, 'the bitten pellet is not drawn again');
  assert.equal(reports.at(-1).c, bite);
  assert.equal(reports.at(-1).type, 'report');
  assert.equal(reports.at(-1).dir, 'right');
  // The server still shows the old pellet and then confirms the point.
  local.observe(frame([10, 9, 8], { frame: { t: 4, f: [{ c: bite, o: 1 }] }, player: { sc: 0 } }));
  assert.equal(local.score, 1);
  assert.deepEqual(local.body.slice(0, 1), [bite]);
  local.observe(frame([10, 9, 8], { frame: { t: 5, f: [{ c: 40, o: 1 }] }, player: { sc: 1 } }));
  assert.equal(local.score, 1, 'the server catching up must not add the point again');
  assert.equal(local.food, 40);
  now.t = TICK * 2;
  // Not on the new pellet yet.
  local.advance(now.t);
  assert.equal(local.score, 1);
  assert.equal(local.eaten, 1);
});

test('self-collision stops the local snake and still reports the cell', () => {
  const now = { t: 0 };
  const local = snake(now);
  const reports = [];
  local.onStep = (report) => reports.push(report);
  const head = 5 * COLS + 5;
  // Neck to the left, tail sitting on the cell directly above the head.
  // Growing, so that tail does not vacate when the head steps up into it.
  local.observe(frame([head, head - 1, head - 1 - COLS, head - COLS], { player: { d: 'up' } }));
  local.grow = 1;
  now.t = TICK;
  local.advance(now.t);
  assert.equal(local.dead, true);
  assert.equal(local.active, false);
  assert.equal(reports.length, 1);
  assert.equal(local.advance(TICK * 5), 0, 'a dead snake does not keep walking');
});

test('reconnect reseeds from the new snapshot instead of keeping the old body', () => {
  const now = { t: 0 };
  const local = snake(now);
  local.observe(frame([10, 9, 8]));
  now.t = TICK;
  local.advance(now.t);
  local.noteSequenceMirror(7);
  local.reset('rematch', { reconnect: true });
  assert.equal(local.summary().resetForReconnect, 1);
  assert.equal(local.seeded, false);
  local.observe(frame([3, 2, 1], { frame: { m: 10, t: 0 } }));
  assert.deepEqual(local.body, [3, 2, 1]);
  assert.equal(local.seq, 7, 'the sequence floor survives the reseed');
  // The new life starts its own tick. The clock is wherever the tab is now.
  now.t += TICK;
  local.advance(now.t);
  assert.equal(local.body[0], 4);
});

test('a finished board does not start the local snake', () => {
  for (const status of ['completed', 'abandoned', 'paused']) {
    const now = { t: 0 };
    const local = snake(now);
    local.observe(frame([10, 9, 8], { frame: { s: status } }));
    assert.equal(local.running, false, status);
    assert.equal(local.active, false, status);
    assert.deepEqual(local.body, [10, 9, 8], 'the final cells stay put');
    now.t = TICK * 5;
    assert.equal(local.advance(now.t), 0, status);
    assert.deepEqual(local.body, [10, 9, 8], status);
    // A living winner is not painted as dead just because the match ended.
    if (status !== 'paused') assert.equal(local.dead, false, status);
  }
});

test('hold freezes a running snake without clearing its body', () => {
  const now = { t: 0 };
  const local = snake(now);
  local.observe(frame([10, 9, 8]));
  now.t = TICK;
  local.advance(now.t);
  assert.equal(local.body[0], 11);
  local.hold('rematch');
  now.t = TICK * 4;
  assert.equal(local.advance(now.t), 0);
  assert.equal(local.body[0], 11);
  assert.equal(local.active, false);
});
