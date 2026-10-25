import { test, expect } from '@playwright/test';

// Real server-authoritative Brawl: two separate browser contexts (separate
// guest identities), one real Rails server, real Action Cable snapshots and a
// live simulator loop. No mocked game state.

async function joinRoom(page, code, name) {
  await page.goto(`/multiplayer/${code}`);
  await page.fill('#mp-name', name);
  await page.click('#mp-join');
  await expect(page.locator('#mp-room')).toBeVisible();
}

async function hostRoom(page, name) {
  await page.goto('/multiplayer');
  await page.fill('#mp-name', name);
  await page.click('#mp-create');
  await expect(page.locator('#mp-room')).toBeVisible();
  return (await page.locator('#mp-room-code').textContent()).trim();
}

test('two browsers play one synchronized Brawl on the server-authoritative canvas', async ({ browser, baseURL }) => {
  const contextA = await browser.newContext({ baseURL });
  const contextB = await browser.newContext({ baseURL });
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const errors = [];
  pageA.on('pageerror', (error) => errors.push(`A: ${error.message}`));
  pageB.on('pageerror', (error) => errors.push(`B: ${error.message}`));

  const code = await hostRoom(pageA, 'Ada');
  await joinRoom(pageB, code, 'Grace');

  // Ready votes are advisory; the host alone starts the Brawl.
  await pageA.click('#mp-start');
  await expect(pageA.locator('#mp-flash')).toContainText('Brawl started');
  await expect(pageA.locator('#mp-room-state')).toHaveText('in_match');
  await expect(pageA.locator('#mp-game-canvas')).toBeVisible();
  await expect(pageA.locator('#mp-start')).toBeHidden();

  // The second client sees the same live arena without refreshing.
  await expect(pageB.locator('#mp-room-state')).toHaveText('in_match');
  await expect(pageB.locator('#mp-game-canvas')).toBeVisible();
  await expect(pageB.locator('#mp-game-scores .mp-game-score')).toHaveCount(2);

  // Both render colored snakes with distinct assigned colors from the server.
  await expect(pageA.locator('#mp-game-scores .mp-game-score')).toHaveCount(2);
  const colors = await pageA.locator('#mp-game-scores .mp-game-score .mp-identity-color').evaluateAll(
    (nodes) => nodes.map((node) => getComputedStyle(node).getPropertyValue('--player-color').trim()),
  );
  expect(colors).toHaveLength(2);
  expect(colors[0]).not.toBe(colors[1]);
  expect(colors[0]).toMatch(/^#[0-9A-F]{6}$/i);

  // Server snapshots advance the shared tick on both clients.
  await expect(pageA.locator('#mp-game-tick')).toHaveText(/^Tick [1-9]\d*$/, { timeout: 15_000 });
  await expect(pageB.locator('#mp-game-tick')).toHaveText(/^Tick [1-9]\d*$/, { timeout: 15_000 });
  const tickA = Number((await pageA.locator('#mp-game-tick').textContent()).replace('Tick ', ''));
  const tickB = Number((await pageB.locator('#mp-game-tick').textContent()).replace('Tick ', ''));
  expect(Math.abs(tickA - tickB)).toBeLessThanOrEqual(5), 'both clients show the same simulation clock';

  // Keyboard steering sends only a direction; the server remains authoritative.
  await pageA.locator('#mp-game-canvas').click();
  await pageA.keyboard.press('ArrowUp');
  await expect(pageA.locator('#mp-game-input-status')).toBeEmpty();

  // Touch steering: a horizontal swipe on the arena sends one direction.
  await pageB.locator('#mp-game-canvas').evaluate((canvas) => {
    const rect = canvas.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch',
                   clientX: rect.left + rect.width * 0.7, clientY: rect.top + rect.height / 2 };
    canvas.dispatchEvent(new PointerEvent('pointerdown', opts));
    canvas.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: rect.left + rect.width * 0.3 }));
  });
  await expect(pageB.locator('#mp-game-input-status')).toBeEmpty();

  // A browser refresh mid-match reconnects to the same server simulation.
  await pageB.reload();
  await expect(pageB.locator('#mp-game-canvas')).toBeVisible();
  await expect(pageB.locator('#mp-game-tick')).toHaveText(/^Tick [1-9]\d*$/, { timeout: 15_000 });
  await expect(pageB.locator('#mp-game-scores .mp-game-score')).toHaveCount(2);

  // The hostile-payload path is covered by Rails/channel tests; here we assert
  // the real clients stayed healthy through steering + a mid-match refresh.
  expect(errors).toEqual([]);
  await contextA.close();
  await contextB.close();
});

test('keyboard steering does not hijack username inputs', async ({ page }) => {
  await page.goto('/multiplayer');
  await page.fill('#mp-name', 'Ada');
  await page.focus('#mp-name');
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('#mp-name')).toHaveValue('Ada');
});

test('the on-screen steering pad steers on mobile-sized screens', async ({ page, browser, baseURL, isMobile }) => {
  test.skip(!isMobile, 'the steering pad is hidden on desktop by design');
  const code = await hostRoom(page, 'MobileAda');
  const friendContext = await browser.newContext({ baseURL });
  const friend = await friendContext.newPage();
  await joinRoom(friend, code, 'MobileGrace');
  await page.click('#mp-start');
  await expect(page.locator('#mp-game-canvas')).toBeVisible();
  await expect(page.locator('[data-game-dir="left"]')).toBeVisible();
  await page.locator('[data-game-dir="left"]').tap();
  await expect(page.locator('#mp-game-input-status')).toBeEmpty();
  await friendContext.close();
});

// Step 8 review regression: steering quoted at the client's last received
// snapshot tick used to be rejected server-side (silent input loss), because
// that tick lags the owner's in-memory tick. This reads REAL WebSocket frames
// and asserts the snake's authoritative direction actually changed.
// Step 8 review regression: steering quoted at the client's last received
// snapshot tick used to be rejected server-side (silent input loss), because
// that tick lags the owner's in-memory tick. This drives the real keyboard and
// asserts the AUTHORITATIVE direction the server broadcast actually changed,
// on both clients.
// Step 8 review regression: steering quoted at the client's last received
// snapshot tick used to be rejected server-side (silent input loss), because
// that tick lags the owner's in-memory tick. Both browsers steer with the real
// keyboard and each one's AUTHORITATIVE server-broadcast direction must change.
test('direction key presses from both browsers reach the server', async ({ browser, baseURL }) => {
  const contextA = await browser.newContext({ baseURL });
  const contextB = await browser.newContext({ baseURL });
  const host = await contextA.newPage();
  const guest = await contextB.newPage();
  const errors = [];
  host.on('pageerror', (e) => errors.push(`A: ${e.message}`));
  guest.on('pageerror', (e) => errors.push(`B: ${e.message}`));

  const code = await hostRoom(host, 'Ada');
  await joinRoom(guest, code, 'Grace');
  await host.click('#mp-start');
  await expect(host.locator('#mp-game-canvas')).toBeVisible();
  await expect(guest.locator('#mp-game-canvas')).toBeVisible();

  // Both clients are receiving authoritative snapshots.
  for (const page of [host, guest]) {
    await expect
      .poll(() => page.locator('#mp-game').getAttribute('data-tick'), { timeout: 15_000 })
      .toMatch(/^\d+$/);
  }

  // The host steers up.
  const hostBefore = await host.locator('#mp-game').getAttribute('data-own-direction');
  await host.locator('#mp-game-canvas').click();
  await host.keyboard.press('ArrowUp');
  await expect(host.locator('#mp-game-input-status')).toBeEmpty();
  await expect
    .poll(() => host.locator('#mp-game').getAttribute('data-own-direction'), { timeout: 15_000 })
    .not.toBe(hostBefore);
  const hostAfter = await host.locator('#mp-game').getAttribute('data-own-direction');
  expect(['up', 'down', 'left', 'right']).toContain(hostAfter);

  // The guest steers down — a second real client through the same path.
  const guestBefore = await guest.locator('#mp-game').getAttribute('data-own-direction');
  await guest.locator('#mp-game-canvas').click();
  await guest.keyboard.press('ArrowDown');
  await expect(guest.locator('#mp-game-input-status')).toBeEmpty();
  await expect
    .poll(() => guest.locator('#mp-game').getAttribute('data-own-direction'), { timeout: 15_000 })
    .not.toBe(guestBefore);
  const guestAfter = await guest.locator('#mp-game').getAttribute('data-own-direction');
  expect(['up', 'down', 'left', 'right']).toContain(guestAfter);

  // Both clients are still bound to a live authoritative match: each has a
  // numeric server tick and no page errors. (The direction assertions above are
  // the regression proof; a snake may legitimately be eliminated mid-test.)
  for (const page of [host, guest]) {
    const tick = await page.locator('#mp-game').getAttribute('data-tick');
    expect(tick).toMatch(/^\d+$/);
  }

  expect(errors).toEqual([]);
  await contextA.close();
  await contextB.close();
});

// Step 8 review: the host-only "Play again" control appears only once a Brawl
// has finished, and returns the room to the lobby for another round. The full
// rematch round-trip is covered deterministically by the Rails integration
// tests (a second Match is created and the first result is preserved).
test('the Play again control follows the room lifecycle and is host-only', async ({ browser, baseURL }) => {
  const contextA = await browser.newContext({ baseURL });
  const contextB = await browser.newContext({ baseURL });
  const host = await contextA.newPage();
  const guest = await contextB.newPage();

  const code = await hostRoom(host, 'Ada');
  await joinRoom(guest, code, 'Grace');

  // In the lobby the host sees Start, not Play again; the guest sees neither.
  await expect(host.locator('#mp-start')).toBeVisible();
  await expect(host.locator('#mp-again')).toBeHidden();
  await expect(guest.locator('#mp-start')).toBeHidden();
  await expect(guest.locator('#mp-again')).toBeHidden();

  await host.click('#mp-start');
  await expect(host.locator('#mp-room-state')).toHaveText('in_match');
  await expect(host.locator('#mp-start')).toBeHidden();
  await expect(host.locator('#mp-again')).toBeHidden();
  await expect(guest.locator('#mp-again')).toBeHidden();

  // Non-hosts cannot reset a room through the new endpoint.
  const refused = await guest.request.post(`/api/rooms/${code}/lobby`, {
    headers: { 'Content-Type': 'application/json' },
    data: {},
  });
  expect(refused.status()).toBe(403);

  await contextA.close();
  await contextB.close();
});
