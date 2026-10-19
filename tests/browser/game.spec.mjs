import { test, expect } from '@playwright/test';
import pg from 'pg';

const BASE = (process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Runs in every frame before the page's own scripts: stores settings, exposes
// the engine for the test, counts canvas paints, and lets a test arm a
// deterministic first food (the first step of a run then eats it).
async function installHooks(page, theme, settings = {}) {
  await page.addInitScript(({ theme, settings }) => {
    localStorage.setItem('snake.settings.v1', JSON.stringify({
      theme, speedId: 1, growth: 1, ...settings,
    }));
    let seeded = [];
    const real = Math.random;
    window.__seedFood = () => { seeded = [0.5625, 0.5]; };
    Math.random = () => (seeded.length ? seeded.shift() : real());

    let engine;
    Object.defineProperty(window, 'SnakeGame', {
      configurable: true,
      get() { return engine; },
      set(value) {
        engine = value;
        const create = value.create;
        value.create = function (...args) {
          const game = create.apply(this, args);
          window.__snakeTest = game;
          return game;
        };
      },
    });

    window.__rainFrames = 0;
    window.__rainFont = '';
    window.__gamePaints = 0;
    const fillRect = CanvasRenderingContext2D.prototype.fillRect;
    CanvasRenderingContext2D.prototype.fillRect = function (...args) {
      if (this.canvas.id === 'matrix-rain') window.__rainFrames++;
      if (this.canvas.classList && this.canvas.classList.contains('snake-canvas')) window.__gamePaints++;
      return fillRect.apply(this, args);
    };
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (...args) {
      if (this.canvas.id === 'matrix-rain') window.__rainFont = this.font;
      return fillText.apply(this, args);
    };
  }, { theme, settings });
}

// Page with the API mocked: nothing here touches the database.
async function openGame(page, theme = 'classic', settings = {}) {
  await page.route('**/api/scores', (route) => route.fulfill({ json: { best: {} } }));
  await page.route('**/api/leaderboard**', (route) => route.fulfill({ json: { board: 'standard', total: 0, rows: [] } }));
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { user: null } }));
  await installHooks(page, theme, settings);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__snakeTest));
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

// Page against the real API and database.
async function openLive(page, theme = 'classic', settings = {}) {
  await installHooks(page, theme, settings);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__snakeTest));
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

async function activate(locator, projectName) {
  if (projectName === 'mobile') await locator.tap();
  else await locator.click();
}

// Pause / unpause the way the device does it: the on-screen button on touch
// screens, the P key on desktop (the button is touch-only).
async function togglePause(page, projectName) {
  if (projectName === 'mobile') await page.locator('#pause-btn').tap();
  else await page.keyboard.press('p');
}

// Chromium's compositor receives genuine touchscreen input, including native
// scrolling. Synthetic DOM events alone would not verify the scroll lock.
async function swipe(page, from, to) {
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart', touchPoints: [{ ...from, id: 1 }],
  });
  for (let i = 1; i <= 8; i++) {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{
        x: from.x + (to.x - from.x) * i / 8,
        y: from.y + (to.y - from.y) * i / 8,
        id: 1,
      }],
    });
    await page.waitForTimeout(20);
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
}

// Resolves once scrollY has stopped changing for a quarter of a second.
// A tap during a coasting scroll is swallowed by the browser, as on any phone.
async function settleScroll(page) {
  let last = await page.evaluate(() => window.scrollY);
  let stableFor = 0;
  for (let i = 0; i < 60 && stableFor < 250; i++) {
    await page.waitForTimeout(50);
    const now = await page.evaluate(() => window.scrollY);
    stableFor = now === last ? stableFor + 50 : 0;
    last = now;
  }
}

async function greenPixels(page) {
  return page.locator('.snake-canvas').evaluate((canvas) => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let minX = canvas.width, maxX = -1, minY = canvas.height, maxY = -1, count = 0;
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4;
        if (data[i] === 53 && data[i + 1] === 255 && data[i + 2] === 107) {
          count++;
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
          minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        }
      }
    }
    return { count, width: maxX - minX + 1, height: maxY - minY + 1 };
  });
}

// ---------------------------------------------------------------------------
// Layout, theme and copy (API mocked)
// ---------------------------------------------------------------------------

// A tall window: the HUD and box already fit, so starting a run does not scroll
// and the header stays on screen (and reachable) during play.
async function tallWindow(page) {
  const size = page.viewportSize();
  await page.setViewportSize({ width: size.width, height: 2400 });
}

test('mobile Terminal distinguishes tapping the game box from tapping Start', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'Touch controls regression');
  await openGame(page, 'terminal');
  await page.locator('#panel-start .panel__title').tap();
  await expect(page.locator('#snake-root')).toHaveClass(/is-hacking/);
  const first = await page.evaluate(() => window.__snakeTest.state().score);
  expect(first).toBe(1);
  await page.locator('.snake-field').tap();
  expect(await page.evaluate(() => window.__snakeTest.state().score)).toBe(first + 1);
  await page.evaluate(() => window.__snakeTest.clearHack());
  await page.locator('#btn-start').tap();
  expect(await page.evaluate(() => window.__snakeTest.state().running)).toBe(true);
  await expect(page.locator('#snake-root')).not.toHaveClass(/is-hacking/);
});

test('mobile pause control appears only while a run exists', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'The pause button is touch-only');
  await openGame(page);
  await expect(page.locator('#pause-btn')).toBeHidden();
  await page.locator('#btn-start').tap();
  await expect(page.locator('#pause-btn')).toBeVisible();
  await page.locator('#pause-btn').tap();
  await expect(page.locator('#pause-btn')).toHaveText('Unpause');
  await page.locator('#btn-quit').tap();
  await expect(page.locator('#pause-btn')).toBeHidden();
});

test('mobile switching Arcade never shifts the game or settings', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'Mobile scroll-anchor regression');
  await openGame(page);
  await page.locator('#settings-theme').scrollIntoViewIfNeeded();
  await settleScroll(page);
  const coordinates = () => page.evaluate(() => ({
    screen: document.querySelector('.snake-field').getBoundingClientRect().top,
    settings: document.querySelector('#settings-theme').getBoundingClientRect().top,
    scroll: window.scrollY,
  }));
  const before = await coordinates();
  await page.locator('#settings-theme [data-theme="arcade"]').tap();
  const arcade = await coordinates();
  await page.locator('#settings-theme [data-theme="classic"]').tap();
  const classic = await coordinates();
  for (const current of [arcade, classic]) {
    expect(Math.abs(current.screen - before.screen)).toBeLessThan(2);
    expect(Math.abs(current.settings - before.settings)).toBeLessThan(2);
    expect(Math.abs(current.scroll - before.scroll)).toBeLessThan(2);
  }
});

test('outlined navigation remains clickable and pauses before scrolling', async ({ page }, info) => {
  await openGame(page);
  await tallWindow(page);
  const leaderboard = page.getByRole('link', { name: 'Leaderboard', exact: true });
  const selfHost = page.getByRole('link', { name: 'Self Host', exact: true });
  await expect(leaderboard).toHaveCSS('border-top-style', 'solid');
  await expect(selfHost).toHaveCSS('border-top-width', '1px');
  await expect(page.getByText('Postgres ledger', { exact: false })).toHaveCount(0);
  await page.evaluate(() => window.__snakeTest.start());
  await activate(leaderboard, info.project.name);
  await expect(page).toHaveURL(/#leaderboard$/);
  await expect(page.locator('body')).not.toHaveClass(/is-playing/);
  expect(await page.evaluate(() => window.__snakeTest.state().paused)).toBe(true);
  await activate(selfHost, info.project.name);
  await expect(page).toHaveURL(/#manual$/);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await expect(page.locator('#pause-btn')).toHaveText('Unpause');
});

test('mobile swipes anywhere steer; pause allows scrolling; resume locks again', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'Native mobile gesture regression');
  await openGame(page);
  await activate(page.locator('#btn-start'), info.project.name);
  await expect(page.locator('body')).toHaveClass(/is-playing/);
  await expect(page.locator('html')).toHaveClass(/is-playing/);
  expect(await page.evaluate(() => Boolean(document.elementFromPoint(8, 150)?.closest('.snake-field')))).toBe(false);
  await page.evaluate(() => {
    document.addEventListener('touchmove', (event) => { window.__touchCancelled = event.defaultPrevented; });
  });
  const beforeBox = await page.locator('.snake-field').boundingBox();
  // This starts in the page gutter, wholly outside the game box.
  await swipe(page, { x: 8, y: 150 }, { x: 8, y: 290 });
  await page.waitForTimeout(600);
  const body = await greenPixels(page);
  expect(body.height).toBeGreaterThan(body.width * 2);
  expect(await page.evaluate(() => window.__touchCancelled)).toBe(true);
  const afterBox = await page.locator('.snake-field').boundingBox();
  expect(Math.abs(afterBox.y - beforeBox.y)).toBeLessThan(1);

  // A tap on the floating button must work even though document swipes are captured.
  await page.locator('#pause-btn').tap();
  await expect(page.locator('#pause-btn')).toHaveText('Unpause');
  await expect(page.locator('body')).not.toHaveClass(/is-playing/);
  await expect(page.locator('html')).not.toHaveClass(/is-playing/);
  await expect(page.locator('#settings-speed button').first()).toBeDisabled();
  const beforeScroll = await page.evaluate(() => window.scrollY);
  await swipe(page, { x: 8, y: 650 }, { x: 8, y: 240 });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(beforeScroll + 50);
  expect(await page.evaluate(() => window.__touchCancelled)).toBe(false);
  expect(await page.evaluate(() => window.__snakeTest.state().paused)).toBe(true);
  await settleScroll(page);

  await page.locator('#pause-btn').tap();
  await expect(page.locator('#pause-btn')).toHaveText('Pause');
  await expect(page.locator('body')).toHaveCSS('position', 'fixed');
  const beforeResumeSwipe = await page.locator('.snake-field').boundingBox();
  await swipe(page, { x: 8, y: 650 }, { x: 8, y: 480 });
  expect(await page.evaluate(() => window.__touchCancelled)).toBe(true);
  const afterResumeSwipe = await page.locator('.snake-field').boundingBox();
  expect(Math.abs(afterResumeSwipe.y - beforeResumeSwipe.y)).toBeLessThan(1);
  await page.locator('#pause-btn').tap();
  await page.locator('#btn-quit').tap();
  await expect(page.locator('body')).not.toHaveClass(/is-playing|has-run/);
  await expect(page.locator('#settings-speed button').first()).toBeEnabled();
});

test('in a normal window the header is reached by pausing, which unlocks the page', async ({ page }, info) => {
  await openGame(page);
  await page.evaluate(() => window.__snakeTest.start());
  // On a desktop window the page is locked on the box and the header is above the
  // window. (A phone already fits HUD + box, so nothing scrolls and it stays visible.)
  if (info.project.name === 'desktop') {
    expect(await page.locator('.masthead').evaluate((el) => el.getBoundingClientRect().bottom)).toBeLessThan(0);
  }
  await page.evaluate(() => window.__snakeTest.pause());
  await page.evaluate(() => window.scrollTo(0, 0));
  const signIn = page.locator('#btn-open-login');
  await expect(signIn).toBeInViewport();
  await activate(signIn, info.project.name);
  await expect(page.locator('#auth-dialog')).toHaveAttribute('open', '');
  await activate(page.locator('#auth-close'), info.project.name);
  await page.evaluate(() => window.__snakeTest.quit());
});

test('mobile: the pause button stays tappable when scrolled down to the leaderboard', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'The pause button is touch-only');
  await openGame(page);
  await page.evaluate(() => window.__snakeTest.start());
  await page.evaluate(() => window.__snakeTest.pause());
  await page.evaluate(() => document.querySelector('#leaderboard').scrollIntoView());
  await settleScroll(page);
  const button = page.locator('#pause-btn');
  await expect(button).toBeInViewport();
  // The topmost element at the button's centre must be the button itself.
  const onTop = await button.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el;
  });
  expect(onTop).toBe(true);
  await button.tap();
  await expect(button).toHaveText('Pause');
  expect(await page.evaluate(() => window.__snakeTest.state().paused)).toBe(false);
  await page.evaluate(() => window.__snakeTest.quit());
});

test('Classic is one solid rectangle with no gaps, borders, or scanlines', async ({ page }) => {
  await openGame(page);
  await page.evaluate(() => { window.__snakeTest.start(); window.__snakeTest.pause(); });
  const body = await greenPixels(page);
  expect(body.count).toBeGreaterThan(0);
  expect(body.width).toBeGreaterThan(body.height * 2);
  expect(body.count).toBe(body.width * body.height);
  expect(await page.locator('.snake-field').evaluate((el) => getComputedStyle(el, '::after').backgroundImage)).toBe('none');
  expect(await page.locator('html').evaluate((el) => getComputedStyle(el).getPropertyValue('--bezel-texture').trim())).toBe('0');
});

test('Terminal cursor appears only when inactive and rain is slow, large, and yields to play', async ({ page }) => {
  await openGame(page, 'terminal');
  const cursor = page.locator('.terminal-cursor');
  await expect(cursor).toHaveText('>');
  await expect(cursor).toHaveCSS('display', 'block');
  await expect(cursor).toHaveCSS('animation-name', 'terminal-cursor-blink');
  await expect(page.locator('.snake-field #matrix-rain')).toHaveCount(0);
  await expect(page.locator('.snake-field .terminal-cursor')).toHaveCount(1);
  const cursorBox = await cursor.boundingBox();
  const fieldBox = await page.locator('.snake-field').boundingBox();
  expect(cursorBox.x).toBeGreaterThan(fieldBox.x);
  expect(cursorBox.y).toBeGreaterThan(fieldBox.y);
  expect(cursorBox.x + cursorBox.width).toBeLessThan(fieldBox.x + fieldBox.width);

  const before = await page.evaluate(() => window.__rainFrames);
  await page.waitForTimeout(1100);
  const frames = await page.evaluate((start) => window.__rainFrames - start, before);
  expect(frames).toBeGreaterThan(2);
  expect(frames).toBeLessThanOrEqual(12);
  expect(await page.evaluate(() => window.__rainFont)).toContain('20px');

  await page.evaluate(() => window.__snakeTest.start());
  await expect(cursor).toHaveCSS('display', 'none');
  await expect(page.locator('#matrix-rain')).toHaveCSS('display', 'none');
  const duringPlay = await page.evaluate(() => window.__rainFrames);
  await page.waitForTimeout(400);
  expect(await page.evaluate((s) => window.__rainFrames - s, duringPlay)).toBe(0);

  await page.evaluate(() => window.__snakeTest.pause());
  await expect(cursor).toHaveCSS('display', 'block');
  await expect(page.locator('body')).not.toHaveClass(/is-playing/);
  await expect(page.locator('#matrix-rain')).toHaveCSS('display', 'block');
  await page.evaluate(() => window.__snakeTest.quit());
  await expect(cursor).toHaveCSS('display', 'block');

  await page.locator('[data-theme="paper"][type="button"]').click();
  await expect(page.locator('#matrix-rain')).toHaveCSS('display', 'none');
  await page.locator('[data-theme="terminal"][type="button"]').click();
  const restarted = await page.evaluate(() => window.__rainFrames);
  await page.waitForTimeout(1100);
  const restartedFrames = await page.evaluate((start) => window.__rainFrames - start, restarted);
  expect(restartedFrames).toBeLessThanOrEqual(12);
});

test('account buttons work during play and typing WASD never controls the snake', async ({ page }, info) => {
  await openGame(page);
  await tallWindow(page);
  await page.evaluate(() => window.__snakeTest.start());
  await activate(page.locator('#btn-open-create'), info.project.name);
  await expect(page.locator('#auth-dialog')).toHaveAttribute('open', '');
  await expect(page.locator('body')).not.toHaveClass(/is-playing/);
  const username = page.locator('#form-create input[name="username"]');
  const password = page.locator('#form-create input[name="password"]');
  await username.pressSequentially('wasdplayer');
  await password.pressSequentially('wasdp_123');
  await expect(username).toHaveValue('wasdplayer');
  await expect(password).toHaveValue('wasdp_123');
  expect(await page.evaluate(() => window.__snakeTest.state().paused)).toBe(true);
  await activate(page.locator('#auth-close'), info.project.name);
  await expect(page.locator('#auth-dialog')).not.toHaveAttribute('open');
  await togglePause(page, info.project.name);
  await expect(page.locator('body')).toHaveClass(/is-playing/);
});

test('Royal Sunset uses a deep red page with orange and yellow accents', async ({ page }) => {
  await openGame(page, 'sunsetfire');
  await expect(page.locator('#theme-value')).toHaveText('Royal Sunset');
  await expect(page.locator('#settings-theme [data-theme="sunsetfire"]')).toContainText('Royal Sunset');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(50, 5, 11)');
  const scrim = await page.locator('.page-scrim').evaluate((el) => getComputedStyle(el).backgroundImage);
  expect(scrim).toContain('216, 15, 49');
  expect(scrim).toContain('255, 126, 36');
  expect(scrim).not.toContain('44, 224, 94');
  expect(await page.evaluate(() => window.__snakeTest.getTheme().snake)).toBe('#FFD34E');
  expect(await page.evaluate(() => window.__snakeTest.getTheme().food)).toBe('#FF5839');
});

test('copy: three-line title, leaderboard heading, and a lone Start game button', async ({ page }) => {
  await openGame(page);
  const lines = (await page.locator('.stage__title').innerText())
    .split('\n').map((line) => line.trim()).filter(Boolean);
  expect(lines).toEqual(['Beautiful.', 'Modern.', 'Snake.']);
  await expect(page.locator('.stage__title em')).toHaveText('Snake.');
  await expect(page.locator('#leaderboard .band__title'))
    .toHaveText('One game. Two boards. Everyone watching.');

  const actions = page.locator('#panel-start .panel__actions');
  await expect(actions.getByRole('button')).toHaveCount(1);
  await expect(actions.getByRole('button')).toHaveText('Start game');
  await expect(actions.getByRole('link')).toHaveCount(0);
  await expect(page.getByText('Set modifiers', { exact: true })).toHaveCount(0);
});

test('Arcade cabinet decorates without resizing or offsetting the playfield', async ({ page }) => {
  await openGame(page, 'arcade');
  await expect(page.locator('.cabinet')).toHaveCSS('display', 'block');
  await expect(page.locator('.cabinet__marquee')).toBeVisible();
  await expect(page.locator('.cabinet__deck')).toBeVisible();
  await expect(page.locator('.cabinet__marquee-text')).toHaveText('Next Level Snake');
  await expect(page.locator('.cabinet__buttons i')).toHaveCount(4);
  await expect(page.locator('.cabinet__stick')).toHaveCount(1);
  expect(await page.locator('.cabinet').evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');

  const arcadeField = await page.locator('.snake-field').boundingBox();
  const arcadeOverlay = await page.locator('#overlay').boundingBox();
  expect(Math.abs(arcadeOverlay.y - arcadeField.y)).toBeLessThan(2);
  expect(Math.abs(arcadeOverlay.height - arcadeField.height)).toBeLessThan(2);

  const marqueeBox = await page.locator('.cabinet__marquee').boundingBox();
  const deckBox = await page.locator('.cabinet__deck').boundingBox();
  expect(marqueeBox.y + marqueeBox.height).toBeLessThanOrEqual(arcadeField.y + 0.5);
  expect(deckBox.y).toBeGreaterThanOrEqual(arcadeField.y + arcadeField.height - 0.5);

  for (const theme of ['classic', 'violet', 'terminal']) {
    await page.locator(`[data-theme="${theme}"][type="button"]`).click();
    const box = await page.locator('.snake-field').boundingBox();
    expect(Math.abs(box.width - arcadeField.width)).toBeLessThan(1.5);
    expect(Math.abs(box.height - arcadeField.height)).toBeLessThan(1.5);
    await expect(page.locator('.cabinet__marquee')).toBeHidden();
  }
});

test('Arcade page background and accents are blue and red, not green', async ({ page }) => {
  await openGame(page, 'arcade');
  const root = page.locator('html');
  const cssVar = (name) => root.evaluate((el, n) => getComputedStyle(el).getPropertyValue(n).trim(), name);
  expect(await cssVar('--green')).toBe('#ff4f64');       // accent: arcade red
  expect(await cssVar('--accent-2')).toBe('#4da3ff');    // second accent: arcade blue
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(10, 18, 51)');

  const scrim = await page.locator('.page-scrim').evaluate((el) => getComputedStyle(el).backgroundImage);
  expect(scrim).toContain('46, 120, 255');   // blue glow
  expect(scrim).toContain('255, 60, 90');    // red glow
  expect(scrim).not.toContain('44, 224, 94');

  await expect(page.locator('#btn-start')).toHaveCSS('background-color', 'rgb(255, 79, 100)');
  await expect(page.locator('.stage__title em')).toHaveCSS('color', 'rgb(255, 79, 100)');
  await expect(page.locator('.hud__value--score')).toHaveCSS('color', 'rgb(255, 79, 100)');
  // color-mix() is reported as color(srgb r g b / a); 0.3019 0.6392 1 is rgb(77, 163, 255).
  const hudBorder = await page.locator('.hud').evaluate((el) => getComputedStyle(el).borderTopColor);
  expect(hudBorder).toMatch(/0\.30\d* 0\.63\d* 1|77, 163, 255/);

  // The cabinet itself keeps its red body, blue marquee/deck and red + blue buttons.
  const frameBg = await page.locator('.snake-frame').evaluate((el) => getComputedStyle(el).backgroundImage);
  expect(frameBg).toContain('rgb(210, 31, 61)');
  const deckBg = await page.locator('.cabinet__deck').evaluate((el) => getComputedStyle(el).backgroundImage);
  expect(deckBg).toContain('rgb(63, 134, 255)');
  await expect(page.locator('.cabinet__buttons i').nth(0)).toHaveCSS('background-color', 'rgb(255, 59, 78)');
  await expect(page.locator('.cabinet__buttons i').nth(2)).toHaveCSS('background-color', 'rgb(143, 193, 255)');
});

test('Violet sits on a stationary, blurred, swirling water-ink backdrop outside the game box', async ({ page }) => {
  await openGame(page, 'violet');
  const scrim = page.locator('.page-scrim');
  const style = await scrim.evaluate((el) => getComputedStyle(el));
  expect(style.filter).toContain('blur');
  expect(style.animationName).toBe('none');
  expect(style.backgroundImage).toContain('violet-swirl.jpg');
  await expect(page.locator('.page-texture')).toHaveCSS('display', 'none');

  // The artwork is real, loads, and is colourful (not blank or flat).
  const art = await page.evaluate(async () => {
    const img = new Image();
    img.src = '/img/violet-swirl.jpg';
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0, 64, 64);
    const d = x.getImageData(0, 0, 64, 64).data;
    let r = 0, g = 0, b = 0, lum = [];
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; lum.push(0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2]); }
    const n = d.length / 4, mean = lum.reduce((a, v) => a + v, 0) / n;
    const spread = Math.sqrt(lum.reduce((a, v) => a + (v - mean) ** 2, 0) / n);
    return { w: img.naturalWidth, h: img.naturalHeight, r: r / n, g: g / n, b: b / n, spread };
  });
  expect(art.w).toBeGreaterThan(500);
  expect(art.spread).toBeGreaterThan(8);          // has structure, not a flat fill
  expect(art.b).toBeGreaterThan(art.g);           // violet / blue leaning

  expect(await page.locator('.snake-field').evaluate((el) => getComputedStyle(el).backgroundImage)).toBe('none');
  expect(await page.evaluate(() => window.__snakeTest.getTheme().field)).toBe('#0B0617');
  expect(await page.evaluate(() => document.getAnimations()
    .filter((a) => a.constructor.name === 'CSSAnimation' && a.playState === 'running').length)).toBe(0);
});

test('performance: an idle board never repaints, a running one does', async ({ page }) => {
  await openGame(page);
  await page.waitForTimeout(900);
  const idleStart = await page.evaluate(() => window.__gamePaints);
  await page.waitForTimeout(700);
  expect(await page.evaluate((s) => window.__gamePaints - s, idleStart)).toBe(0);

  await page.evaluate(() => window.__snakeTest.start());
  const playStart = await page.evaluate(() => window.__gamePaints);
  await page.waitForTimeout(700);
  expect(await page.evaluate((s) => window.__gamePaints - s, playStart)).toBeGreaterThan(0);

  await page.evaluate(() => window.__snakeTest.pause());
  await page.waitForTimeout(250);
  const pausedStart = await page.evaluate(() => window.__gamePaints);
  await page.waitForTimeout(600);
  expect(await page.evaluate((s) => window.__gamePaints - s, pausedStart)).toBe(0);
  await page.evaluate(() => window.__snakeTest.quit());
});

test('the game box is ~30% bigger and the whole playfield fits the window', async ({ page }, info) => {
  await openGame(page, 'arcade');
  const m = await page.evaluate(() => {
    const f = document.querySelector('.snake-field').getBoundingClientRect();
    const frame = document.querySelector('.snake-frame').getBoundingClientRect();
    return { w: f.width, h: f.height, frameH: frame.height, vw: innerWidth, vh: innerHeight,
             stackedRail: getComputedStyle(document.querySelector('.rail')).position };
  });
  expect(Math.abs(m.w / m.h - 24 / 18)).toBeLessThan(0.02);       // same 24x18 grid: gameplay is unchanged
  expect(m.frameH).toBeLessThanOrEqual(m.vh - 52);                 // the whole frame fits under the score pill strip
  if (info.project.name === 'desktop') {
    // Was 876px wide at 1365x960. +30% is 1139px; the window's height allows 1133px.
    expect(m.w).toBeGreaterThanOrEqual(876 * 1.25);
    expect(m.w).toBeGreaterThanOrEqual(m.vw * 0.78);                // ~83% of the screen width
    expect(m.stackedRail).toBe('static');                          // the rail moved below the game to make room
  } else {
    expect(m.w).toBeGreaterThanOrEqual(334 * 1.05);                // phones are width-limited: every pixel counts
  }
});

test('starting a run aligns the scoreboard to the top and keeps the whole playfield on screen', async ({ page }) => {
  await openGame(page);
  // The built-in scoreboard sits directly above the box; starting a run aligns
  // it to the top of the window so the score and best stay visible.
  const measure = () => page.evaluate(() => {
    const hud = document.querySelector('#hud').getBoundingClientRect();
    const frame = document.querySelector('.snake-frame').getBoundingClientRect();
    return { hudTop: hud.top, hudBottom: hud.bottom, top: frame.top, bottom: frame.bottom, vh: innerHeight };
  });

  // Park the box at the very bottom edge of the window, cut off.
  await page.evaluate(() => {
    const f = document.querySelector('.snake-frame').getBoundingClientRect();
    window.scrollTo(0, f.top + window.scrollY - window.innerHeight + 90);
  });
  let m = await measure();
  expect(m.bottom).toBeGreaterThan(m.vh);

  await page.evaluate(() => window.__snakeTest.start());
  m = await measure();
  // Scoreboard + playfield are both fully on-screen, with the scoreboard visible.
  expect(m.hudTop).toBeGreaterThanOrEqual(0);
  expect(m.bottom).toBeLessThanOrEqual(m.vh + 1);

  // Paused pages scroll freely; resuming brings it all back before locking.
  await page.evaluate(() => window.__snakeTest.pause());
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.evaluate(() => window.__snakeTest.resume());
  m = await measure();
  expect(m.hudTop).toBeGreaterThanOrEqual(0);
  expect(m.bottom).toBeLessThanOrEqual(m.vh + 1);
  await expect(page.locator('body')).toHaveClass(/is-playing/);
  await page.evaluate(() => window.__snakeTest.quit());
});

test('the pause button is touch-only and the show-pause setting is gone', async ({ page }, info) => {
  await openGame(page);
  await expect(page.locator('#toggle-pause')).toHaveCount(0);
  await expect(page.getByText('Show pause button')).toHaveCount(0);
  if (info.project.name === 'mobile') {
    await expect(page.locator('#pause-btn')).toBeVisible();
  } else {
    await expect(page.locator('#pause-btn')).toBeHidden();
    await page.evaluate(() => window.__snakeTest.start());
    await expect(page.locator('#pause-btn')).toBeHidden();
    await page.keyboard.press('p');                       // desktop pauses with P / Esc
    expect(await page.evaluate(() => window.__snakeTest.state().paused)).toBe(true);
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => window.__snakeTest.state().paused)).toBe(false);
    await page.evaluate(() => window.__snakeTest.quit());
  }
});

// ---------------------------------------------------------------------------
// Live tests: the real API and database, no mocks. Accounts they create are
// deleted afterwards. Set DATABASE_URL to point them at another database.
// ---------------------------------------------------------------------------

const createdUsers = [];
const dbUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/app_db';

function newUsername() {
  const name = 'e2e' + Math.random().toString(36).slice(2, 9);
  createdUsers.push(name);
  return name;
}

async function countRuns(username) {
  const pool = new pg.Pool({ connectionString: dbUrl, max: 1 });
  try {
    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM scores s JOIN users u ON u.id = s.user_id WHERE u.username = $1',
      [username],
    );
    return rows[0].n;
  } finally {
    await pool.end();
  }
}

test.afterAll(async () => {
  if (!createdUsers.length) return;
  const pool = new pg.Pool({ connectionString: dbUrl, max: 1 });
  try {
    await pool.query('DELETE FROM scores WHERE user_id IN (SELECT id FROM users WHERE username = ANY($1))', [createdUsers]);
    await pool.query('DELETE FROM users WHERE username = ANY($1)', [createdUsers]);
  } catch (err) {
    console.warn('Could not clean up test accounts:', err.message);
  } finally {
    await pool.end();
  }
});

// `scope` is a Page, or a Frame when the app is embedded.
async function signUp(scope, trigger, username, projectName) {
  await activate(trigger, projectName);
  await expect(scope.locator('#auth-dialog')).toHaveAttribute('open', '');
  await scope.locator('#form-create input[name="username"]').fill(username);
  await scope.locator('#form-create input[name="password"]').fill('e2e-pass-123');
  // Creating an account requires the password twice (8+ characters).
  const confirm = scope.locator('#form-create input[name="confirm-password"]');
  if (await confirm.count()) await confirm.fill('e2e-pass-123');
  await activate(scope.locator('#form-create button[type="submit"]'), projectName);
  await expect(scope.locator('#auth-dialog')).not.toHaveAttribute('open');
}

// Starts a run, eats the seeded food, then quits through the pause menu.
async function playAndQuit(scope, projectName, startSelector = '#btn-start') {
  await scope.evaluate(() => window.__seedFood());
  await activate(scope.locator(startSelector), projectName);
  await expect.poll(() => scope.evaluate(() => window.__snakeTest.state().score), { timeout: 5000 })
    .toBeGreaterThanOrEqual(1);
  const score = await scope.evaluate(() => window.__snakeTest.state().score);
  await scope.evaluate(() => window.__snakeTest.pause());
  await activate(scope.locator('#btn-quit'), projectName);
  await expect(scope.locator('#panel-over')).toHaveClass(/is-visible/);
  await expect(scope.locator('#final-score')).toHaveText(String(score));
  return score;
}

// Plays until the snake actually crashes (by turning in a tight circle), so
// the run counts toward every stat and appears in the game log.
async function playAndCrash(scope, projectName, startSelector = '#btn-start') {
  await scope.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('snake.settings.v1') || '{}');
    s.useCustomGrowth = true; s.growthCustom = 100; s.speedId = 2; // Fast (130ms), growth 100
    localStorage.setItem('snake.settings.v1', JSON.stringify(s));
  });
  await scope.reload({ waitUntil: 'domcontentloaded' });
  await scope.waitForFunction(() => Boolean(window.__snakeTest), null, { timeout: 20000 });
  await scope.evaluate(() => window.__seedFood());
  await activate(scope.locator(startSelector), projectName);
  await expect.poll(() => scope.evaluate(() => window.__snakeTest.state().score)).toBeGreaterThanOrEqual(1);
  // With growth 100 on a 24-column board, the wrapping tail meets the head on the
  // 24th step (takes ~3 seconds). Simply wait for the guaranteed self-collision.
  await scope.waitForTimeout(4500);
  await scope.waitForFunction(() => !window.__snakeTest.state().running, null, { timeout: 6000 });
  const score = await scope.evaluate(() => window.__snakeTest.state().score);
  await expect(scope.locator('#panel-over')).toHaveClass(/is-visible/);
  await expect(scope.locator('#final-score')).toHaveText(String(score));
  return score;
}

async function boardRows(scope) {
  return scope.locator('#board-body tr').evaluateAll((trs) => trs.map((tr) => ({
    name: tr.querySelector('.user__name')?.textContent ?? null,
    score: tr.querySelector('.num b') ? Number(tr.querySelector('.num b').textContent) : null,
  })).filter((row) => row.name));
}

test('a signed-in run is saved to the account and shown on the leaderboard', async ({ page }, info) => {
  const username = newUsername();
  await openLive(page);
  await signUp(page, page.locator('#btn-open-create'), username, info.project.name);
  const score = await playAndQuit(page, info.project.name);

  await expect(page.locator('#final-save-text')).toHaveText(`Saved to the leaderboard as ${username}.`);
  const row = page.locator('#board-body tr', { hasText: username });
  await expect(row).toHaveCount(1);
  await expect(row.locator('.num b')).toHaveText(String(score));
  await expect(row).toHaveClass(/is-you/);
  expect(await countRuns(username)).toBe(1);
});

test('guest runs are never stored, and there is no anonymous bench', async ({ page }, info) => {
  await openLive(page);
  const posts = [];
  page.on('request', (req) => { if (req.method() === 'POST' && req.url().includes('/api/scores')) posts.push(req); });

  await playAndQuit(page, info.project.name);
  await expect(page.locator('#final-save')).toBeVisible();
  await expect(page.locator('#final-save-text')).toContainText('Guest runs are not saved');
  expect(posts.length).toBe(0);

  const refused = await page.request.post('/api/scores', { data: { score: 3, speed_level: 3, growth: 1 } });
  expect(refused.status()).toBe(401);
  const body = await (await page.request.get('/api/scores')).json();
  expect(body).toEqual({ best: {} });
  await expect(page.locator('#records-body')).toHaveCount(0);
});

test('a guest run is held, then saved to the leaderboard the moment they sign in', async ({ page }, info) => {
  const username = newUsername();
  await openLive(page);
  const posts = [];
  page.on('request', (req) => { if (req.method() === 'POST' && req.url().includes('/api/scores')) posts.push(req); });

  const score = await playAndQuit(page, info.project.name);
  expect(posts.length).toBe(0);

  await signUp(page, page.locator('#btn-final-create'), username, info.project.name);
  await expect.poll(() => posts.length).toBe(1);
  await expect(page.locator('#final-save-text')).toHaveText(`Saved to the leaderboard as ${username}.`);

  const row = page.locator('#board-body tr', { hasText: username });
  await expect(row).toHaveCount(1);
  await expect(row.locator('.num b')).toHaveText(String(score));
  expect(await countRuns(username)).toBe(1);
});

test('signed-in runs save from inside a cross-site iframe where the cookie is blocked', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'Frame embedding is exercised once, on desktop');
  const username = newUsername();
  const harness = new URL(BASE).hostname === 'localhost' ? 'http://127.0.0.1:4173' : 'http://localhost:4173';
  await installHooks(page, 'classic');
  await page.route(harness + '/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><body style="margin:0"><iframe id="app" src="${BASE}/" style="width:100vw;height:100vh;border:0"></iframe></body></html>`,
  }));
  await page.goto(harness + '/');
  let frame;
  await expect.poll(() => { frame = page.frames().find((f) => f.url().startsWith(BASE)); return Boolean(frame); }).toBe(true);
  await frame.waitForFunction(() => Boolean(window.__snakeTest));

  await signUp(frame, frame.locator('#btn-open-create'), username, info.project.name);
  const cookies = (await page.context().cookies(BASE)).filter((c) => c.name.includes('session'));
  test.info().annotations.push({ type: 'cookie kept by the browser', description: String(cookies.length > 0) });

  const score = await playAndQuit(frame, info.project.name);
  await expect(frame.locator('#final-save-text')).toHaveText(`Saved to the leaderboard as ${username}.`);
  const row = frame.locator('#board-body tr', { hasText: username });
  await expect(row).toHaveCount(1);
  await expect(row.locator('.num b')).toHaveText(String(score));
  expect(await countRuns(username)).toBe(1);
});

test('the save note never claims success when the server refuses the run', async ({ page }, info) => {
  const username = newUsername();
  await openLive(page);
  await signUp(page, page.locator('#btn-open-create'), username, info.project.name);
  // Make the server reject the session: delete this account's sessions out from under it.
  const pool = new pg.Pool({ connectionString: dbUrl, max: 1 });
  await pool.query('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username = $1)', [username]);
  await pool.end();

  await playAndQuit(page, info.project.name);
  await expect(page.locator('#final-save-text')).toContainText('no longer valid');
  await expect(page.locator('#final-save-text')).not.toContainText('Saved to the leaderboard');
  await expect(page.locator('#auth-out')).toBeVisible();
  expect(await countRuns(username)).toBe(0);
});

test('after a run ends, the next one cannot start for one second', async ({ page }) => {
  await openLive(page);
  await page.evaluate(() => window.__snakeTest.start());
  await page.evaluate(() => window.__snakeTest.quit());

  await expect(page.locator('#btn-again')).toBeDisabled();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowRight');
  expect(await page.evaluate(() => window.__snakeTest.state().running)).toBe(false);

  await expect(page.locator('#btn-again')).toBeEnabled({ timeout: 2000 });
  await page.keyboard.press('ArrowRight');
  expect(await page.evaluate(() => window.__snakeTest.state().running)).toBe(true);
});

test('the scoreboard shows this mode, your best and your recent runs', async ({ page }, info) => {
  await openLive(page);
  await expect(page.locator('#recent-runs .runs__empty')).toBeVisible();
  await expect(page.locator('#mode-stats')).toHaveText('No runs in this mode yet');
  await expect(page.locator('#scoreboard [data-live-mode]')).toHaveText('Chill · ×1');

  const first = await playAndQuit(page, info.project.name);
  await expect(page.locator('#btn-again')).toBeEnabled({ timeout: 2000 });
  const second = await playAndQuit(page, info.project.name, '#btn-again');

  await expect(page.locator('#recent-runs .runs__item')).toHaveCount(2);
  await expect(page.locator('#recent-runs .runs__item').first().locator('.runs__score')).toHaveText(String(second));
  await expect(page.locator('#recent-runs .runs__item').first().locator('.runs__mode')).toHaveText('Chill · ×1');
  await expect(page.locator('#mode-stats')).toContainText('Played 2');
  await expect(page.locator('#mode-stats')).toContainText(`Last ${second}`);
  const best = Math.max(first, second);
  await expect(page.locator('#hud [data-live-best]')).toHaveText(String(best));
  await expect(page.locator('#best-score')).toHaveText(String(best));

  // The history survives a reload.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#recent-runs .runs__item')).toHaveCount(2);
});

test('leaderboard: two board buttons, the active one filled, with exact modifier filters', async ({ page, request }, info) => {
  const alice = newUsername();
  const bob = newUsername();

  async function signup(name) {
    const res = await request.post('/api/auth/signup', { data: { username: name, password: 'e2e-pass-123' } });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.token).toMatch(/^[a-f0-9]{64}$/);
    return body.token;
  }
  async function post(token, data) {
    // The bearer token alone must authenticate, even though the shared request
    // context also holds the other user's cookie.
    const res = await request.post('/api/scores', { headers: { Authorization: `Bearer ${token}` }, data });
    expect(res.status()).toBe(201);
  }
  const tokenA = await signup(alice);
  await post(tokenA, { score: 5, speed_level: 3, growth: 1 });
  await post(tokenA, { score: 9, speed_level: 4, growth: 2 });
  await post(tokenA, { score: 7, speed_custom: 20, growth: 1 });
  const tokenB = await signup(bob);
  await post(tokenB, { score: 8, speed_level: 3, growth: 1 });

  await openLive(page, 'classic', { speedId: 3, growth: 1 });
  const mine = async () => (await boardRows(page)).filter((r) => r.name === alice || r.name === bob);
  const std = page.locator('#lb-tab-standard');
  const cus = page.locator('#lb-tab-custom');
  const unfilled = 'rgba(0, 0, 0, 0)';

  // Standard is selected and filled; Custom is not.
  await expect(std).toHaveClass(/is-active/);
  await expect(std).not.toHaveCSS('background-color', unfilled);
  await expect(cus).toHaveCSS('background-color', unfilled);

  // No filter: every best run per combination, ranked by score.
  await expect.poll(async () => (await mine()).map((r) => r.score)).toEqual([9, 8, 5]);

  // Speed = Normal.
  await activate(page.locator('#filter-speed .fchip[data-value="3"]'), info.project.name);
  await expect(page.locator('#filter-speed .fchip[data-value="3"]')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await mine()).map((r) => `${r.name === alice ? 'A' : 'B'}${r.score}`)).toEqual(['B8', 'A5']);

  // Speed = Fast and growth = x2: exactly one run matches.
  await activate(page.locator('#filter-speed .fchip[data-value="4"]'), info.project.name);
  await activate(page.locator('#filter-growth .fchip[data-value="2"]'), info.project.name);
  await expect.poll(async () => (await mine()).map((r) => r.score)).toEqual([9]);
  await expect(page.locator('#lb-status')).toContainText('Standard board');
  await expect(page.locator('#lb-status')).toContainText('Fast');
  await expect(page.locator('#lb-status')).toContainText('×2');

  // Custom filters do not exist on the Standard board.
  await expect(page.locator('#filter-speed .fchip[data-value="c"]')).toHaveCount(0);

  // The Custom button fills in, the Standard one empties, and only custom runs show.
  await activate(cus, info.project.name);
  await expect(cus).toHaveClass(/is-active/);
  await expect(cus).not.toHaveCSS('background-color', unfilled);
  await expect(std).toHaveCSS('background-color', unfilled);
  await expect.poll(async () => (await mine()).map((r) => `${r.name === alice ? 'A' : 'B'}${r.score}`)).toEqual(['A7']);
  await expect(page.locator('#lb-status')).toContainText('Custom board');

  // Exact custom value: 20 ms matches, 21 ms does not.
  await activate(page.locator('#filter-speed .fchip[data-value="c"]'), info.project.name);
  const exact = page.locator('#filter-speed .fchip-input');
  await expect(exact).toBeVisible();
  await exact.fill('20');
  await expect.poll(async () => (await mine()).map((r) => r.score)).toEqual([7]);
  await exact.fill('21');
  await expect.poll(async () => (await mine()).length).toBe(0);
  await expect(page.locator('#board-body .empty')).toContainText('No runs match these filters');

  // Reset puts the board back to everything.
  await activate(page.locator('#filter-reset'), info.project.name);
  await expect.poll(async () => (await mine()).map((r) => r.score)).toEqual([7]);

  // "Match my settings" jumps to the board and filters for the current modifiers.
  await activate(page.locator('#filter-mine'), info.project.name);
  await expect(std).toHaveClass(/is-active/);
  await expect(page.locator('#filter-speed .fchip[data-value="3"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#filter-growth .fchip[data-value="1"]')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await mine()).map((r) => r.score)).toEqual([8, 5]);
});

test('the SIGN IN (login) path works: create, sign out, wrong password refused, sign in, save', async ({ page }, info) => {
  const username = newUsername();
  await openLive(page);
  // create an account
  await signUp(page, page.locator('#btn-open-create'), username, info.project.name);
  await expect(page.locator('#auth-user')).toContainText(username);
  // sign out
  await activate(page.locator('#btn-logout'), info.project.name);
  await expect(page.locator('#auth-out')).toBeVisible();
  await expect(page.locator('#auth-in')).toBeHidden();

  // A wrong password is refused and the dialog stays open with an error.
  // (Tested while signed OUT, so the Sign in button is visible.)
  await activate(page.locator('#btn-open-login'), info.project.name);
  await page.locator('#form-login input[name="username"]').fill(username);
  await page.locator('#form-login input[name="password"]').fill('wrong-password');
  await activate(page.locator('#form-login button[type="submit"]'), info.project.name);
  await expect(page.locator('#auth-error-login')).toContainText('Invalid username or password');
  await expect(page.locator('#auth-dialog')).toHaveAttribute('open', '');
  await expect(page.locator('#auth-in')).toBeHidden(); // still signed out
  await activate(page.locator('#auth-close'), info.project.name);

  // sign back in through the LOGIN form with the correct password
  await activate(page.locator('#btn-open-login'), info.project.name);
  await page.locator('#form-login input[name="username"]').fill(username);
  await page.locator('#form-login input[name="password"]').fill('e2e-pass-123');
  await activate(page.locator('#form-login button[type="submit"]'), info.project.name);
  await expect(page.locator('#auth-dialog')).not.toHaveAttribute('open');
  await expect(page.locator('#auth-user')).toContainText(username);

  // now actually play and save — it must land on the board
  const score = await playAndQuit(page, info.project.name);
  await expect(page.locator('#final-save-text')).toHaveText(`Saved to the leaderboard as ${username}.`);
  const row = page.locator('#board-body tr', { hasText: username });
  await expect(row).toHaveCount(1);
  await expect(row.locator('.num b')).toHaveText(String(score));
  expect(await countRuns(username)).toBe(1);
});

test('sign-in and saving still work when localStorage is blocked (throws)', async ({ page }, info) => {
  // The page must not break when localStorage throws, and sign-in + saving must
  // still succeed for the session (the in-memory token carries the session; the
  // bearer-only path is covered by the API contract test, cookie-blocking by the
  // cross-site iframe test).
  test.skip(info.project.name !== 'desktop', 'Storage-blocking is exercised once, on desktop');
  const username = newUsername();
  await installHooks(page, 'classic');
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { throw new DOMException('blocked', 'SecurityError'); },
    });
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__snakeTest));
  const lsBlocked = await page.evaluate(() => { try { localStorage.getItem('x'); return false; } catch { return true; } });
  expect(lsBlocked).toBe(true);

  await signUp(page, page.locator('#btn-open-create'), username, info.project.name);
  await expect(page.locator('#auth-user')).toContainText(username);
  const score = await playAndQuit(page, info.project.name);
  await expect(page.locator('#final-save-text')).toHaveText(`Saved to the leaderboard as ${username}.`);
  const row = page.locator('#board-body tr', { hasText: username });
  await expect(row).toHaveCount(1);
  await expect(row.locator('.num b')).toHaveText(String(score));
  expect(await countRuns(username)).toBe(1);
});

test('after saving, the leaderboard flashes and highlights your own row', async ({ page }, info) => {
  const username = newUsername();
  await openLive(page);
  await signUp(page, page.locator('#btn-open-create'), username, info.project.name);
  await playAndQuit(page, info.project.name);
  // The just-saved row is marked, tagged "you", and carries your score.
  const row = page.locator('#board-body tr.just-saved', { hasText: username });
  await expect(row).toHaveCount(1);
  await expect(row).toHaveClass(/is-you/);
  await expect(row.locator('.you-tag')).toHaveText('you');
  // The signed-in chip shows a live dot.
  await expect(page.locator('#auth-user .chip__dot')).toBeVisible();
  await expect(page.locator('#auth-user')).toContainText(username);
});

// ---------------------------------------------------------------------------
// Death screen + profile page
// ---------------------------------------------------------------------------

test('the death screen has a Quit button (no Change modifiers) that returns to the start screen', async ({ page }, info) => {
  await openLive(page);
  await page.evaluate(() => window.__snakeTest.start());
  await page.evaluate(() => window.__snakeTest.quit());
  const over = page.locator('#panel-over');
  await expect(over).toHaveClass(/is-visible/);

  await expect(over.getByText('Change modifiers')).toHaveCount(0);
  await expect(page.locator('#btn-settings-over')).toHaveCount(0);
  // The panel's own actions (guests also see sign-in buttons inside the save note).
  await expect(over.locator(':scope > .panel__actions').getByRole('button')).toHaveText(['Play again', 'Quit']);

  await activate(page.locator('#btn-quit-over'), info.project.name);
  await expect(page.locator('#panel-start')).toHaveClass(/is-visible/);
  await expect(over).not.toHaveClass(/is-visible/);
  await expect(page.locator('#settings-speed button').first()).toBeEnabled();   // modifiers are free again
  await expect(page.locator('#btn-start')).toBeVisible();
});

// Backdated games straight into the database, so charts and the heatmap have history.
async function seedGames(username, games) {
  const pool = new pg.Pool({ connectionString: dbUrl, max: 1 });
  try {
    const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    const userId = rows[0].id;
    for (const g of games) {
      const speedKey = g.speedCustom != null ? `c${g.speedCustom}` : String(g.speedLevel);
      const growthKey = g.growthCustom != null ? `c${g.growthCustom}` : String(g.growth);
      const when = g.daysAgo === 0 ? 'now()' : `date_trunc('day', now()) - interval '${g.daysAgo} days' + interval '12 hours'`;
      await pool.query(
        `INSERT INTO scores (score, speed_level, speed_custom, growth, growth_custom, combo, user_id, created_at, end_state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, ${when}, $8::jsonb)`,
        [g.score, g.speedLevel ?? null, g.speedCustom ?? null, g.growth ?? null, g.growthCustom ?? null,
         `${speedKey}-${growthKey}`, userId, JSON.stringify(g.endState ?? null)],
      );
    }
  } finally {
    await pool.end();
  }
}

const crashState = (head, cause = 'crash') => ({
  cols: 24, rows: 18,
  snake: [head, head - 1, head - 2, head - 3],
  food: 5 * 24 + 20,
  crash: cause === 'crash' ? head + 1 : null,
  cause,
});

// 8 games over 7 distinct days. Normal x1 is the favorite (5 games); best is Fast x2 (12).
const HISTORY = [
  { daysAgo: 0, score: 5, speedLevel: 3, growth: 1, endState: crashState(100) },
  { daysAgo: 0, score: 9, speedLevel: 3, growth: 1, endState: crashState(130) },
  { daysAgo: 1, score: 4, speedLevel: 3, growth: 1, endState: crashState(160) },
  { daysAgo: 2, score: 12, speedLevel: 4, growth: 2, endState: crashState(190, 'crash') },
  { daysAgo: 5, score: 7, speedLevel: 3, growth: 1, endState: crashState(220) },
  { daysAgo: 20, score: 8, speedCustom: 42, growth: 1, endState: crashState(250) },
  { daysAgo: 40, score: 3, speedLevel: 3, growth: 1, endState: crashState(280) },
  { daysAgo: 100, score: 2, speedLevel: 1, growth: 1, endState: null },   // an older game with no snapshot
];

test('profile: guests are asked to sign in, and the API refuses them', async ({ page, request }) => {
  await page.goto('/profile', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.pf-gate__title')).toHaveText('Sign in to see your profile');
  await expect(page.locator('#pf-name')).toHaveCount(0);
  await page.locator('#gate-signin').click();
  await expect(page.locator('#auth-dialog')).toHaveAttribute('open', '');
  expect((await request.get('/api/profile', { headers: { Authorization: 'Bearer ' + 'a'.repeat(64) } })).status()).toBe(401);
});

test('profile: crash runs appear with their ending snake, low-score quits do not', async ({ page, request }, info) => {
  const username = newUsername();
  await openLive(page);
  await signUp(page, page.locator('#btn-open-create'), username, info.project.name);

  // A quit run below 10 points is saved but excluded from every stat and the log.
  const quitScore = await playAndQuit(page, info.project.name);
  expect(quitScore).toBeLessThan(10);
  await expect(page.locator('#final-save-text')).toContainText('Saved');

  // A crash run is counted and shown with its ending position.
  const crashScore = await playAndCrash(page, info.project.name, '#btn-again');
  await expect(page.locator('#final-save-text')).toContainText('Saved');

  await activate(page.getByRole('link', { name: 'Profile', exact: true }), info.project.name);
  await expect(page).toHaveURL(/\/profile$/);
  await expect(page.locator('#pf-name')).toHaveText(username);
  await expect(page.locator('.pf-level__num')).toContainText('Level');

  // Games played counts only completed (non-quit) runs; total counts both.
  await expect(page.locator('.pf-tile[data-stat="games"] .pf-tile__value')).toHaveText('1');
  await expect(page.locator('.pf-tile[data-stat="total"] .pf-tile__value')).toHaveText('2');
  await expect(page.locator('.pf-tile[data-stat="best"] .pf-tile__value')).toHaveText(String(crashScore));

  // The log shows only the crash; the low-score quit is hidden.
  const item = page.locator('.log__item');
  await expect(item).toHaveCount(1);
  await expect(item.locator('.log__score')).toHaveText(String(crashScore));
  await expect(item.locator('.log__meta')).toContainText('Crashed');
  await expect(item.locator('svg.board')).toBeVisible();
  await expect(page.locator('#pf-log-count')).toContainText('some quits hidden');

  // The stored snapshot matches what the mini board draws.
  const pool = new pg.Pool({ connectionString: dbUrl, max: 1 });
  const { rows } = await pool.query(
    "SELECT s.end_state FROM scores s JOIN users u ON u.id = s.user_id WHERE u.username = $1 AND s.end_state->>'cause' = 'crash'", [username]);
  await pool.end();
  const state = rows[0].end_state;
  expect(state.cols).toBe(24);
  expect(state.rows).toBe(18);
  expect(state.cause).toBe('crash');
  expect(state.crash).not.toBeNull();
  expect(new Set(state.snake).size).toBe(state.snake.length);
  const drawn = (await item.locator('svg.board path.b-snake').getAttribute('d')).split('M').length - 1;
  expect(drawn).toBe(state.snake.length);

  // Removing asks first; Cancel keeps the game.
  await activate(item.locator('[data-remove]'), info.project.name);
  await expect(item.locator('.log__ask')).toHaveText('Remove this game?');
  await activate(item.locator('[data-remove-no]'), info.project.name);
  expect(await countRuns(username)).toBe(2);

  await activate(item.locator('[data-remove]'), info.project.name);
  await activate(item.locator('[data-remove-yes]'), info.project.name);
  await expect(page.locator('.log__item')).toHaveCount(0);
  await expect(page.locator('.pf-tile[data-stat="games"] .pf-tile__value')).toHaveText('0');
  await expect(page.locator('#pf-toast')).toContainText('removed');
  expect(await countRuns(username)).toBe(1);   // only the hidden quit run remains

  const board = await (await request.get('/api/leaderboard?board=custom')).json();
  expect(board.rows.some((r) => r.username === username)).toBe(false);
});

test('profile: stats, progress chart, activity heatmap and favorite mode reflect your history', async ({ page }, info) => {
  const username = newUsername();
  await openLive(page);
  await signUp(page, page.locator('#btn-open-create'), username, info.project.name);
  await seedGames(username, HISTORY);
  await page.goto('/profile', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#pf-name')).toHaveText(username);

  const tile = (key) => page.locator(`.pf-tile[data-stat="${key}"] .pf-tile__value`);
  await expect(tile('games')).toHaveText('8');
  await expect(tile('best')).toHaveText('12');
  await expect(page.locator('.pf-tile[data-stat="best"] .pf-tile__sub')).toHaveText('Fast · ×2');
  await expect(tile('food')).toHaveText('50');
  await expect(tile('active')).toHaveText('7');
  await expect(tile('streak')).toHaveText('3');                     // today, yesterday, two days ago
  await expect(page.locator('.pf-tile[data-stat="streak"] .pf-tile__sub')).toContainText('longest 3 days');

  // Favorite mode: Normal x1 with 5 of 8 games.
  await expect(page.locator('#pf-fav-mode b')).toHaveText('Normal · ×1');
  await expect(page.locator('#pf-fav-mode')).toContainText('5 games');
  await expect(page.locator('#pf-fav-mode')).toContainText('63%');
  await expect(page.locator('.mb__row').first()).toHaveClass(/is-fav/);

  // High scores: one row per mode, best first.
  const bests = page.locator('.pf-bests tbody tr');
  await expect(bests).toHaveCount(4);
  await expect(bests.first().locator('td').first()).toHaveText('Fast · ×2');
  await expect(bests.first().locator('.num')).toHaveText('12');

  // Heatmap: one cell per day for the last year, lit on exactly the days played.
  const cells = page.locator('#pf-heat .hm');
  expect(await cells.count()).toBeGreaterThanOrEqual(365);
  await expect(page.locator('#pf-heat .hm:not(.lv0)')).toHaveCount(7);
  const todayCell = page.locator('#pf-heat .hm').last();
  await expect(todayCell).toHaveAttribute('data-count', '2');
  await expect(todayCell).toHaveClass(/lv2/);
  await expect(todayCell).toHaveAttribute('title', /2 games on/);
  await expect(page.locator('#pf-heat-summary')).toContainText('8 games');
  await expect(page.locator('#pf-heat-summary')).toContainText('7 active days');

  // Progress chart: every game is a dot, with a rolling average and best-so-far line.
  const dots = page.locator('#pf-chart svg.chart circle.pt');
  await expect(dots).toHaveCount(8);
  await expect(page.locator('#pf-chart .avg-line')).toHaveCount(1);
  await expect(page.locator('#pf-chart .best-line')).toHaveCount(1);
  await expect(page.locator('#pf-trend')).toContainText('Your last 4 games average');
  await page.locator('#pf-chart-mode').selectOption('3-1');
  await expect(dots).toHaveCount(5);                                // Normal x1 only
  await page.locator('#pf-chart-mode').selectOption('4-2');
  await expect(page.locator('#pf-chart .pf-empty')).toContainText('at least two completed games');

  // Game log: newest first, filterable by mode; the old game has no snapshot.
  const log = page.locator('.log__item');
  await expect(log).toHaveCount(8);
  await expect(log.first().locator('.log__score')).toHaveText('9');
  await expect(log.last().locator('.board--none')).toBeVisible();
  await expect(page.locator('.log__item svg.board')).toHaveCount(7);
  await expect(page.locator('.log__item svg.board .b-crash')).toHaveCount(7);   // all are crash runs now
  await page.locator('#pf-log-mode').selectOption('4-2');
  await expect(log).toHaveCount(1);
  await expect(log.first().locator('.log__meta')).toContainText('Crashed');

  // Remove that game: every number, chart and the DB follow.
  await activate(log.first().locator('[data-remove]'), info.project.name);
  await activate(log.first().locator('[data-remove-yes]'), info.project.name);
  // That mode is now empty, so the log's mode filter falls back to "All modes".
  await expect(page.locator('#pf-log-mode')).toHaveValue('all');
  await expect(log).toHaveCount(7);
  await expect(tile('games')).toHaveText('7');
  await expect(tile('best')).toHaveText('9');
  await expect(page.locator('#pf-log-mode option')).toHaveCount(4);   // "All" + the 3 remaining modes
  await expect(page.locator('#pf-chart svg.chart circle.pt')).toHaveCount(7);
  expect(await countRuns(username)).toBe(7);
});

test('profile: pick a favorite theme, keep it across reloads, and play in it', async ({ page }, info) => {
  const username = newUsername();
  await openLive(page, 'classic');
  await signUp(page, page.locator('#btn-open-create'), username, info.project.name);
  await page.goto('/profile', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#pf-name')).toHaveText(username);
  await expect(page.locator('#pf-fav-badge')).toHaveText('Not picked yet');
  await expect(page.locator('#pf-theme-apply')).toBeDisabled();

  await activate(page.locator('[data-fav-theme="violet"]'), info.project.name);
  await expect(page.locator('#pf-theme-status')).toHaveText('Favorite theme saved: Violet.');
  await expect(page.locator('[data-fav-theme="violet"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#pf-fav-badge')).toContainText('Violet');

  const pool = new pg.Pool({ connectionString: dbUrl, max: 1 });
  const stored = async () => (await pool.query('SELECT favorite_theme FROM users WHERE username = $1', [username])).rows[0].favorite_theme;
  expect(await stored()).toBe('violet');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#pf-fav-badge')).toContainText('Violet');
  await expect(page.locator('[data-fav-theme="violet"]')).toHaveAttribute('aria-pressed', 'true');

  // "Play in this theme" applies it now and makes it the game's theme.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'classic');
  await activate(page.locator('#pf-theme-apply'), info.project.name);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'violet');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('snake.settings.v1')).theme)).toBe('violet');

  await activate(page.locator('#pf-theme-clear'), info.project.name);
  await expect(page.locator('#pf-fav-badge')).toHaveText('Not picked yet');
  expect(await stored()).toBeNull();
  await pool.end();
});

test('profile API: ownership, validation and a sanitised ending position', async ({ request, playwright }) => {
  // Sign up through the shared context (it keeps the session cookies); do every check through
  // `bare`, which holds no cookies, so only the bearer token can authenticate.
  const alice = newUsername();
  const bob = newUsername();
  const bare = await playwright.request.newContext({ baseURL: BASE });
  try {
    const join = async (name) => (await (await request.post('/api/auth/signup', { data: { username: name, password: 'e2e-pass-123' } })).json()).token;
    const tokenA = await join(alice);
    const tokenB = await join(bob);
    const as = (token) => ({ Authorization: `Bearer ${token}` });
    const save = (token, end_state) => bare.post('/api/scores', {
      headers: as(token), data: { score: 6, speed_level: 3, growth: 1, end_state },
    });

    // A valid snapshot is stored exactly; a hostile one is dropped but the score still saves.
    const good = { cols: 24, rows: 18, snake: [50, 49, 48], food: 200, crash: 51, cause: 'crash' };
    expect((await save(tokenA, good)).status()).toBe(201);
    for (const bad of [
      { cols: 24, rows: 18, snake: [50, 50], cause: 'quit' },               // overlapping cells
      { cols: 24, rows: 18, snake: [99999], cause: 'quit' },               // out of range
      { cols: 9999, rows: 18, snake: [1], cause: 'quit' },                 // absurd size
      { cols: 24, rows: 18, snake: 'nope', cause: 'quit' },
      'not an object',
    ]) {
      expect((await save(tokenA, bad)).status()).toBe(201);
    }
    const profile = await (await bare.get('/api/profile', { headers: as(tokenA) })).json();
    expect(profile.user.username).toBe(alice);
    expect(profile.user.favorite_theme).toBeNull();
    expect(profile.user.games).toHaveLength(6);
    const kept = profile.user.games.filter((g) => g.end_state);
    expect(kept).toHaveLength(1);
    expect(kept[0].end_state).toEqual(good);
    expect(profile.user.games.filter((g) => g.end_state === null)).toHaveLength(5);

    // Favorite theme: validated, clearable, JSON only.
    const patch = (token, data, headers = {}) => bare.patch('/api/profile', { headers: { ...as(token), ...headers }, data });
    expect((await patch(tokenA, { favorite_theme: 'nope' })).status()).toBe(400);
    expect((await patch(tokenA, {})).status()).toBe(400);
    expect((await patch(tokenA, { favorite_theme: 'terminal' })).status()).toBe(200);
    expect((await (await bare.get('/api/profile', { headers: as(tokenA) })).json()).user.favorite_theme).toBe('terminal');
    expect((await patch(tokenA, { favorite_theme: null })).status()).toBe(200);
    expect((await bare.patch('/api/profile', { headers: { ...as(tokenA), 'content-type': 'text/plain' }, data: '{}' })).status()).toBe(415);
    expect((await bare.patch('/api/profile', { data: { favorite_theme: 'arcade' } })).status()).toBe(401);

    // Removal is yours alone: another player's id is indistinguishable from a missing one.
    const gameId = kept[0].id;
    expect((await bare.delete(`/api/games/${gameId}`, { headers: as(tokenB), data: {} })).status()).toBe(404);
    expect((await bare.delete(`/api/games/${gameId}`, { data: {} })).status()).toBe(401);
    expect((await bare.delete(`/api/games/abc`, { headers: as(tokenA), data: {} })).status()).toBe(404);
    expect((await bare.delete(`/api/games/${gameId}`, { headers: as(tokenA), data: {} })).status()).toBe(200);
    expect((await bare.delete(`/api/games/${gameId}`, { headers: as(tokenA), data: {} })).status()).toBe(404);
    expect((await (await bare.get('/api/profile', { headers: as(tokenA) })).json()).user.games).toHaveLength(5);
    expect((await (await bare.get('/api/profile', { headers: as(tokenB) })).json()).user.games).toHaveLength(0);
  } finally {
    await bare.dispose();
  }
});

test('API contract: filters are validated, writes need JSON, and a bearer token authenticates', async ({ request, playwright }) => {
  const name = newUsername();
  expect((await request.get('/api/leaderboard?speed=99')).status()).toBe(400);
  expect((await request.get('/api/leaderboard?growth=abc')).status()).toBe(400);
  expect((await request.get('/api/leaderboard?board=custom&speed=c5')).status()).toBe(200);
  const ok = await (await request.get('/api/leaderboard?board=standard&speed=3&growth=1')).json();
  expect(Array.isArray(ok.rows)).toBe(true);
  expect(typeof ok.total).toBe('number');

  // A form-style (non-JSON) write is refused before anything else happens.
  for (const path of ['/api/scores', '/api/auth/login', '/api/auth/signup', '/api/auth/logout']) {
    const res = await request.post(path, { headers: { 'content-type': 'text/plain' }, data: '{"score":1}' });
    expect(res.status(), path).toBe(415);
  }

  // Bearer token only, on a context that holds no cookies at all.
  const signup = await request.post('/api/auth/signup', { data: { username: name, password: 'e2e-pass-123' } });
  const { token } = await signup.json();
  const bare = await playwright.request.newContext({ baseURL: BASE });
  try {
    const authed = { Authorization: `Bearer ${token}` };
    expect((await (await bare.get('/api/auth/me', { headers: authed })).json()).user.username).toBe(name);
    expect((await bare.post('/api/scores', { headers: authed, data: { score: 2, speed_level: 3, growth: 1 } })).status()).toBe(201);
    expect((await (await bare.get('/api/scores', { headers: authed })).json()).best['3-1']).toBe(2);
    expect((await bare.post('/api/scores', { data: { score: 2, speed_level: 3, growth: 1 } })).status()).toBe(401);
    expect((await bare.post('/api/auth/logout', { headers: authed, data: {} })).status()).toBe(200);
    expect((await (await bare.get('/api/auth/me', { headers: authed })).json()).user).toBeNull();
  } finally {
    await bare.dispose();
  }
});

// ---------------------------------------------------------------------------
// Small-screen results, natural-height run history, and the corner score HUD.
// ---------------------------------------------------------------------------
test('Game Over fits entirely inside the game box with no scrolling, including every action', async ({ page }, info) => {
  // Test portrait AND landscape, including phones narrower than the standard
  // mobile project. Exercise all themes across the size cases.
  const cases = [
    { width: 320, height: 568, theme: 'classic' },
    { width: 360, height: 740, theme: 'arcade' },
    { width: 390, height: 844, theme: 'violet' },
    { width: 844, height: 390, theme: 'terminal' },
    { width: 1365, height: 960, theme: 'paper' },
  ];
  for (const size of cases) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await openGame(page, size.theme, {
      useCustomSpeed: true, speedCustom: 100,
      useCustomGrowth: true, growthCustom: 100,
    });
    await page.evaluate(() => { window.__snakeTest.start(); window.__snakeTest.quit(); });
    await expect(page.locator('#panel-over')).toHaveClass(/is-visible/);

    // Worst normal guest result: a six-digit score, both custom modifiers,
    // a new-best badge and sign-in/create-account buttons all present at once.
    await page.evaluate(() => {
      document.getElementById('final-score').textContent = '100000';
      document.getElementById('final-best').textContent = '99999 → 100000';
      document.getElementById('final-flag').hidden = false;
    });
    await expect(page.locator('#final-speed')).toContainText('100 ms');
    await expect(page.locator('#final-growth')).toContainText('100');

    const fits = () => page.evaluate(() => {
      const field = document.querySelector('.snake-field').getBoundingClientRect();
      const panel = document.querySelector('#panel-over').getBoundingClientRect();
      const inside = (r) => r.top >= field.top - 1 && r.bottom <= field.bottom + 1 && r.left >= field.left - 1 && r.right <= field.right + 1;
      const buttons = [...document.querySelectorAll('#panel-over button')].filter((b) => b.getClientRects().length);
      return inside(panel) && buttons.every((button) => inside(button.getBoundingClientRect()));
    });
    await expect.poll(fits, { message: `${size.width}x${size.height}: whole result and all guest actions fit` }).toBe(true);
    await expect(page.locator('#overlay')).toHaveCSS('overflow-y', 'hidden');
    await expect(page.locator('#btn-final-signin')).toBeVisible();
    await expect(page.locator('#btn-final-create')).toBeVisible();
    await expect(page.locator('#btn-again')).toBeVisible();
    await expect(page.locator('#btn-quit-over')).toBeVisible();

    // A longer save error must also fit without hiding the actions or a scrollbar.
    await page.evaluate(() => {
      document.getElementById('final-save-text').textContent = 'Your session is no longer valid, so this run is not saved yet. Sign in again and it will be added.';
    });
    await expect.poll(fits).toBe(true);
    await activate(page.locator('#btn-quit-over'), info.project.name);
    await expect(page.locator('#panel-start')).toHaveClass(/is-visible/);
  }
});

test('Controls stays directly beneath the expanding recent-run log', async ({ page }) => {
  const past = Array.from({ length: 12 }, (_, i) => ({
    score: 12 - i, key: '1-1', mode: 'Chill · ×1', at: Date.now() - i * 60000,
  }));
  await page.addInitScript((runs) => localStorage.setItem('snake.runs.v1', JSON.stringify(runs)), past);
  await openGame(page);
  await expect(page.locator('#recent-runs .runs__item')).toHaveCount(12);
  await expect(page.locator('.score-stack #scoreboard')).toHaveCount(1);
  await expect(page.locator('.score-stack #controls-card')).toHaveCount(1);

  const dimensions = () => page.evaluate(() => {
    const score = document.getElementById('scoreboard').getBoundingClientRect();
    const controls = document.getElementById('controls-card').getBoundingClientRect();
    return { scoreHeight: score.height, controlsOffset: controls.top - score.top, gap: controls.top - score.bottom, sameLeft: Math.abs(controls.left - score.left) < 1 };
  });
  const before = await dimensions();
  expect(before.gap).toBeGreaterThanOrEqual(12);
  expect(before.gap).toBeLessThanOrEqual(20);
  expect(before.sameLeft).toBe(true);
  await page.evaluate(() => { window.__snakeTest.start(); window.__snakeTest.quit(); });
  await expect(page.locator('#recent-runs .runs__item')).toHaveCount(13);
  const after = await dimensions();
  expect(after.scoreHeight).toBeGreaterThan(before.scoreHeight);
  expect(after.controlsOffset).toBeGreaterThan(before.controlsOffset);
  expect(Math.abs((after.controlsOffset - before.controlsOffset) - (after.scoreHeight - before.scoreHeight))).toBeLessThan(2);
});

test('the compact score panel is TOP RIGHT and desktop-Arcade-only', async ({ page }, info) => {
  // Classic on mobile: no floating score panel at all.
  await openGame(page, 'classic');
  await page.evaluate(() => window.__seedFood());
  await page.locator('#btn-start').click();
  await expect.poll(() => page.evaluate(() => window.__snakeTest.state().score)).toBeGreaterThanOrEqual(1);
  await expect(page.locator('#hud-float')).toBeHidden();
  await page.evaluate(() => window.__snakeTest.quit());

  // Arcade on desktop: top-right, live score, click-through, outside the box.
  if (info.project.name === 'mobile') return;
  await page.locator('[data-theme="arcade"][type="button"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'arcade');
  await page.evaluate(() => window.__seedFood());
  await page.waitForFunction(() => !document.querySelector('#btn-again').disabled, null, { timeout: 5000 });
  await page.locator('#btn-again').click();
  await expect.poll(() => page.evaluate(() => window.__snakeTest.state().score)).toBeGreaterThanOrEqual(1);
  const panel = page.locator('#hud-float');
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-live-score]')).toHaveText('1');
  await expect(panel.locator('[data-live-best]')).toHaveCount(0);
  const p = await panel.boundingBox();
  const vw = page.viewportSize().width;
  expect(p.x + p.width).toBeGreaterThanOrEqual(vw - 30);   // hugging the right edge
  expect(p.y).toBeLessThanOrEqual(16);                     // near the top
  await expect(panel).toHaveCSS('pointer-events', 'none');
  await page.evaluate(() => window.__snakeTest.quit());
  await expect(panel).toBeHidden();
});

test('a saved run keeps Game Over in view, with sign-in actions hidden and no automatic scroll', async ({ page }, info) => {
  const name = newUsername();
  await openLive(page);
  await signUp(page, page.locator('#btn-open-create'), name, info.project.name);
  const score = await playAndQuit(page, info.project.name);
  const before = await page.evaluate(() => window.scrollY);
  await expect(page.locator('#final-save-text')).toContainText(`Saved to the leaderboard as ${name}.`);
  await expect(page.locator('#final-save-actions')).toBeHidden();
  await expect(page.locator('#panel-over')).toHaveClass(/is-visible/);
  await page.waitForTimeout(200);
  expect(Math.abs((await page.evaluate(() => window.scrollY)) - before)).toBeLessThan(1);
  await expect(page.locator('#final-score')).toHaveText(String(score));
  expect(await countRuns(name)).toBe(1);
});

test('self-host instructions keep the exact heading and use native Podman Compose', async ({ page }) => {
  await openGame(page);
  await expect(page.locator('#manual .band__title')).toHaveText('One container. Two commands. Yours.');
  await expect(page.locator('#manual')).toContainText('podman compose up --build -d');
  await expect(page.locator('#manual')).toContainText('SELinux');
  await expect(page.locator('#manual')).not.toContainText('./snake');
  await expect(page.locator('#manual')).not.toContainText('CONTAINER_ENGINE');
});
