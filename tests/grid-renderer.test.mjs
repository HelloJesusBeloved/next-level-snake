import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { MultiplayerGameRenderer } from '../public/multiplayer/game-renderer.js';
import { createPlayBudget } from '../public/multiplayer/play-budget.js';

function setup({ enabled = true, coarse = false } = {}) {
  const dom = new JSDOM('<!doctype html><canvas></canvas><ol></ol>', { pretendToBeVisual: true });
  const { window } = dom;
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.MutationObserver = window.MutationObserver;
  globalThis.getComputedStyle = window.getComputedStyle.bind(window);
  window.matchMedia = (query) => ({ matches: coarse && query === '(any-pointer: coarse)' });
  let at = 0, id = 0;
  const callbacks = new Map(), calls = [];
  const request = (cb) => { const key = ++id; callbacks.set(key, cb); return key; };
  const cancel = (key) => callbacks.delete(key);
  globalThis.requestAnimationFrame = request;
  globalThis.cancelAnimationFrame = cancel;
  const canvas = document.querySelector('canvas');
  canvas.getBoundingClientRect = () => ({ width: 316, height: 237 });
  const ctx = new Proxy({}, { get: (_, name) => (...args) => { calls.push({ name, args }); }, set: () => true });
  let contexts = 0, attributes;
  canvas.getContext = (_, options) => { contexts++; attributes = options; return ctx; };
  const budget = createPlayBudget({ now: () => at, schedule: () => 999, cancel: () => {} });
  const renderer = new MultiplayerGameRenderer({ canvas, scoreboard: document.querySelector('ol'), ownParticipantId: 1,
    budget, cadenceEnabled: enabled, clock: () => at, frameRequest: request, frameCancel: cancel });
  renderer.setActive(true);
  const paintTicks = [];
  const draw = renderer.draw.bind(renderer);
  renderer.draw = () => { paintTicks.push(renderer.paintSnapshot.t); return draw(); };
  return {
    renderer, calls, paintTicks, get contexts() { return contexts; }, get attributes() { return attributes; },
    at(value) { at = value; },
    refresh(value = at) { at = value; for (const [key, cb] of [...callbacks]) { callbacks.delete(key); cb(at); } },
    get queued() { return callbacks.size; },
    close() { renderer.destroy(); assert.equal(callbacks.size, 0, 'no leaked repaint on teardown'); dom.window.close(); },
  };
}
const frame = (t, player = {}, extras = {}) => ({
  v: 1, type: 'snapshot', m: 99, s: 'running', t, b: { c: 24, r: 18 }, f: [],
  p: [{ i: 1, n: 'P1', c: '#00FF00', b: [t + 3, t + 2, t + 1], l: 3, a: true, d: 'right', sc: 0,
        sv: t, lg: 3, fr: false, cy: 'connected', ...player }], q: [{ i: 1, p: 1, sc: 0 }], ...extras,
});

test('a TCP burst updates received controls instantly but submits one newest frame per refresh', () => {
  const s = setup();
  try {
    for (let t = 1; t <= 5; t++) { s.at(t); assert.equal(s.renderer.accept(frame(t)), true); }
    assert.equal(s.renderer.snapshot.t, 5, 'controls already have newest server state');
    assert.deepEqual(s.paintTicks, [1], 'initial state is immediate; ordinary burst frames wait for the display');
    s.refresh(16.7);
    assert.deepEqual(s.paintTicks, [1, 5]);
    assert.equal(s.renderer.paintSnapshot.t, 5);
    assert.equal(s.contexts, 1, 'context requested once for its entire lifetime');
    assert.equal(s.attributes.alpha, false);
    // Cell rectangles use integers only; no between-cell coordinates invented.
    const rects = s.calls.filter(c => c.name === 'rect');
    assert.ok(rects.length >= 3);
    for (const c of rects) assert.ok(c.args.every(Number.isInteger));
  } finally { s.close(); }
});

test('authoritative tick tracking counts gaps, duplicates, stale and out-of-order frames', () => {
  const s = setup();
  try {
    assert.equal(s.renderer.accept(frame(4)), true);
    assert.equal(s.renderer.accept(frame(4)), false, 'same-tick identical state is a duplicate');
    assert.equal(s.renderer.accept(frame(2)), false, 'older state is stale/out of order');
    assert.equal(s.renderer.accept(frame(7)), true, 'a newer tick restores the authoritative stream');
    const diagnostics = s.renderer.movementDiagnostics();
    assert.equal(diagnostics.missingSnapshots, 2, 'ticks 5 and 6 were not received');
    assert.equal(diagnostics.duplicateSnapshots, 1);
    assert.equal(diagnostics.staleSnapshots, 1);
    assert.equal(s.renderer.snapshot.t, 7);
  } finally { s.close(); }
});

test('turn, freeze and death frames bypass all visual holds and remain server-owned', () => {
  const s = setup();
  try {
    s.renderer.accept(frame(1)); s.refresh(0);
    s.at(60); s.renderer.accept(frame(2));
    assert.equal(s.renderer.snapshot.t, 2, 'receipt has not been delayed');
    s.at(70); s.renderer.accept(frame(3, { d: 'up' })); s.refresh(71);
    assert.equal(s.renderer.paintSnapshot.t, 3);
    s.at(75); s.renderer.accept(frame(3, { d: 'up', fr: true, cy: 'disconnected' })); s.refresh(76);
    assert.equal(s.renderer.paintSnapshot.p[0].fr, true);
    s.at(80); s.renderer.accept(frame(4, { a: false, d: 'up' })); s.refresh(81);
    assert.equal(s.renderer.paintSnapshot.p[0].a, false);
    assert.ok(document.querySelector('ol').textContent.includes('out'), 'elimination HUD is immediate');
  } finally { s.close(); }
});

test('local steering can flush a held frame but never predicts the requested movement', () => {
  const s = setup();
  try {
    s.renderer.accept(frame(1)); s.refresh(0);
    s.at(60); const actual = frame(2); s.renderer.accept(actual);
    s.at(61); s.renderer.expedite(); s.refresh(62);
    assert.equal(s.renderer.paintSnapshot, actual);
    assert.equal(s.renderer.paintSnapshot.p[0].d, 'right', 'no invented turn');
    assert.equal(s.renderer.cadence.pending, false);
  } finally { s.close(); }
});

test('disconnect, hidden tab and rematch never replay old queued positions', () => {
  const s = setup();
  try {
    s.renderer.accept(frame(1)); s.refresh(0);
    s.at(60); s.renderer.accept(frame(2));
    s.renderer.discardPendingFrames(); s.refresh(200);
    assert.deepEqual(s.paintTicks, [1]);
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new window.Event('visibilitychange'));
    s.at(250); s.renderer.accept(frame(3)); s.refresh(300);
    assert.deepEqual(s.paintTicks, [1]);
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new window.Event('visibilitychange')); s.refresh(310);
    assert.equal(s.renderer.paintSnapshot.t, 3);
    s.renderer.reset();
    s.at(320); s.renderer.accept(frame(0, {}, { m: 100 })); s.refresh(321);
    assert.equal(s.renderer.paintSnapshot.m, 100);
    assert.equal(s.renderer.paintSnapshot.t, 0);
  } finally { s.close(); }
});

test('no pacing mode paints at the next refresh without a queued delay', () => {
  const s = setup({ enabled: false });
  try {
    s.renderer.accept(frame(1)); s.refresh(0);
    s.at(40); s.renderer.accept(frame(2)); s.refresh(41);
    assert.equal(s.renderer.paintSnapshot.t, 2);
    assert.equal(s.renderer.movementDiagnostics().cadenceEnabled, false);
    assert.equal(s.queued, 0);
  } finally { s.close(); }
});


test('HUD works on browsers without ES2025 iterator helper methods', () => {
  const prototype = Object.getPrototypeOf(Object.getPrototypeOf(new Map().values()));
  const original = Object.getOwnPropertyDescriptor(prototype, 'map');
  const s = setup({ enabled: false });
  try {
    if (original?.configurable) Object.defineProperty(prototype, 'map', { configurable: true, value: undefined });
    assert.doesNotThrow(() => s.renderer.accept(frame(1)));
    s.refresh(1);
    assert.equal(document.querySelector('ol strong').textContent, '0 pts');
  } finally {
    if (original) Object.defineProperty(prototype, 'map', original);
    s.close();
  }
});


test('mobile defaults to zero extra frame hold even on jittery arrivals', () => {
  const s = setup({ enabled: null, coarse: true });
  try {
    assert.equal(s.renderer.cadence.enabled, false);
    s.renderer.accept(frame(1));
    s.at(52); s.renderer.accept(frame(2));
    s.at(260); s.renderer.accept(frame(3));
    assert.deepEqual(s.paintTicks, [1, 2, 3], 'every RECEIVED cell frame is presented without a display queue');
    assert.equal(s.renderer.cadence.pending, false);
    assert.equal(s.queued, 0, 'rAF/watchdog adds no extra latency in default mobile mode');
    assert.equal(s.renderer.movementDiagnostics().receiveToPaintMs.max, 0);
  } finally { s.close(); }
});

test('users can still explicitly opt into smoothing bursty delivery', () => {
  const s = setup({ enabled: true, coarse: true });
  try {
    s.renderer.accept(frame(1));
    s.at(55); s.renderer.accept(frame(2));
    assert.deepEqual(s.paintTicks, [1], 'opt-in mode coalesces ordinary motion at refresh');
    s.refresh(110);
    assert.deepEqual(s.paintTicks, [1, 2]);
    s.renderer.setCadenceEnabled(false);
    s.at(152); s.renderer.accept(frame(3));
    assert.deepEqual(s.paintTicks, [1, 2, 3], 'turning pacing off restores immediate phone frames');
  } finally { s.close(); }
});
