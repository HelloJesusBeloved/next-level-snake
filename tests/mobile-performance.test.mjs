import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlayBudget, hudKey, text } from '../public/multiplayer/play-budget.js';

// The lag report was reproducible on a 4x-CPU-throttled phone: the scoreboard
// rebuilt and the page restyled on every tick, although survival was shown
// only to the second. These are pure clock-controlled tests of the budget that
// fixes that; no wall-clock sleeps and no fake gameplay engine are involved.
function clock() {
  let at = 0, id = 0;
  const pending = new Map();
  const schedule = (task, delay) => { const token = ++id; pending.set(token, { task, at: at + delay }); return token; };
  const cancel = (key) => pending.delete(key);
  return {
    now: () => at,
    schedule, cancel,
    advance(ms) {
      at += ms;
      for (const [key, event] of pending) {
        if (event.at <= at) { pending.delete(key); event.task(); }
      }
    },
    count: () => pending.size,
  };
}

test('twenty frames coalesce to one DOM task and never movement commands', () => {
  const c = clock();
  const budget = createPlayBudget({ now: c.now, schedule: c.schedule, cancel: c.cancel });
  let hudWrites = 0;
  let simulatedBodies = 0;
  budget.start();
  for (let i = 0; i < 20; i += 1) {
    budget.add('scores', () => { hudWrites += 1; });
    simulatedBodies += 1;
  }
  assert.equal(hudWrites, 0);
  c.advance(1_000);
  assert.equal(hudWrites, 1);
  assert.equal(simulatedBodies, 20, 'the authoritative frames still arrive/paint');
  assert.equal(c.count(), 0, 'no outstanding interval runs at movement cadence');
});

test('one-second HUD budget is independent of every movement tick', () => {
  const c = clock();
  const budget = createPlayBudget({ now: c.now, schedule: c.schedule, cancel: c.cancel });
  let values = [];
  budget.start();
  c.advance(1_000);
  for (let i = 0; i < 3; i += 1) {
    budget.add('tick', () => values.push(i));
    c.advance(50);
  }
  assert.equal(values.length, 0, 'no reflow at every tick');
  c.advance(850);
  assert.deepEqual(values, [2], 'the latest HUD value wins once per second');
});

test('a completed round and a connection change can flush immediately', () => {
  const c = clock();
  const budget = createPlayBudget({ now: c.now, schedule: c.schedule, cancel: c.cancel });
  const writes = [];
  budget.start();
  budget.add('scores', () => writes.push('final'));
  budget.flush('scores');
  assert.deepEqual(writes, ['final']);
  budget.flush('scores');
  assert.deepEqual(writes, ['final'], 'already-flushed tasks do not repeat');
  c.advance(1_000);
  assert.equal(writes.length, 1);
});

test('a hidden tab never refreshes live HUD and the return restores it', () => {
  const c = clock();
  const budget = createPlayBudget({ now: c.now, schedule: c.schedule, cancel: c.cancel });
  let writes = 0;
  budget.start();
  budget.add('scores', () => { writes += 1; });
  budget.stop();
  c.advance(5_000);
  assert.equal(writes, 0);
  assert.equal(budget.size, 0);
  budget.start();
  budget.add('scores', () => { writes += 1; });
  c.advance(1_000);
  assert.equal(writes, 1);
  assert.equal(c.count(), 0);
});

test('survival changes do not invalidate the HUD at movement cadence', () => {
  const frame = { m: 9, s: 'running', p: [{ i: 1, n: 'P1', c: '#00ff00', a: true, fr: false, sc: 2, l: 3, sv: 5 }] };
  const next = { ...frame, t: 22, p: [{ ...frame.p[0], sv: 6 }] };
  assert.equal(hudKey(frame, 1, 105), hudKey(next, 1, 105), 'both ticks show 0 seconds');
  const later = { ...next, p: [{ ...next.p[0], sv: 40 }] };
  assert.notEqual(hudKey(frame, 1, 105), hudKey(later, 1, 105), 'four seconds is a real change');
});

test('identical labels never mutate the DOM or re-trigger the screen reader', () => {
  let writes = 0;
  const node = { get textContent() { return this.value; }, set textContent(value) { this.value = value; writes += 1; }, value: 'Live' };
  text(node, 'Live');
  assert.equal(writes, 0);
  text(node, 'Reconnecting…');
  text(node, 'Reconnecting…');
  assert.equal(writes, 1);
});

// Rendering on the phone is immediate; secondary HUD changes follow the
// budget. This tests the *real renderer* with a tiny DOM and a fake clock.
import { JSDOM } from 'jsdom';
const { MultiplayerGameRenderer } = await import('../public/multiplayer/game-renderer.js');

test('real renderer keeps every authoritative tick but only writes HUD once per second', () => {
  const dom = new JSDOM('<!doctype html><html><body><canvas id="board"></canvas><ol id="scores"></ol></body></html>', {
    pretendToBeVisual: true, url: 'http://localhost/', runScripts: 'outside-only',
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.MutationObserver = dom.window.MutationObserver;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  dom.window.matchMedia = () => ({ matches: false });
  dom.window.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
    get: () => () => {}, set: () => true,
  });
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 316, height: 237, x: 0, y: 0 });
  const budgetClock = clock();
  const hud = createPlayBudget({ now: budgetClock.now, schedule: budgetClock.schedule, cancel: budgetClock.cancel });
  const scores = document.getElementById('scores');
  const renderer = new MultiplayerGameRenderer({
    canvas: document.getElementById('board'), scoreboard: scores, ownParticipantId: 1, budget: hud,
  });
  renderer.setActive(true);
  let draws = 0, mutations = 0;
  const originalDraw = renderer.draw.bind(renderer);
  renderer.draw = () => { draws += 1; originalDraw(); };
  const originalRebuild = scores.replaceChildren.bind(scores);
  scores.replaceChildren = (...args) => { mutations += 1; originalRebuild(...args); };

  for (let tick = 1; tick <= 20; tick += 1) {
    const player = { i: 1, n: 'P1', c: '#00ff00', a: true, sc: 2, l: 3, b: [tick + 1, tick, tick - 1], sv: tick,
                     d: 'right', fr: false, cy: 'connected', gu: null, fz: 0, lg: 3 };
    const frame = { v: 1, type: 'snapshot', m: 9, t: tick, s: 'running', b: { c: 24, r: 18 },
                    p: [player], q: [{ i: 1, p: 1, sc: 2, sv: tick, lg: 3 }], f: [] };
    assert.equal(renderer.accept(frame), true);
  }
  assert.equal(draws, 20, 'every authoritative tick is painted (no prediction or interpolation)');
  assert.equal(mutations, 0, 'no DOM reflow before the HUD budget releases it');
  budgetClock.advance(1000);
  assert.equal(mutations, 1, 'HUD updated once per second, not once per tick');
  assert.equal(scores.querySelector('li').dataset.playerId, '1');
  assert.equal(scores.querySelector('strong').textContent, '2 pts');
  renderer.destroy();
  dom.window.close();
});
