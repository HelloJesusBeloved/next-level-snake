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
  const module = await request.get('/multiplayer/page.js');
  expect(module.status()).toBe(200);
  expect(module.headers()['content-type']).toMatch(/javascript/);
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

test('multiplayer has no pretend controls, game engine, or API traffic', async ({ page }) => {
  const apiRequests = [];
  const sockets = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url());
  });
  page.on('websocket', (socket) => sockets.push(socket.url()));
  await page.goto('/multiplayer');
  await expect(page.locator('#multiplayer-root')).toContainText('Multiplayer is not available yet.');
  await expect(page.locator('button, input, select, form, #snake-root, .snake-canvas')).toHaveCount(0);
  await expect(page.locator('script[src^="/game.js"], script[src^="/app.js"], script[src^="/profile.js"]')).toHaveCount(0);
  await expect(page.locator('script[type="module"][src^="/multiplayer/page.js"]')).toHaveCount(1);
  expect(await page.evaluate(() => typeof window.SnakeGame)).toBe('undefined');
  expect(apiRequests).toEqual([]);
  expect(sockets).toEqual([]);
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
