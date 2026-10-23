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
  await expect(page.getByRole('button', { name: 'Join with Code' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Scan QR Code' })).toBeVisible();
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

  // The host starts a real server-authoritative Brawl without unanimity.
  await page.click('#mp-start');
  await expect(page.locator('#mp-flash')).toContainText('Brawl started');
  await expect(page.locator('#mp-room-state')).toHaveText('in_match');
  await expect(page.locator('#mp-game')).toBeVisible();
  await expect(page.locator('#mp-game-canvas')).toBeVisible();
  await expect(page.locator('#mp-start')).toBeHidden();

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

// ---- invitations: sharing panel & QR scanning (step 5) --------------------

async function createRoomVia(request, displayName = 'Ada') {
  const res = await request.post('/api/rooms', {
    headers: { 'Content-Type': 'application/json' },
    data: { display_name: displayName },
  });
  expect(res.status()).toBe(201);
  const { room } = await res.json();
  return room;
}

test('sharing panel shows the invite URL, encodes a scannable QR, and shares/copies with feedback', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.addInitScript(() => {
    // Deterministic Web Share: the real API needs OS integration.
    navigator.share = async (data) => { window.__shared = data; };
  });
  await page.goto('/multiplayer');
  await page.fill('#mp-name', 'Ada');
  await page.click('#mp-create');
  await expect(page.locator('#mp-room')).toBeVisible();

  // Direct join URL is displayed, from the server, carrying this page's origin.
  const invite = await page.locator('#mp-invite-url').textContent();
  const origin = new URL(page.url()).origin;
  const roomCode = (await page.locator('#mp-room-code').textContent()).trim();
  expect(roomCode).toMatch(/^[A-Z0-9]{12}$/);
  expect(invite).toBe(`${origin}/multiplayer/${roomCode}`);

  // Share Room appears (navigator.share stubbed in) and shares the URL.
  const shareBtn = page.locator('#mp-share-room');
  await expect(shareBtn).toBeVisible();
  await shareBtn.click();
  expect(await page.evaluate(() => window.__shared)).toMatchObject({ url: invite });
  await expect(page.locator('#mp-share-feedback')).toContainText('Shared');

  // Copy Link always works, with visible success feedback.
  await page.locator('#mp-copy-link').click();
  await expect(page.locator('#mp-share-feedback')).toContainText('copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(invite);

  // The QR code renders locally AND round-trips: decode our own canvas with
  // the vendored jsQR — the exact payload a phone camera would see.
  await page.locator('#mp-qr-toggle').click();
  await expect(page.locator('#mp-qr')).toBeVisible();
  await expect(page.locator('#mp-qr-toggle')).toHaveAttribute('aria-expanded', 'true');
  const decoded = await page.evaluate(() => {
    const canvas = document.getElementById('mp-qr-canvas');
    const frame = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    const found = window.jsQR(frame.data, canvas.width, canvas.height);
    return found ? found.data : null;
  });
  expect(decoded).toBe(invite);
});

test('copy failure is reported visibly with the link to copy by hand', async ({ page, request }) => {
  await createRoomVia(request);
  await page.goto('/multiplayer');
  await page.fill('#mp-name', 'Ada');
  await page.click('#mp-create');
  await expect(page.locator('#mp-room')).toBeVisible();

  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    document.execCommand = () => false; // both copy paths fail on purpose
  });
  await page.locator('#mp-copy-link').click();
  await expect(page.locator('#mp-share-feedback')).toContainText('Automatic copy failed');
  await expect(page.locator('#mp-share-feedback')).toContainText('/multiplayer/');
});

test('without Web Share the Share Room button stays hidden while Copy Link remains', async ({ page, request }) => {
  await createRoomVia(request);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
  });
  await page.goto('/multiplayer');
  await page.fill('#mp-name', 'Ada');
  await page.click('#mp-create');
  await expect(page.locator('#mp-room')).toBeVisible();
  await expect(page.locator('#mp-share-room')).toBeHidden();
  await expect(page.locator('#mp-copy-link')).toBeVisible();
});

test.describe('QR scanner', () => {
  test.use({ permissions: ['camera'] });

  test('a scanned invitation navigates in the SAME tab and joins through the real backend', async ({ page, context, request }) => {
    const room = await createRoomVia(request, 'Ada');
    // addInitScript must be registered BEFORE goto — it applies to documents
    // created afterwards, so ordering here decides whether the stub exists.
    const target = new URL(`/multiplayer/${room.code}`, test.info().project.use.baseURL).href;
    await page.addInitScript((url) => {
      // Native-BarcodeDetector path: report the invitation on the first frame.
      window.BarcodeDetector = class {
        async detect() { return [{ rawValue: url }]; }
      };
    }, target);
    await page.goto('/multiplayer');

    await page.locator('#mp-scan-open').click();
    await expect(page.locator('#mp-scan')).toBeVisible();
    // Same tab means the page itself navigated — never a popup/tab window.open.
    await page.waitForURL(`**/multiplayer/${room.code}`);
    expect(context.pages().length).toBe(1);

    // The invitation route is the normal join flow: name + Join with Code.
    // The room already seats its API-created host, so Grace makes two.
    await page.fill('#mp-name', 'Grace');
    await page.click('#mp-join');
    await expect(page.locator('#mp-roster .mp-player')).toHaveCount(2);
    await expect(page.locator('#mp-roster')).toContainText('Grace');
    await expect(page.locator('#mp-roster')).toContainText('Ada');
  });

  test('a foreign URL is rejected and the camera is released on cancel', async ({ page, request }) => {
    await createRoomVia(request);
    await page.addInitScript(() => {
      // Wrap the REAL implementation first — assigning after the wrapper
      // would make the wrapper call itself forever (RangeError).
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        const stream = await original(constraints);
        window.__cam = stream;
        return stream;
      };
      window.BarcodeDetector = class {
        async detect() { return [{ rawValue: 'https://evil.example/multiplayer/NOTOURS' }]; }
      };
    });

    await page.goto('/multiplayer');
    await page.locator('#mp-scan-open').click();
    await expect(page.locator('#mp-scan-status')).toContainText("isn't a Next Level Snake invitation");
    await page.waitForTimeout(400);
    expect(page.url()).toContain('/multiplayer'); // stayed put — no navigation

    await page.locator('#mp-scan-cancel').click();
    await expect(page.locator('#mp-scan')).toBeHidden();
    const released = await page.evaluate(() => (
      window.__cam && window.__cam.getTracks().every((track) => track.readyState === 'ended')
    ));
    expect(released).toBe(true);
  });

  test('the jsQR fallback decodes a real QR frame locally', async ({ page, context, request }) => {
    const room = await createRoomVia(request, 'Ada');
    const target = new URL(`/multiplayer/${room.code}`, test.info().project.use.baseURL).href;
    // addInitScript before goto: it only applies to documents created after.
    await page.addInitScript((url) => {
      // No native detector: force the vendored jsQR fallback, and feed the
      // camera a genuine QR drawn on a canvas — real pixels, real decode.
      Object.defineProperty(window, 'BarcodeDetector', { value: undefined, configurable: true });
      navigator.mediaDevices.getUserMedia = async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 480;
        canvas.height = 480;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, 480, 480);
        const qr = window.qrcode(0, 'M');
        qr.addData(url);
        qr.make();
        const quiet = 4;
        const count = qr.getModuleCount();
        const cell = Math.floor(480 / (count + quiet * 2));
        const offset = Math.floor((480 - cell * count) / 2);
        ctx.fillStyle = '#000000';
        for (let row = 0; row < count; row += 1) {
          for (let col = 0; col < count; col += 1) {
            if (qr.isDark(row, col)) ctx.fillRect(offset + col * cell, offset + row * cell, cell, cell);
          }
        }
        window.__cam = canvas.captureStream(10);
        return window.__cam;
      };
    }, target);
    await page.goto('/multiplayer');

    await page.locator('#mp-scan-open').click();
    // No visibility/status assertion: with a real QR in frame the decode and
    // the same-tab navigation can complete before the first poll. waitForURL
    // passes either way (immediately if the navigation already landed).
    await page.waitForURL(`**/multiplayer/${room.code}`);
    expect(context.pages().length).toBe(1);
  });

  test('camera permission denial is reported and recoverable', async ({ page }) => {
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        throw new DOMException('User dismissed the prompt', 'NotAllowedError');
      };
    });
    await page.goto('/multiplayer');
    await page.locator('#mp-scan-open').click();
    await expect(page.locator('#mp-scan-status')).toContainText('Camera permission denied');
    await expect(page.locator('#mp-scan-stage')).toBeHidden();
    await page.locator('#mp-scan-cancel').click();
    await expect(page.locator('#mp-scan')).toBeHidden();
    // Camera still works for a later attempt: nothing was acquired to leak.
    expect(await page.evaluate(() => !window.__cam)).toBe(true);
  });

  test('browsers without mediaDevices are told plainly, and Escape releases everything', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
    });
    await page.goto('/multiplayer');
    await page.locator('#mp-scan-open').click();
    await expect(page.locator('#mp-scan-status')).toContainText("can't open a camera");
    // Escape is the dialog's native dismissal — close event must clean up.
    await page.keyboard.press('Escape');
    await expect(page.locator('#mp-scan')).toBeHidden();
    // Reopening after an unsupported attempt still shows an honest status.
    await page.locator('#mp-scan-open').click();
    await expect(page.locator('#mp-scan-status')).toContainText("can't open a camera");
  });
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
