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

test('the game log can be reordered by any column, in either direction', async () => {
  const h = makeDom('<main class="pf-layout"><aside class="pf-side" hidden><span id="pf-skin-value"></span></aside><div id="profile-root" data-username="tester"></div></main>');
  try {
    const day = (n) => new Date(Date.UTC(2026, 9, n, 12)).toISOString();
    const end = (len, cause) => ({ cols: 24, rows: 18, cause, snake: Array.from({ length: len }, (_, i) => i + 1) });
    const games = [
      { id: 1, score: 30, speed_level: 3, growth: 1, created_at: day(5), end_state: end(7, 'crash') },
      { id: 2, score: 12, speed_level: 1, growth: 2, created_at: day(9), end_state: end(3, 'quit') },
      { id: 3, score: 30, speed_level: 6, growth: 1, created_at: day(2), end_state: end(11, 'crash') },
      { id: 4, score: 4, speed_level: 4, growth: 3, created_at: day(11), end_state: end(2, 'crash') },
      { id: 5, score: 21, speed_level: 2, growth: 1, created_at: day(7), end_state: end(5, 'crash') },
      { id: 6, score: 2, speed_level: 3, growth: 1, created_at: day(1), end_state: end(2, 'quit') },
    ];
    h.w.fetch = async () => ({ ok: true, status: 200, json: async () => ({ user: {
      username: 'tester', rank: 1, total_games: games.length, is_you: true, games, created_at: day(1),
    } }) });
    h.w.eval(script('profile.js'));
    await until(() => h.d.querySelectorAll('.log__item').length > 0);

    const ids = () => [...h.d.querySelectorAll('.log__item')].map((li) => Number(li.dataset.id));
    const select = h.d.querySelector('#pf-log-sort');
    const button = h.d.querySelector('#pf-log-dir');
    const sortBy = async (value) => {
      select.value = value;
      select.dispatchEvent(new h.w.Event('change', { bubbles: true }));
      await wait(20);
    };
    const reverse = async () => {
      button.dispatchEvent(new h.w.MouseEvent('click', { bubbles: true, cancelable: true }));
      await wait(20);
    };

    assert.deepEqual([...select.options].map((o) => o.value), ['date', 'score', 'length', 'mode', 'outcome']);
    // The 2-point quit stays filtered out no matter how the list is ordered.
    assert.ok(!ids().includes(6));
    assert.deepEqual(ids(), [4, 2, 5, 1, 3], 'defaults to newest first');
    assert.match(button.textContent, /Newest first/);

    await reverse();
    assert.deepEqual(ids(), [3, 1, 5, 2, 4], 'reversed to oldest first');
    assert.match(button.textContent, /Oldest first/);

    await sortBy('score');
    assert.match(button.textContent, /Best first/, 'a new column adopts its natural direction');
    assert.deepEqual(ids(), [1, 3, 5, 2, 4], 'best first, ties broken by newest');
    await reverse();
    assert.deepEqual(ids(), [4, 2, 5, 1, 3], 'lowest first, ties still newest-first');

    await sortBy('length');
    assert.deepEqual(ids(), [3, 1, 5, 2, 4], 'longest snake first');
    await sortBy('mode');
    assert.deepEqual(
      [...h.d.querySelectorAll('.log__item .log__mode')].map((e) => e.textContent),
      ['Chill · ×2', 'Easy · ×1', 'Fast · ×3', 'Ludicrous · ×1', 'Normal · ×1'],
    );
    await sortBy('outcome');
    assert.equal(h.d.querySelector('.log__item:last-child').classList.contains('is-quit'), true);
    assert.ok(!ids().includes(6), 'the hidden quit never reappears');

    // Ordering the log must not disturb anything that reads state.games.
    assert.equal(h.d.querySelector('.pf-stat-badge__val').textContent, '6');
    assert.match(h.d.querySelector('#pf-log-count').textContent, /5 games/);
    assert.equal(h.w.localStorage.getItem('snake.logSort.v1'), 'outcome:asc');
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
});

test('mobile Arcade keeps rounded corners, fits the viewport and pads every control', () => {
  const cabinet = script('game.css');
  const mobile = cabinet.slice(cabinet.indexOf('@media (max-width: 720px)'));
  // The deck's space is reserved in every theme, so switching to Arcade does
  // not shove the settings card down the page.
  assert.match(cabinet, /@media \(max-width: 1100px\) \{\s*:root \{ --cabinet-bottom: 96px; \}/);
  assert.match(mobile, /:root \{[^}]*--cabinet-bottom: 82px;/);
  assert.match(mobile, /html\[data-theme='arcade'\] \{[^}]*--cabinet-bottom: 82px;/);
  // Nested rounding: a 24px bezel with a 4px pad needs a ~20px field, or the
  // playfield reads as a square poking into the cabinet's rounded corners.
  assert.match(mobile, /html\[data-theme='arcade'\] \{[^}]*--bezel-radius: 24px;[^}]*--field-radius: 20px;/);
  // The deck must not overhang the bezel on a phone.
  assert.match(mobile, /html\[data-theme='arcade'\] \.cabinet__deck \{\s*left: 0;\s*right: 0;/);
  // The painted button stays 24px on mobile while the hitbox reaches 44px.
  assert.match(mobile, /\.cabinet__buttons i \{ width: 24px; height: 24px; border-width: 3px; \}/);
  assert.match(mobile, /\.cabinet__buttons i::after \{ inset: -10px; \}/);
  assert.match(mobile, /\.cabinet__stick::after \{ inset: -14px -14px -10px; \}/);
  assert.match(mobile, /\.cabinet__slot::after \{ inset: -14px -8px; \}/);
  assert.match(cabinet, /\.cabinet__buttons i::after \{[\s\S]*?inset: -5px;/);
});

test('leaderboard rank, callout prose and code-copy affordances are styled', () => {
  const client = script('styles.css');
  // The rank numeral used to sit flush against the board's left edge.
  assert.match(client, /\.records th:first-child,\s*\.records td:first-child \{ padding-left: 16px; \}/);
  assert.match(client, /\.records \.rank \{[\s\S]*?width: 46px;/);
  // Block flow (not a 2-column grid) so inline <code> stays inside the sentence.
  assert.match(client, /\.callout li \{\s*position: relative;\s*display: block;\s*padding-left: 26px;/);
  assert.match(client, /\.callout li::before \{\s*content: '';\s*position: absolute;/);
  assert.match(client, /\.band__kicker \{[\s\S]*?font-family: 'Space Grotesk'/);
  assert.match(client, /\.auth-disclaimer \{/);
  assert.match(client, /\.brand__credit \{/);
  assert.match(client, /\.code-copy\.is-copied \{/);
  assert.match(client, /\.pf-autotheme \{/);
  assert.match(client, /\.pf-sort \{ display: inline-flex;/);
  assert.match(client, /\.pf-sort__dir \{/);
  assert.match(client, /\.steps h3 \.step-sub \{/);
  // A heading's trailing note must sit on the title's baseline, one word space
  // away — so the heading stays in inline flow and the note inherits its size.
  const heading = client.slice(client.indexOf('.steps h3 {'), client.indexOf('.steps h3 a {'));
  assert.doesNotMatch(heading, /display:\s*flex/, 'a flex heading forces a hard gap between title and note');
  assert.match(client, /\.steps h3 \.step-sub \{[^}]*font-size: inherit;/);
  assert.doesNotMatch(client, /\.steps h3 \.step-sub \{[^}]*margin-left/);
  // The email notice got a titled header, and the two notices now sit 16px
  // apart instead of 33px (the grid gap is 13px).
  assert.match(client, /\.auth-warning strong \{[^}]*font-weight: 600;/);
  assert.match(client, /\.auth-disclaimer \{\s*margin: 14px 0 3px;/);
  assert.match(client, /\.auth-warning \{\s*margin: 0 0 16px;/);
  assert.match(client, /\.xp-info-btn \{\s*width: 18px;\s*height: 18px;/);
});

test('both sign-in notices appear in every copy of the auth dialog', () => {
  const copies = {
    'rails game view': gameView,
    'rails shared dialog': readFileSync(new URL('../rails/app/views/shared/_auth_dialog.html.erb', import.meta.url), 'utf8'),
    'preview page': readFileSync(new URL('../src/app/page.tsx', import.meta.url), 'utf8'),
    'preview dialog': readFileSync(new URL('../src/components/auth-dialog.tsx', import.meta.url), 'utf8'),
  };
  for (const [name, text] of Object.entries(copies)) {
    const disclaimer = text.indexOf('auth-disclaimer');
    const warning = text.indexOf('auth-warning');
    assert.ok(disclaimer > -1, name + ' is missing the no-warranty disclaimer');
    assert.ok(warning > -1, name + ' is missing the email warning');
    // The disclaimer comes first, and the warning it precedes is now titled.
    assert.ok(disclaimer < warning, name + ': the disclaimer must sit above the warning');
    assert.match(text, /auth-warning["'][^>]*>\s*<strong>🔑 Warning<\/strong>/, name + ': the warning is missing its title');
    assert.match(text, /no warranty/);
  }

  // The bare-metal heading separates its note with a single plain space, and the
  // note is a classed span so it inherits the heading's colour and baseline.
  assert.match(gameView, /No containers\? Bare metal <span class="step-sub">\(I Wouldn’t personally recommend\)<\/span>/);
  assert.match(copies['preview page'], /No containers\? Bare metal <span className="step-sub">\(?I Wouldn’t personally recommend\)?<\/span>/);
});

test('the Arcade secret with the prompts link stays up for 20 seconds', async () => {
  const h = await gamePage('arcade');
  try {
    const { w, d } = h;
    const button = d.querySelector('.cabinet__buttons i[data-arcade-btn="4"]');
    const toast = () => d.getElementById('arcade-egg-toast');
    for (let press = 0; press < 5; press++) {
      button.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
      await wait(10);
    }
    assert.equal(toast().classList.contains('is-visible'), true);
    assert.match(toast().textContent, /prompts I used to make this site/);
    assert.equal(toast().classList.contains('is-long'), true, 'the link message gets the long timer');
    // Any other message keeps the 10-second default.
    button.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
    await wait(10);
    assert.equal(toast().classList.contains('is-long'), false);
    assert.doesNotMatch(toast().textContent, /prompts I used to make this site/);
  } finally { h.close(); }
});

test('code-copy falls back to execCommand when the Clipboard API is unavailable', async () => {
  const h = await gamePage();
  try {
    const { w, d } = h;
    const button = d.querySelector('pre.code + .code-copy') || d.querySelector('.code-copy');
    assert.ok(button, 'every code block gets a copy button');
    const pre = button.parentElement.querySelector('pre.code');
    const copied = [];
    // A container reached over plain HTTP has no navigator.clipboard at all.
    Object.defineProperty(w.navigator, 'clipboard', { value: undefined, configurable: true });
    w.document.execCommand = (command) => { copied.push(command); return true; };
    w.HTMLElement.prototype.focus = function () {};
    button.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
    await until(() => button.textContent !== 'Copy');
    assert.deepEqual(copied, ['copy'], 'the legacy path really ran execCommand("copy")');
    assert.equal(button.textContent, 'Copied ✓');
    assert.equal(button.classList.contains('is-copied'), true);
    // And the text handed to the clipboard is the block's own content
    // (jsdom has no innerText, which is exactly why app.js falls back).
    assert.equal(pre.innerText, undefined);
    assert.ok(pre.textContent.trim().length > 10);
  } finally { h.close(); }
});

test('auto-selecting the favorite theme is a device toggle applied at sign-in', () => {
  const profile = script('profile.js');
  const app = script('app.js');
  assert.match(profile, /var AUTO_THEME_KEY = 'snake\.autoTheme\.v1';/);
  assert.match(profile, /id="pf-theme-auto"/);
  assert.match(profile, /Auto-select my favorite theme when I sign in/);
  // The switch is only rendered on your own profile.
  const editable = profile.slice(profile.indexOf('function renderTheme'), profile.indexOf('function heatLevel'));
  assert.ok(editable.indexOf('pf-theme-auto') > editable.indexOf('if (editable) {'));
  assert.ok(editable.indexOf('pf-theme-auto') < editable.indexOf('} else {'));
  // A page load never overrides your chosen theme; only signing in does.
  assert.match(profile, /var justSignedIn = false;/);
  assert.match(profile, /if \(!justSignedIn\) return;/);
  assert.match(app, /function maybeAutoTheme\(\) \{\s*if \(!authUser \|\| !autoThemeWanted\(\)\) return;/);
  assert.match(app, /loadBoard\(\);\s*maybeAutoTheme\(\);/);
});

test('both self-host sections carry the new wording, disclaimers and real compose file', () => {
  const page = readFileSync(new URL('../src/app/page.tsx', import.meta.url), 'utf8');
  const compose = readFileSync(new URL('../compose.yaml', import.meta.url), 'utf8');
  for (const text of [gameView, page]) {
    assert.match(text, /Host this website/);
    assert.match(text, /This comes with no warranty/);
    assert.match(text, /accidentally delete your user data/);
    assert.match(text, /Made almost entirely with/);
    assert.match(text, /https:\/\/arena\.ai/);
    assert.match(text, /https:\/\/podman\.io\/docs\/installation/);
    assert.match(text, /https:\/\/docs\.docker\.com\/engine\/install/);
    assert.match(text, /git clone https:\/\/github\.com\/HelloJesusBeloved\/next-level-snake/);
    assert.match(text, /cd \.\/next-level-snake/);
    assert.match(text, /sed -i "s\/\^SECRET_KEY_BASE=\.\*\/SECRET_KEY_BASE=\$\(openssl rand -hex 64\)\/" \.env/);
    assert.match(text, /\(I Wouldn.t personally recommend\)/);
    assert.doesNotMatch(text, /open http:\/\/localhost:3000/);
    assert.doesNotMatch(text, /github\.com\/your-org\/snake/);
    // The published compose block is the file that actually ships. The TSX
    // source escapes ${ for its template literal, so compare the rendered form.
    const rendered = text.replace(/\\\$\{/g, '${');
    for (const line of compose.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      assert.ok(rendered.includes(trimmed), 'compose.yaml line missing from the page: ' + trimmed);
    }
  }
});