import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const script = (name) => readFileSync(new URL('../public/' + name, import.meta.url), 'utf8');
const gameView = readFileSync(new URL('../rails/app/views/snake/index.html.erb', import.meta.url), 'utf8')
  .replace(/<%[\s\S]*?%>/g, '');
const wait = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(fn) {
  for (let n = 0; n < 50; n++) {
    if (fn()) return;
    await wait(20);
  }
  assert.fail('Timed out waiting for the shared game to boot');
}

function makeDom(markup) {
  const dom = new JSDOM('<!doctype html><html data-theme="classic"><body>' + markup + '</body></html>', {
    url: 'http://localhost:3000/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window: w } = dom;
  let paints = 0;
  const ctx = new Proxy({}, {
    get(_, key) {
      if (key === 'fillRect') return () => { paints++; };
      return () => {};
    },
    set() { return true; },
  });
  w.HTMLCanvasElement.prototype.getContext = () => ctx;
  w.HTMLElement.prototype.getBoundingClientRect = () => ({
    x: 0, y: 100, width: 400, height: 300, top: 100, bottom: 400, left: 0, right: 400,
  });
  w.scrollTo = () => {};
  w.MatrixRain = { set() {} };
  w.HTMLElement.prototype.setPointerCapture = () => {};
  w.HTMLElement.prototype.hasPointerCapture = () => false;
  w.HTMLElement.prototype.releasePointerCapture = () => {};
  return { dom, w, d: w.document, paints: () => paints };
}

async function gamePage(theme = 'classic', signedIn = false) {
  const harness = makeDom(gameView);
  const { w } = harness;
  const posts = [];
  const json = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
  w.fetch = async (url, options = {}) => {
    if (url.startsWith('/api/scores')) {
      if (options.method === 'POST') {
        posts.push(JSON.parse(options.body));
        return json({ ok: true, best: {} }, 201);
      }
      return json({ best: {} });
    }
    if (url.startsWith('/api/leaderboard')) return json({ board: 'standard', total: 0, rows: [] });
    if (url === '/api/auth/me') return json({ user: signedIn ? { username: 'tester' } : null });
    return json({});
  };
  w.localStorage.setItem('snake.settings.v1', JSON.stringify({ theme, speedId: 3, growth: 1 }));
  w.eval(script('game.js'));
  const create = w.SnakeGame.create;
  w.SnakeGame.create = (...args) => {
    const game = create(...args);
    harness.game = game;
    const on = game.on;
    game.on = function (name, handler) {
      if (name === 'gameover') harness.gameover = handler;
      return on.call(game, name, handler);
    };
    return game;
  };
  w.eval(script('app.js'));
  await until(() => harness.game && harness.gameover);
  return { ...harness, posts, close: () => { harness.game.destroy(); harness.dom.window.close(); } };
}

function nativeTap(w, node, id) {
  const pointer = new w.Event('pointerdown', { bubbles: true, cancelable: true });
  Object.assign(pointer, { pointerType: 'touch', pointerId: id, button: 0, clientX: 50, clientY: 160 });
  node.dispatchEvent(pointer);
  const touch = new w.Event('touchstart', { bubbles: true, cancelable: true });
  Object.defineProperty(touch, 'touches', { value: [{ identifier: id, clientX: 50, clientY: 160 }] });
  node.dispatchEvent(touch);
  node.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
}

function finalState(score, cause) {
  return {
    score, useCustomSpeed: false, speedPreset: 3, speedMs: 105,
    useCustomGrowth: false, growthPreset: 1, growth: 1,
    endState: { cause, cols: 24, rows: 18, snake: [228, 227, 226], food: 100, crash: cause === 'crash' ? 229 : null },
  };
}

test('mobile Terminal taps code on the box, but Start always starts the game', async () => {
  const h = await gamePage('terminal');
  try {
    const { w, d, game } = h;
    nativeTap(w, d.querySelector('#panel-start .panel__title'), 1);
    assert.equal(game.isHacking(), true, 'a tap on the overlay still reaches the box');
    const firstScore = game.state().score;
    assert.equal(firstScore, 1, 'pointer/touch/click from one tap counts only once');
    nativeTap(w, d.querySelector('.snake-canvas'), 2);
    assert.equal(game.state().score, 2, 'a second fast tap is not swallowed');
    nativeTap(w, d.querySelector('#btn-start'), 3);
    assert.equal(game.state().running, true, 'the Start button starts a run');
    assert.equal(game.isHacking(), false, 'Start never types another code chunk');
  } finally { h.close(); }
});

test('leaving Terminal after typing restores the normal score', async () => {
  const h = await gamePage('terminal');
  try {
    nativeTap(h.w, h.d.querySelector('#panel-start .panel__title'), 1);
    assert.equal(h.game.state().score, 1);
    h.d.querySelector('#settings-theme button[data-theme="arcade"]').click();
    assert.equal(h.game.isHacking(), false);
    assert.equal(h.game.state().score, 0);
    assert.equal(h.d.querySelector('#current-score').textContent, '0');
    h.d.querySelector('#settings-theme button[data-theme="terminal"]').click();
    assert.equal(h.d.querySelector('#current-score').textContent, '0');
  } finally { h.close(); }
});

test('only quits above 10 points are recorded; logged quits do not set records', async () => {
  const h = await gamePage('classic', true);
  try {
    for (const score of [0, 10]) h.gameover(finalState(score, 'quit'));
    assert.equal(h.posts.length, 0, 'short quits are never sent to Rails');
    assert.equal(JSON.parse(h.w.localStorage.getItem('snake.runs.v1') || '[]').length, 0);
    assert.equal(h.d.querySelector('#final-flag').hidden, true);

    h.gameover(finalState(11, 'quit'));
    await until(() => h.posts.length === 1);
    await until(() => h.d.querySelector('#final-save-text').textContent.includes('Saved to your game log'));
    assert.equal(h.posts[0].end_state.cause, 'quit');
    assert.equal(h.d.querySelectorAll('#recent-runs .runs__item').length, 1);
    assert.match(h.d.querySelector('#recent-runs').textContent, /Quit/);
    assert.equal(h.d.querySelector('#final-flag').hidden, true);
    assert.equal(h.d.querySelector('#best-score').textContent, '\u2014');

    h.gameover(finalState(1, 'crash'));
    await until(() => h.posts.length === 2);
    await until(() => h.d.querySelector('#final-save-text').textContent.includes('Saved to the leaderboard'));
    assert.equal(h.d.querySelectorAll('#recent-runs .runs__item').length, 2);
    assert.equal(h.d.querySelector('#mode-stats').textContent.includes('Played 1'), true);
  } finally { h.close(); }
});

test('joystick captures the gesture and suppresses native dragging', async () => {
  const h = await gamePage('arcade');
  try {
    const stick = h.d.querySelector('.cabinet__stick');
    const frame = h.d.querySelector('.snake-frame');
    const down = new h.w.Event('pointerdown', { bubbles: true, cancelable: true });
    Object.assign(down, { pointerId: 1, button: 0, clientX: 100, clientY: 140 });
    stick.dispatchEvent(down);
    assert.equal(down.defaultPrevented, true);
    assert.equal(stick.classList.contains('is-grabbed'), true);
    const drag = new h.w.Event('dragstart', { bubbles: true, cancelable: true });
    frame.dispatchEvent(drag);
    assert.equal(drag.defaultPrevented, true);
    const move = new h.w.Event('pointermove', { bubbles: true, cancelable: true });
    Object.assign(move, { pointerId: 1, clientX: 130, clientY: 140 });
    h.w.dispatchEvent(move);
    assert.notEqual(stick.style.getPropertyValue('--stick-rot'), '');
    const up = new h.w.Event('pointerup');
    Object.assign(up, { pointerId: 1 });
    h.w.dispatchEvent(up);
    assert.equal(stick.classList.contains('is-grabbed'), false);
  } finally { h.close(); }
});

test('the running snake advances without another key, including custom speed zero', async () => {
  const h = await gamePage();
  try {
    h.game.setCustomSpeed(0);
    assert.equal(h.game.start(), true);
    const before = h.paints();
    await wait(270);
    assert.ok(h.paints() > before + 10, 'the game loop must continue without further input');
    assert.equal(h.game.state().running, true);
  } finally { h.close(); }
});

test('profile total and log count only qualifying quits, not XP or completed stats', async () => {
  const h = makeDom('<main class="pf-layout"><aside class="pf-side" hidden><span id="pf-skin-value"></span></aside><div id="profile-root" data-username="tester"></div></main>');
  try {
    const now = new Date().toISOString();
    const games = [
      { id: 1, score: 4, speed_level: 3, growth: 1, created_at: now, end_state: { cause: 'crash' } },
      { id: 2, score: 10, speed_level: 4, growth: 2, created_at: now, end_state: { cause: 'quit' } },
      { id: 3, score: 11, speed_level: 4, growth: 2, created_at: now, end_state: { cause: 'quit' } },
      { id: 4, score: 12, speed_level: 4, growth: 2, created_at: now, end_state: { cause: 'quit' } },
    ];
    h.w.fetch = async () => ({ ok: true, status: 200, json: async () => ({ user: {
      username: 'tester', rank: 1, total_games: 3, is_you: false, games, created_at: now,
    } }) });
    h.w.eval(script('profile.js'));
    await until(() => h.d.querySelectorAll('.log__item').length === 3);
    assert.equal(h.d.querySelector('.pf-stat-badge__val').textContent, '3');
    assert.equal(h.d.querySelectorAll('.log__item.is-quit').length, 2);
    assert.match(h.d.querySelector('#pf-log-mode').textContent, /Fast/);
    assert.equal(h.d.querySelector('[data-stat="avg"] .pf-tile__value').textContent, '4');
    assert.match(h.d.querySelector('.pf-level__xp').textContent, /^4 XP/);
  } finally { h.dom.window.close(); }
});

test('Rails enforces the >10 quit threshold and excludes quits from best scores', () => {
  const model = readFileSync(new URL('../rails/app/models/score.rb', import.meta.url), 'utf8');
  const profile = readFileSync(new URL('../rails/app/controllers/api/profile_controller.rb', import.meta.url), 'utf8');
  const client = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  const cabinet = script('game.css');
  assert.match(model, /scope :recorded, .*score > 10/);
  assert.match(model, /validate_quit_score!/);
  assert.match(model, /best_per_combo, lambda \{\s*completed\.select/);
  assert.match(model, /FROM scores\s+WHERE end_state IS NULL OR COALESCE\(end_state->>'cause', ''\) <> 'quit'/);
  assert.match(profile, /user\.scores\.recorded\.count/);
  assert.match(client, /body\.has-run \.pausebar \{ display: flex; \}/);
  assert.match(cabinet, /@media \(max-width: 1100px\) \{\s*:root \{ --cabinet-bottom: 96px; \}/);
  assert.match(cabinet, /@media \(max-width: 720px\) \{\s*:root \{[^}]*--cabinet-bottom: 70px;/);
});