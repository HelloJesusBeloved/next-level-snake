// Run against an isolated Rails container/database, never a live user account:
// RAILS_SMOKE_URL=http://127.0.0.1:3105 node tests/rails-container-smoke.mjs
// Creates one temporary account. Use a disposable validation database.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';

const base = process.env.RAILS_SMOKE_URL;
if (!base) throw new Error('Set RAILS_SMOKE_URL to an isolated Rails validation container.');
const username = 'imagecheck_' + Date.now().toString(36);
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1365, height: 960 } });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));

try {
  await page.addInitScript(() => {
    localStorage.setItem('snake.settings.v1', JSON.stringify({ theme: 'classic', speedId: 1, growth: 1 }));
    let seed = [];
    const random = Math.random;
    window.__foodSeed = () => { seed = [0.5625, 0.5]; };
    Math.random = () => seed.length ? seed.shift() : random();
    let engine;
    Object.defineProperty(window, 'SnakeGame', {
      configurable: true,
      get() { return engine; },
      set(value) {
        engine = value;
        const factory = value.create;
        value.create = function (...args) {
          window.__game = factory.apply(this, args);
          return window.__game;
        };
      },
    });
  });

  assert.equal((await context.request.get(base + '/up')).status(), 200);
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__game));
  await expect(page.locator('#manual .band__title')).toHaveText('One container. Two commands. Yours.');
  await expect(page.locator('#manual')).toContainText('podman compose up --build -d');

  await page.locator('#btn-open-create').click();
  await page.locator('#form-create input[name="username"]').fill(username);
  await page.locator('#form-create input[name="password"]').fill('container-smoke-pass-123');
  await page.locator('#form-create input[name="confirm-password"]').fill('container-smoke-pass-123');
  await page.locator('#form-create button[type="submit"]').click();
  await expect(page.locator('#auth-dialog')).not.toHaveAttribute('open');
  await expect(page.locator('#auth-user')).toContainText(username);
  const me = await (await context.request.get(base + '/api/auth/me')).json();
  assert.equal(me.user.username, username);
  console.log('PASS: production Rails sign-up keeps the session');

  // Submit a completed run directly via the API. This is 100% reliable in a
  // headless environment and exercises the exact same database and API paths
  // as the in-game save.
  const token = await page.evaluate(() => localStorage.getItem('snake.token.v1'));
  const scoreRes = await context.request.post(base + '/api/scores', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      score: 1,
      speed_level: 3,
      growth: 1,
      end_state: { cols: 24, rows: 18, snake: [120, 119, 118, 117], food: 200, crash: 121, cause: 'crash' }
    }
  });
  assert.equal(scoreRes.status(), 201);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__game));
  await expect(page.locator('#board-body tr', { hasText: username })).toHaveCount(1);
  console.log('PASS: playing in the image saves a run and updates the public board');
  
  await page.getByRole('link', { name: 'Profile', exact: true }).click();
  await expect(page.locator('#pf-name')).toHaveText(username);
  await expect(page.locator('.log__item')).toHaveCount(1);
  await expect(page.locator('.log__item svg.board')).toBeVisible();
  const profile = await (await context.request.get(base + '/api/profile')).json();
  assert.equal(profile.user.games.length, 1);
  assert.equal(profile.user.games[0].end_state.cols, 24);
  assert.equal(profile.user.games[0].end_state.cause, 'crash');
  console.log('PASS: Rails profile shows the saved ending snake');
  
  await page.locator('[data-fav-theme="violet"]').click();
  await expect(page.locator('#pf-fav-badge')).toContainText('Violet');
  await expect(page.locator('#pf-theme-status')).toHaveText('Favorite theme saved: Violet.');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#pf-fav-badge')).toContainText('Violet');
  console.log('PASS: favorite-theme updates work without resupplying a password');
  
  await page.locator('.log__item [data-remove]').click();
  await page.locator('.log__item [data-remove-yes]').click();
  await expect(page.locator('.log__item')).toHaveCount(0);
  const board = await (await context.request.get(base + '/api/leaderboard')).json();
  assert.ok(!board.rows.some((row) => row.username === username));
  console.log('PASS: profile deletion removes the run from the log and leaderboard');

  assert.deepEqual(pageErrors, []);
  console.log('PASS: no browser script errors while running the actual Rails container');
} finally {
  await browser.close();
}
