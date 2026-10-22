import { test, expect } from '@playwright/test';

// Point PLAYWRIGHT_BASE_URL at the real Rails app, not the src/ preview.
// No API mocks, account creation, score submissions, or database writes.
const themes = ['classic', 'arcade', 'vintage', 'terminal', 'paper', 'violet', 'sunsetfire'];
const navLink = (page, name) => page.getByRole('navigation', { name: 'Main navigation' })
  .getByRole('link', { name, exact: true });
const activate = (link, isMobile) => isMobile ? link.tap() : link.click();

test('Rails serves both original game routes and the separate multiplayer page', async ({ request }) => {
  for (const path of ['/', '/play', '/multiplayer']) {
    const response = await request.get(path);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/html');
    const html = await response.text();
    expect(html).toContain('name="csrf-token"'); // Rails layout, not a preview fallback.
    expect(html).toContain(path === '/multiplayer' ? 'id="multiplayer-root"' : 'id="snake-root"');
  }
  for (const asset of ['/multiplayer/page.js', '/multiplayer/lobby.js', '/multiplayer/actioncable.esm.js']) {
    const module = await request.get(asset);
    expect(module.status()).toBe(200);
    expect(module.headers()['content-type']).toMatch(/javascript/);
  }
  const css = await request.get('/multiplayer/lobby.css');
  expect(css.status()).toBe(200);
  expect(css.headers()['content-type']).toContain('text/css');
});

test('an invitation URL opens the page on that room code', async ({ request }) => {
  const created = await request.post('/api/rooms', {
    headers: { 'Content-Type': 'application/json' },
    data: { display_name: 'LinkTester' },
  });
  expect(created.status()).toBe(201);
  const { room } = await created.json();

  const page = await request.get(`/multiplayer/${room.code}`);
  expect(page.status()).toBe(200);
  const html = await page.text();
  expect(html).toContain(`data-room-code="${room.code}"`);
  expect(html).toContain('id="multiplayer-root"');

  // Unknown codes still render the lobby; the page explains the failure.
  expect((await request.get('/multiplayer/ZZZZZZZZZZZZ')).status()).toBe(200);
});

for (const entry of ['/', '/play']) {
  test(`${entry} links to multiplayer and back to the original game`, async ({ page, isMobile }) => {
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(entry);
    await expect(navLink(page, 'Multiplayer')).toHaveAttribute('href', '/multiplayer');
    await activate(navLink(page, 'Multiplayer'), isMobile);
    await expect(page).toHaveURL(/\/multiplayer$/);
    await expect(page).toHaveTitle('Multiplayer — Next Level Snake');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Multiplayer');
    await expect(navLink(page, 'Multiplayer')).toHaveCount(0);
    await activate(navLink(page, 'Single Player'), isMobile);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('#snake-root .snake-canvas')).toBeVisible();
    await expect(page.locator('#btn-start')).toBeVisible();
    await page.goBack();
    await expect(page.locator('#multiplayer-root')).toBeVisible();
    await page.goForward();
    await expect(page.locator('#btn-start')).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('the lobby is real, but no gameplay is faked', async ({ page }) => {
  const sockets = [];
  const apiPaths = new Set();
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith('/api/')) apiPaths.add(pathname.replace(/\/[A-Z0-9]{12}(?=\/|$)/, '/:code'));
  });
  page.on('websocket', (socket) => sockets.push(socket.url()));

  await page.goto('/multiplayer');
  await expect(page.locator('#mp-entry')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create room' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Join room' })).toBeVisible();
  // Sign In / Create Account: in the header AND under the display name.
  await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Create account' })).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Sign in' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' }).last()).toBeVisible();

  // No single-player engine and no canvas game anywhere on this page.
  // No socket yet either: connections are opened only for seated members.
  await expect(page.locator('#snake-root, .snake-canvas, #btn-start')).toHaveCount(0);
  await expect(page.locator('script[src^="/game.js"], script[src^="/app.js"], script[src^="/profile.js"]')).toHaveCount(0);
  expect(await page.evaluate(() => typeof window.SnakeGame)).toBe('undefined');
  expect(sockets).toEqual([]);

  // The lobby talks only to the room API.
  await expect.poll(() => [...apiPaths]).toContain('/api/rooms/current');
  expect([...apiPaths].every((path) => path.startsWith('/api/rooms'))).toBe(true);
});

test('a guest creates a room, wears the crown, and a friend joins by link', async ({ page, browser }) => {
  await page.goto('/multiplayer');
  await page.fill('#mp-name', 'Ada');
  await page.click('#mp-create');

  await expect(page.locator('#mp-room')).toBeVisible();
  const code = (await page.locator('#mp-room-code').textContent()).trim();
  expect(code).toMatch(/^[A-Z0-9]{12}$/);
  await expect(page).toHaveURL(new RegExp(`/multiplayer/${code}$`));
  await expect(page.locator('#mp-roster .mp-player')).toHaveCount(1);
  await expect(page.locator('#mp-roster .mp-crown')).toHaveCount(1);
  await expect(page.locator('#mp-roster .mp-player').first()).toContainText('Ada');
  await expect(page.locator('#mp-start')).toBeVisible();   // host-only controls
  await expect(page.locator('#mp-disband')).toBeVisible();

  // A refresh must restore exactly the same room, with no code typed again.
  await page.reload();
  await expect(page.locator('#mp-room-code')).toHaveText(code);
  await expect(page.locator('#mp-roster .mp-player')).toHaveCount(1);

  // A second browser opens the invitation link and joins as a guest.
  const friendContext = await browser.newContext();
  const friend = await friendContext.newPage();
  await friend.goto(`/multiplayer/${code}`);
  await friend.fill('#mp-name', 'Grace');
  await friend.click('#mp-join');
  await expect(friend.locator('#mp-room')).toBeVisible();
  await expect(friend.locator('#mp-roster .mp-player')).toHaveCount(2);
  await expect(friend.locator('#mp-start')).toBeHidden();  // not the host
  await expect(friend.locator('#mp-disband')).toBeHidden();

  // Readiness is advisory and visible to everyone.
  await friend.click('#mp-ready-toggle');
  await expect(friend.locator('#mp-ready-count')).toHaveText('1 ready');
  await expect.poll(async () => (await page.locator('#mp-ready-count').textContent()).trim())
    .toBe('1 ready');
  await expect.poll(async () => page.locator('#mp-roster .mp-player').count()).toBe(2);

  // The host may start without unanimity — and nothing pretends to play.
  await page.click('#mp-start');
  await expect(page.locator('#mp-flash')).toContainText('later step');
  await expect(page.locator('#mp-room-state')).toHaveText('lobby');

  // Leaving puts the friend back on the entry screen.
  await friend.click('#mp-leave');
  await expect(friend.locator('#mp-entry')).toBeVisible();
  await expect.poll(async () => page.locator('#mp-roster .mp-player').count()).toBe(1);

  // The host disbands; the friend is told why on their next poll.
  page.once('dialog', (dialog) => dialog.accept());
  await page.click('#mp-disband');
  await expect(page.locator('#mp-entry')).toBeVisible();
  await friendContext.close();
});

test('two clients and a second tab synchronize live over one socket each', async ({ browser }) => {
  // Real WebSockets against a real server: this test needs a browser with
  // ws:// support (it runs wherever the other browser tests run).
  const ctxA = await browser.newContext();
  const a = await ctxA.newPage();
  const errors = [];
  a.on('pageerror', (error) => errors.push(error.message));

  // --- client A opens a room and its socket goes live ---
  await a.goto('/multiplayer');
  await a.fill('#mp-name', 'Ada');
  await a.click('#mp-create');
  await expect(a.locator('#mp-room')).toBeVisible();
  const code = (await a.locator('#mp-room-code').textContent()).trim();
  await expect(a.locator('#mp-conn')).toHaveAttribute('data-state', 'live', { timeout: 10_000 });

  // --- a second TAB of the same player: same identity, same single seat ---
  const tab2 = await ctxA.newPage();
  await tab2.goto(`/multiplayer/${code}`);
  await expect(tab2.locator('#mp-conn')).toHaveAttribute('data-state', 'live', { timeout: 10_000 });
  await expect(tab2.locator('#mp-roster .mp-player')).toHaveCount(1);
  await expect(a.locator('#mp-roster .mp-player')).toHaveCount(1);

  // --- client B, a separate browser context (= separate guest cookie) ---
  const ctxB = await browser.newContext();
  const b = await ctxB.newPage();
  await b.goto(`/multiplayer/${code}`);
  await b.fill('#mp-name', 'Grace');
  await b.click('#mp-join');
  await expect(b.locator('#mp-conn')).toHaveAttribute('data-state', 'live', { timeout: 10_000 });

  // A and its second tab both see B join — no reload, no manual refresh.
  await expect(a.locator('#mp-roster .mp-player')).toHaveCount(2, { timeout: 10_000 });
  await expect(a.locator('#mp-roster')).toContainText('Grace');
  await expect(tab2.locator('#mp-roster .mp-player')).toHaveCount(2, { timeout: 10_000 });

  // Ready vote from B reaches A live, with the counts.
  await b.click('#mp-ready-toggle');
  await expect(a.locator('#mp-ready-count')).toHaveText('1 ready', { timeout: 10_000 });
  await expect(a.locator('#mp-roster')).toContainText('Ready');

  // A (the host) leaves: the crown passes to B and B's page shows it live.
  await a.click('#mp-leave');
  await expect(b.locator('#mp-roster .mp-crown')).toHaveCount(1, { timeout: 10_000 });
  await expect(b.locator('#mp-roster .mp-player')).toHaveCount(1);

  // Disbanding reaches the other socket and the room closes for everyone.
  b.once('dialog', (dialog) => dialog.accept());
  await b.click('#mp-disband');
  await expect(b.locator('#mp-entry')).toBeVisible({ timeout: 10_000 });
  expect(errors).toEqual([]);

  await ctxA.close();
  await ctxB.close();
});

test('joining a second room asks before leaving the first', async ({ page, request }) => {
  const other = await request.post('/api/rooms', {
    headers: { 'Content-Type': 'application/json' },
    data: { display_name: 'Bob' },
  });
  const { room } = await other.json();

  await page.goto('/multiplayer');
  await page.fill('#mp-name', 'Ada');
  await page.click('#mp-create');
  await expect(page.locator('#mp-room')).toBeVisible();
  const mine = (await page.locator('#mp-room-code').textContent()).trim();

  // Opening somebody else's invitation while seated must ask first.
  await page.goto(`/multiplayer/${room.code}`);
  await expect(page.locator('#mp-confirm')).toBeVisible();
  await expect(page.locator('#mp-confirm-body')).toContainText(mine);
  await page.click('#mp-confirm-cancel');
  await expect(page.locator('#mp-confirm')).toBeHidden();
  await expect(page.locator('#mp-room-code')).toHaveText(mine);
  await expect(page).toHaveURL(new RegExp(`/multiplayer/${mine}$`));

  await page.goto(`/multiplayer/${room.code}`);
  await page.click('#mp-confirm-ok');
  await expect(page.locator('#mp-room-code')).toHaveText(room.code);
  await expect(page.locator('#mp-roster .mp-player')).toHaveCount(2);
});

test('brand goes home, header auth opens the dialog, theme picker persists', async ({ page, isMobile }) => {
  await page.goto('/multiplayer');

  // No room-size selector anywhere on the page.
  await expect(page.locator('#mp-capacity')).toHaveCount(0);

  // The wordmark always returns to the main page.
  await activate(page.locator('.masthead__brand--link'), isMobile);
  await expect(page).toHaveURL(/\/$/);
  await page.goBack();
  await expect(page.locator('#multiplayer-root')).toBeVisible();

  // Header auth opens the shared dialog and closes again.
  await expect(page.locator('#mp-signin-top')).toBeVisible();
  await expect(page.locator('#mp-create-top')).toBeVisible();
  await activate(page.locator('#mp-signin-top'), isMobile);
  await expect(page.locator('#auth-dialog')).toBeVisible();
  await page.click('#auth-close');
  await expect(page.locator('#auth-dialog')).toBeHidden();

  // Theme picker: switching persists into the saved settings and survives a reload.
  const before = await page.evaluate(() => localStorage.getItem('snake.settings.v1'));
  await activate(page.locator('#mp-themes button[data-theme="terminal"]'), isMobile);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'terminal');
  await expect(page.locator('#mp-themes button[data-theme="terminal"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#matrix-rain')).toBeVisible();

  await activate(page.locator('#mp-themes button[data-theme="paper"]'), isMobile);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'paper');
  await expect(page.locator('#matrix-rain')).toBeHidden();
  const saved = JSON.parse(await page.evaluate(() => localStorage.getItem('snake.settings.v1')));
  expect(saved.theme).toBe('paper');
  const beforeSettings = JSON.parse(before || '{}');
  expect(saved.speedId).toEqual(beforeSettings.speedId ?? saved.speedId); // other keys untouched

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'paper');
  await expect(page.locator('#mp-themes button[data-theme="paper"]')).toHaveAttribute('aria-pressed', 'true');

  // Theme carries to the main page too (same storage), verifying no drift.
});
test('invalid and disbanded codes explain themselves', async ({ page, request }) => {
  await page.goto('/multiplayer');
  await page.fill('#mp-code', 'ZZZZZZZZZZZZ');
  await expect(page.locator('#mp-code-preview')).toContainText('does not exist');

  await page.fill('#mp-name', 'Ada');
  await page.click('#mp-join');
  await expect(page.locator('#mp-flash')).toContainText('does not exist');
  await expect(page.locator('#mp-entry')).toBeVisible();
  expect((await request.get('/api/rooms/ZZZZZZZZZZZZ')).status()).toBe(404);
});

for (const theme of themes) {
  test(`${theme} carries across both pages without changing saved settings`, async ({ page, isMobile }) => {
    await page.goto('/');
    await activate(page.locator(`#settings-theme button[data-theme="${theme}"]`), isMobile);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const saved = await page.evaluate(() => localStorage.getItem('snake.settings.v1'));
    const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--green'));
    await activate(navLink(page, 'Multiplayer'), isMobile);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    expect(await page.evaluate(() => localStorage.getItem('snake.settings.v1'))).toBe(saved);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--green'))).toBe(accent);
    // The notice must inherit readable theme text, including light Paper.
    const textColor = await page.locator('body').evaluate((body) => getComputedStyle(body).color);
    await expect(page.locator('#multiplayer-root .band__lede')).toHaveCSS('color', textColor);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (theme === 'terminal') {
      await expect(page.locator('#matrix-rain')).toBeVisible();
      await expect.poll(() => page.locator('#matrix-rain').evaluate((canvas) => canvas.width)).toBeGreaterThan(300);
    } else {
      await expect(page.locator('#matrix-rain')).toBeHidden();
    }
    await activate(navLink(page, 'Single Player'), isMobile);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.locator('#btn-start')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('snake.settings.v1'))).toBe(saved);
  });
}

for (const storage of ['missing', 'corrupt', 'blocked']) {
  test(`multiplayer loads with ${storage} saved settings`, async ({ page }) => {
    await page.addInitScript((mode) => {
      if (mode === 'missing') localStorage.removeItem('snake.settings.v1');
      if (mode === 'corrupt') localStorage.setItem('snake.settings.v1', '{bad json');
      if (mode === 'blocked') Object.defineProperty(window, 'localStorage', {
        get() { throw new DOMException('Storage blocked', 'SecurityError'); },
      });
    }, storage);
    await page.goto('/multiplayer');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'classic');
    await expect(navLink(page, 'Single Player')).toBeVisible();
    await expect(page.locator('#multiplayer-root')).toBeVisible();
  });
}

test('existing destination links work from multiplayer', async ({ page, isMobile }) => {
  for (const [name, path, target] of [
    ['Leaderboard', '/#leaderboard', '#leaderboard'],
    ['Self Host', '/#manual', '#manual'],
    ['Profile', '/profile', '#profile-root'],
  ]) {
    await page.goto('/multiplayer');
    await expect(navLink(page, name)).toHaveAttribute('href', path);
    await activate(navLink(page, name), isMobile);
    await expect(page).toHaveURL((url) => url.pathname + url.hash === path);
    await expect(page.locator(target)).toBeVisible();
  }
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('page navigation still works', async ({ page, isMobile }) => {
    await page.goto('/');
    await activate(navLink(page, 'Multiplayer'), isMobile);
    await expect(page).toHaveURL(/\/multiplayer$/);
    await expect(page.locator('#multiplayer-root')).toBeVisible();
    await activate(navLink(page, 'Single Player'), isMobile);
    await expect(page).toHaveURL(/\/$/);
  });
});
