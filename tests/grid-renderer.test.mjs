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


// ---- step 2: local prediction inside the renderer -------------------------
// These cover the RENDERER's side of Responsive Brawl: which cells get painted,
// that remote snakes and the scoreboard stay authoritative, that Classic is
// byte-for-byte the old path, and that a reset/destroy leaves nothing running.

const settle = (h, frame1) => { h.at(0); h.renderer.accept(frame1); h.refresh(0); };

test('classic Brawl paints the authoritative frame object and never a predicted one', () => {
  const h = setup({ enabled: false });
  const first = frame(0);
  settle(h, first);
  assert.equal(h.renderer.local, null, 'no predictor exists until a match is Responsive');
  assert.equal(h.renderer.paintOverride, null, 'nothing is substituted for Classic');
  assert.equal(h.renderer.localDisplay, false);
  assert.deepEqual(h.renderer.paintSnapshot.p[0].b, first.p[0].b);
  assert.equal(h.renderer.movementDiagnostics().prediction, null,
    'classic diagnostics do not claim a prediction state');
  h.at(10_000);
  assert.equal(h.renderer.paintSnapshot.p[0].b[0], 3, 'Classic advances only on a server frame');
  h.close();
});

test('responsive paints predicted cells for the own snake and authoritative cells for everyone else', () => {
  const h = setup({ enabled: false });
  const remote = { i: 2, n: 'P2', c: '#0000FF', b: [100, 99, 98], l: 3, a: true, d: 'left', sc: 4,
                   sv: 0, lg: 3, fr: false, cy: 'connected' };
  const base = frame(0);
  const first = { ...base, p: [base.p[0], remote], tick_ms: 105 };
  h.renderer.setPredictionMode({ active: true, source: 'server', testOnly: false },
    { columns: 24, rows: 18, mode: 'brawl', presentation_strategy: 'responsive' });
  assert.equal(h.renderer.local.enabled, true);
  settle(h, first);
  assert.equal(h.renderer.local.active, true, 'a running, alive, unfrozen snake may be predicted');
  // The player presses: locally immediate, still unconfirmed.
  assert.equal(h.renderer.predict('down', 1).rejectedReason, null);
  // Two refreshes: the first establishes the predictor's monotonic phase, the
  // second crosses one logical tick. That is the fixed-step contract — a tick
  // boundary is defined by elapsed time, not by how many frames were drawn.
  h.at(105); h.refresh(105);
  h.at(210); h.refresh(210);
  assert.ok(h.renderer.local.summary().predictedTicks >= 1, 'the local view ran a tick');
  const painted = h.renderer.paintOverride;
  assert.ok(painted, 'a predicted display frame is in use');
  assert.notEqual(painted.p[0].b[0], h.renderer.paintSnapshot.p[0].b[0],
    'the own snake moved locally before the server agreed');
  assert.equal(painted.p[0].pr, 1, 'the substituted cells are marked as predicted');
  assert.equal(painted.p[1].b[0], 100, 'remote snakes are painted from the authoritative frame only');
  assert.deepEqual(painted.p[1], remote, 'remote player is the identical object, untouched');
  assert.equal(h.renderer.paintSnapshot.p[0].b[0], 3,
    'the authoritative snapshot stays authoritative for HUD, scoreboard and results');
  assert.equal(h.renderer.movementDiagnostics().prediction.painted, true);
  h.close();
});

test('disarming restores the classic paint path exactly, and reset drops unconfirmed inputs', () => {
  const h = setup({ enabled: false });
  const first = frame(0);
  first.tick_ms = 105;
  h.renderer.setPredictionMode({ active: true, source: 'test', testOnly: true }, { columns: 24, rows: 18 });
  settle(h, first);
  h.renderer.predict('down', 1);
  h.at(105); h.refresh(105);
  assert.ok(h.renderer.paintOverride, 'predicted frame while armed');
  assert.ok(h.renderer.local.summary().pending >= 1);
  // A reconnect seed: nothing may survive the gap.
  h.renderer.resetPrediction({ reconnect: true });
  assert.equal(h.renderer.local.summary().pending, 0, 'obsolete predictions are discarded');
  assert.ok(h.renderer.local.summary().resetForReconnect >= 1);
  assert.equal(h.renderer.paintOverride, null, 'no stale substituted frame is left painted');
  // Step 2 stays unreachable for players: disarming must return Classic verbatim.
  h.renderer.setPredictionMode({ active: false, source: 'off' });
  assert.equal(h.renderer.paintOverride, null);
  assert.equal(h.renderer.localDisplay, false);
  assert.equal(h.renderer.local.enabled, false);
  h.at(500); h.refresh(500);
  assert.equal(h.renderer.paintSnapshot.p[0].b[0], 3, 'only a server frame can move it again');
  h.close();
});

test('the prediction loop never outlives the renderer', () => {
  const h = setup({ enabled: false });
  h.renderer.setPredictionMode({ active: true, source: 'server' }, { columns: 24, rows: 18 });
  settle(h, frame(0));
  assert.ok(h.queued >= 1, 'the loop is scheduled while armed');
  // close() asserts destroy() left zero queued repaints: the loop must be cancelled.
  h.close();
});


// ---- step 3: buffered remote playback inside the renderer ------------------
// These prove the two halves of Responsive Brawl stay separate: this player's
// snake is painted from prediction, every other snake from the confirmed
// playback buffer, and Classic paints the server frame untouched.

const boardFrame = (t, { own = [30, 29, 28], remote = [100, 99, 98], extra = {} } = {}) => ({
  v: 1, type: 'snapshot', m: 7, s: 'running', t, b: { c: 24, r: 18 }, f: [], tick_ms: 100,
  p: [
    { i: 1, n: 'P1', c: '#00FF00', b: own, l: own.length, a: true, d: 'right', sc: 0, sv: t, lg: 3, fr: false, cy: 'connected' },
    { i: 2, n: 'P2', c: '#0000FF', b: remote, l: remote.length, a: true, d: 'right', sc: 3, sv: t, lg: 3, fr: false, cy: 'connected' }
  ],
  q: [{ i: 1, p: 1, sc: 0 }, { i: 2, p: 2, sc: 3 }], ...extra
});

function responsiveRenderer(h) {
  h.renderer.setPredictionMode({ active: true, source: 'server', testOnly: false },
    { columns: 24, rows: 18, mode: 'brawl', presentation_strategy: 'responsive' });
  h.renderer.local?.enable('responsive');
  return h.renderer;
}

test('responsive arms a playback buffer; classic never creates one', () => {
  const classic = setup({ enabled: false });
  classic.renderer.accept(boardFrame(0));
  assert.equal(classic.renderer.playback, null, 'Classic allocates no playback state at all');
  assert.equal(classic.renderer.smoothPlayers(), null);
  assert.equal(classic.renderer.movementDiagnostics().playback, null);
  classic.close();

  const h = setup({ enabled: false });
  const r = responsiveRenderer(h);
  assert.ok(r.playback, 'Responsive owns a playback buffer');
  assert.equal(r.playback.enabled, true);
  // Prediction and playback are separate objects with separate state.
  assert.notEqual(r.local, r.playback);
  h.close();
});

test('a compact movement frame extends remote bodies and never touches the own snake', () => {
  const h = setup({ enabled: false });
  const r = responsiveRenderer(h);
  const first = boardFrame(0);
  r.accept(first);
  const ownBefore = r.snapshot.p[0].b.slice();
  // The server's compact frame: heads, lengths and scalars only.
  const added = r.acceptMovement({
    v: 1, type: 'movement', m: 7, s: 'running', t: 1, ts: 1000,
    f: [], p: [
      { i: 1, h: 31, d: 'right', l: 3, sc: 0, a: true, fr: false, cy: 'connected', is: 1, it: 1 },
      { i: 2, h: 101, d: 'right', l: 3, sc: 3, a: true, fr: false, cy: 'connected', is: 0, it: null }
    ]
  });
  assert.ok(added, 'the frame rebuilt both bodies');
  const stored = r.playback.byTick.get(1);
  assert.deepEqual(stored.players.get(1).cells, [31, 30, 29], 'own body follows the confirmed head');
  assert.deepEqual(stored.players.get(2).cells, [101, 100, 99], 'remote body follows its confirmed head');
  assert.equal(r.playback.summary().reconstructed, 2);
  // The rebuilt frame is a COMPLETE confirmed state for tick 1 (the Rails
  // movement_protocol_test proves reconstruction is lossless), and it is handed
  // back so the caller can route it through the snapshot path: that is what
  // keeps prediction, the input tick and the HUD current on every tick instead
  // of only on the periodic complete snapshot.
  assert.equal(added.type, 'snapshot');
  assert.equal(added.reconstructed, true);
  assert.equal(added.t, 1);
  assert.deepEqual(added.p[0].b, [31, 30, 29]);
  assert.equal(added.p[0].is, 1, 'applied-input fields survive for reconciliation');
  assert.equal(added.p[0].c, first.p[0].c, 'colour carried from the last complete frame');
  assert.equal(added.p[1].sc, 3, 'scores come from the movement frame');
  // Until the caller routes it, the renderer's own state is untouched...
  assert.deepEqual(r.snapshot.p[0].b, ownBefore);
  // ...and once it does, the frame is accepted like any snapshot WITHOUT being
  // pushed into playback a second time.
  const framesBefore = r.playback.summary().frames;
  assert.equal(r.accept(added), true);
  assert.equal(r.snapshot.t, 1);
  assert.equal(r.playback.summary().frames, framesBefore, 'a materialised frame is not re-seeded into playback');
  assert.equal(r.local?.confirmed?.tick ?? 1, 1, 'the predictor was reconciled on the rebuilt tick');
  h.close();
});

test('a refused movement frame asks the server for a snapshot instead of guessing', () => {
  const h = setup({ enabled: false });
  const requests = [];
  h.renderer.onResyncNeeded = (reason) => requests.push(reason);
  const r = responsiveRenderer(h);
  // No seed snapshot yet, so nothing can be reconstructed.
  assert.equal(r.acceptMovement({ v: 1, type: 'movement', m: 7, t: 4, p: [{ i: 1, h: 5, l: 3 }] }), false);
  assert.ok(requests.length >= 1, 'the renderer must ask for an authoritative frame');
  assert.equal(r.playback.summary().frames, 0, 'nothing invented is stored');
  h.close();
});

test('resync requests are throttled so a bad link cannot become a request storm', () => {
  const h = setup({ enabled: false });
  const requests = [];
  h.renderer.onResyncNeeded = () => requests.push(1);
  const r = responsiveRenderer(h);
  for (let index = 0; index < 5; index += 1) r.requestResync('test');
  assert.equal(requests.length, 1, 'one request per interval');
  h.close();
});

test('remote playback is drawn only for remote players, with continuous coordinates', () => {
  const h = setup({ enabled: false });
  const r = responsiveRenderer(h);
  // Three adjacent confirmed ticks: interpolation needs a NEXT tick that exists.
  r.accept(boardFrame(0));
  r.accept(boardFrame(1, { own: [31, 30, 29], remote: [101, 100, 99] }));
  r.accept(boardFrame(2, { own: [32, 31, 30], remote: [102, 101, 100] }));
  // Drive the shared animation loop and record every sample. The FINAL sample is
  // legitimately a hold once the fixture's last frame has been reached, so the
  // interpolation assertion is made over the samples that had history ahead of
  // them — which is the case the feature exists for.
  const samples = [];
  for (let at = 0; at <= 240; at += 20) {
    h.at(at);
    h.refresh(at);
    if (r.lastPlaybackSample) samples.push(r.lastPlaybackSample);
  }
  assert.ok(samples.length > 0, 'the loop produced playback samples');
  const interpolated = samples.filter((sample) => sample.interpolated && sample.players?.get(2)?.smooth);
  assert.ok(interpolated.length > 0, 'the remote snake must be interpolated between confirmed ticks');
  const remote = interpolated[0].players.get(2);
  for (const segment of remote.smooth) {
    if (!segment.smooth) continue;
    assert.ok(Number.isFinite(segment.x) && Number.isFinite(segment.y));
    // Never more than the single cell the confirmed tick actually moved.
    assert.ok(Math.abs(segment.x - (segment.from % 24)) <= 1);
    assert.ok(Math.abs(segment.y - Math.floor(segment.from / 24)) <= 1);
  }
  // And once history runs out the board holds a confirmed state rather than
  // continuing to move on its own.
  const last = samples.at(-1);
  assert.equal(last.interpolated, false);
  assert.ok(last.players?.get(2), 'a real confirmed body is still displayed');
  h.close();
});

test('classic keeps painting server cells: no playback draw path is taken', () => {
  const h = setup({ enabled: false });
  h.renderer.accept(boardFrame(0));
  h.at(100); h.renderer.accept(boardFrame(1, { remote: [101, 100, 99] }));
  h.at(500); h.refresh(500);
  assert.equal(h.renderer.smoothPlayers(), null);
  assert.equal(h.renderer.playbackDraws, 0, 'Classic never runs an interpolation-only draw');
  assert.deepEqual(h.renderer.paintSnapshot.p[1].b, [101, 100, 99],
    'the remote body painted is the confirmed one, verbatim');
  h.close();
});

test('reconnect and destroy drop remote history without breaking the renderer', () => {
  const h = setup({ enabled: false });
  const r = responsiveRenderer(h);
  r.accept(boardFrame(0));
  r.accept(boardFrame(1, { remote: [101, 100, 99] }));
  assert.ok(r.playback.frames.length > 0);
  r.resetPrediction({ reconnect: true });
  assert.equal(r.playback.frames.length, 0, 'stale confirmed history is discarded');
  assert.equal(r.playback.byTick.size, 0);
  assert.equal(r.lastPlaybackSample, null);
  // A fresh seed then rebuilds it, and the renderer still works.
  r.accept(boardFrame(5, { remote: [120, 119, 118] }));
  assert.equal(r.playback.frames.length, 1);
  h.close();
});


test('diagnostics differ by strategy in the way the brief asks for', () => {
  // The same confirmed frames, replayed once as Classic and once as Responsive.
  const frames = [
    boardFrame(0), boardFrame(1, { remote: [101, 100, 99] }), boardFrame(2, { remote: [102, 101, 100] })
  ];
  const run = (responsive) => {
    const h = setup({ enabled: false });
    if (responsive) responsiveRenderer(h);
    for (const [index, frame] of frames.entries()) { h.at(index * 100); h.renderer.accept(frame); }
    h.at(300);
    for (let at = 300; at <= 500; at += 20) h.refresh(at);
    const d = h.renderer.movementDiagnostics();
    h.close();
    return d;
  };
  const classic = run(false);
  const responsive = run(true);

  // Classic: no prediction, no playback, and it says so instead of showing zeros
  // that could be mistaken for measurements.
  assert.equal(classic.prediction, null);
  assert.equal(classic.playback, null);

  // Responsive: every block the brief lists is present and self-labelled.
  assert.ok(responsive.prediction, 'prediction is reported');
  assert.ok(responsive.playback, 'playback is reported');
  assert.ok(Number.isInteger(responsive.prediction.confirmedTick));
  assert.ok(Number.isInteger(responsive.prediction.predictedTick));
  assert.ok(Number.isInteger(responsive.prediction.pending));
  assert.ok(Number.isInteger(responsive.prediction.corrections));
  assert.ok(Number.isInteger(responsive.prediction.maxCorrectionCells));
  // Remote playback delay / buffer / underruns / resyncs.
  assert.ok(Number.isInteger(responsive.playback.delayMs));
  assert.ok(Number.isInteger(responsive.playback.targetDelayMs));
  assert.ok(Number.isInteger(responsive.playback.buffered));
  assert.ok(Number.isInteger(responsive.playback.underruns));
  assert.ok(Number.isInteger(responsive.playback.missingTicks));
  assert.ok(Number.isInteger(responsive.playback.resyncs));
  // Measured vs estimated are not mixed together.
  assert.ok(responsive.playback.measured && responsive.playback.estimated);
  assert.deepEqual(Object.keys(responsive.playback.measured).sort(),
    ['buffered', 'delayMs', 'jitterMs']);
  // Canvas cost is tracked for both, and playback draws are only counted when
  // playback actually painted.
  assert.equal(classic.playback, null);
  assert.ok(responsive.playback.playbackDraws >= 0);
  assert.ok(responsive.playback.playbackDrawCostMs >= 0);
});
