import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SwipeSteering, legDirection, SWIPE_THRESHOLD_PX } from '../public/multiplayer/swipe-steering.js';

// A gesture replays the exact pointer coordinates a player's finger produced.
function gesture(steps, { threshold = SWIPE_THRESHOLD_PX } = {}) {
  const sent = [];
  const swipes = new SwipeSteering({ threshold, send: (d) => sent.push(d) });
  if (!steps.length) return { sent, swipes };
  swipes.begin(steps[0]);
  for (const step of steps.slice(1)) swipes.move(step);
  return { sent, swipes };
}

test('a fast down-then-left swipe commits BOTH turns immediately', () => {
  // Going right, the player flicks down then left in one continuous gesture.
  // Each leg only travels 30px — far less than the old cumulative requirement.
  const { sent } = gesture([
    { x: 200, y: 300 },  // finger lands
    { x: 200, y: 312 },  // creeping down, still inside the threshold
    { x: 201, y: 330 },  // 30px down -> 'down' must fire
    { x: 190, y: 331 },  // starts moving left
    { x: 172, y: 333 },  // 30px left of the RE-ANCHORED origin -> 'left' must fire
  ]);
  assert.deepEqual(sent, ['down', 'left']);
});

test('the old cumulative-geometry failure no longer loses the second turn', () => {
  // Equal-length legs. The previous code compared both legs against the single
  // original touch point, so |dx| === |dy| never resolved and the turn was lost.
  const { sent } = gesture([
    { x: 200, y: 300 },
    { x: 200, y: 340 },  // 40px down
    { x: 160, y: 340 },  // 40px left of the ORIGINAL origin: a tie under the old code
  ]);
  assert.deepEqual(sent, ['down', 'left']);
});

test('lifting the finger still commits a leg that never got its own move event', () => {
  const sent = [];
  const swipes = new SwipeSteering({ send: (d) => sent.push(d) });
  swipes.begin({ x: 200, y: 300 });
  swipes.move({ x: 200, y: 320 });   // 'down'
  assert.deepEqual(sent, ['down']);
  swipes.end({ x: 180, y: 322 });    // quick left flick, then lift
  assert.deepEqual(sent, ['down', 'left']);
});

test('a diagonal tie is never guessed, and sub-threshold drift sends nothing', () => {
  assert.equal(legDirection({ x: 0, y: 0 }, { x: 30, y: 30 }), null);
  assert.equal(legDirection({ x: 0, y: 0 }, { x: 5, y: 9 }), null);
  const { sent } = gesture([{ x: 0, y: 0 }, { x: 5, y: 9 }, { x: 8, y: 11 }]);
  assert.deepEqual(sent, []);
});

test('continuing the same leg does not spam duplicates, but a third turn still queues', () => {
  const { sent, swipes } = gesture([
    { x: 200, y: 300 },
    { x: 200, y: 330 },  // down
    { x: 200, y: 360 },  // still down: duplicate, not re-sent
    { x: 200, y: 390 },  // still down
  ]);
  assert.deepEqual(sent, ['down']);
  // A Z-shaped gesture: down, left, up — three turns from one continuous drag.
  swipes.move({ x: 170, y: 391 });
  swipes.move({ x: 170, y: 360 });
  assert.deepEqual(sent, ['down', 'left', 'up']);
});

test('a cancelled gesture sends nothing and can be restarted cleanly', () => {
  const sent = [];
  const swipes = new SwipeSteering({ send: (d) => sent.push(d) });
  swipes.begin({ x: 0, y: 0 });
  swipes.move({ x: 0, y: 40 });
  assert.deepEqual(sent, ['down']);
  swipes.cancel();
  assert.equal(swipes.active, false);
  swipes.begin({ x: 100, y: 100 });
  swipes.move({ x: 140, y: 100 });
  assert.deepEqual(sent, ['down', 'right']);
});

test('mouse pointers and malformed points never emit', () => {
  const sent = [];
  const swipes = new SwipeSteering({ send: (d) => sent.push(d) });
  swipes.move({ x: 0, y: 100 });
  swipes.begin(undefined);
  swipes.move(undefined);
  swipes.end(null);
  assert.deepEqual(sent, []);
  assert.equal(swipes.active, false);
});
