import { test, expect } from '@playwright/test';

// Real Rails room API, Action Cable and simulator: nothing is mocked. Runs in
// both Playwright projects (desktop, Pixel 7) against the live app.
async function create(page, name) {
  await page.goto('/multiplayer');
  await page.fill('#mp-name', name);
  await page.click('#mp-create');
  await expect(page.locator('#mp-room')).toBeVisible();
  return (await page.locator('#mp-room-code').textContent()).trim();
}

async function join(page, code, name) {
  await page.goto(`/multiplayer/${code}`);
  await page.fill('#mp-name', name);
  await page.click('#mp-join');
  await expect(page.locator('#mp-room')).toBeVisible();
}

const noHorizontalOverflow = async (page, label) => {
  const { vw, sw } = await page.evaluate(() => ({ vw: window.innerWidth, sw: document.documentElement.scrollWidth }));
  expect(sw, `${label}: page is wider than the viewport (${sw} > ${vw}) — a phone would zoom out`).toBeLessThanOrEqual(vw);
};

test('the host can select Responsive Brawl, start it, and the match is locked to it', async ({ page, browser, baseURL }) => {
  const code = await create(page, 'RespHost');
  const peerContext = await browser.newContext({ baseURL, viewport: { width: 1200, height: 900 } });
  try {
    const peer = await peerContext.newPage();
    await join(peer, code, 'RespGuest');
    await expect(page.locator('#mp-roster .mp-player')).toHaveCount(2);

    await page.selectOption('#mp-presentation-choice', 'responsive');
    await page.click('#mp-presentation-save');
    await expect(page.locator('#mp-presentation-status')).toContainText(/saved/i);
    // Synchronised to everyone, read-only for the guest.
    await expect(peer.locator('#mp-presentation-choice')).toHaveValue('responsive');
    await expect(peer.locator('#mp-presentation-choice')).toBeDisabled();

    // The regression: Start used to stay disabled whenever Responsive was selected.
    await expect(page.locator('#mp-start')).toBeVisible();
    await expect(page.locator('#mp-start')).toBeEnabled();
    await expect(page.locator('#mp-start-state')).toContainText(/Responsive/);
    await page.click('#mp-start');

    await expect(page.locator('#mp-game')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#mp-game-tick')).toHaveText(/Tick \d+/, { timeout: 20_000 });
    const summary = await (await page.request.get('/api/rooms/current')).json();
    expect(summary.room.match.presentation_strategy).toBe('responsive');
    expect(summary.room.state).toBe('in_match');
    // Locked for this match: the strategy cannot be changed while it runs.
    await expect(page.locator('#mp-presentation-choice')).toBeDisabled();
    const locked = await page.request.post(`/api/rooms/${code}/presentation_strategy`,
      { data: { presentation_strategy: 'classic' } });
    expect(locked.status()).toBe(409);

    // Both players steer; the own snake must keep responding and the match must
    // keep running (no client-side stall from the activated strategy).
    await page.keyboard.press('ArrowDown');
    await peer.keyboard.press('ArrowUp');
    await page.waitForTimeout(1200);
    await page.evaluate(() => { document.getElementById('mp-movement-diagnostics').open = true; });
    await expect(page.locator('#mp-movement-metrics')).toContainText(/Presentation strategy: responsive/, { timeout: 5_000 });
    const metrics = await page.locator('#mp-movement-metrics').textContent();
    expect(metrics).not.toContain('[object Object]');
    expect(metrics).toMatch(/Remote playback:/);
    // Prediction reconciles every tick now (movement frames are materialised), so
    // the confirmed tick cannot lag the playback buffer's newest tick by a dozen.
    const confirmed = Number(/Confirmed tick (\d+)/.exec(metrics)?.[1]);
    const newest = Number(/confirmed ticks \(\d+–(\d+)\)/.exec(metrics)?.[1]);
    if (Number.isFinite(confirmed) && Number.isFinite(newest)) {
      expect(newest - confirmed, `predictor confirmed tick ${confirmed} lags newest ${newest}`).toBeLessThanOrEqual(3);
    }
  } finally {
    await peerContext.close();
  }
});

test('the multiplayer page never overflows a phone-width viewport', async ({ page, browser, baseURL }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('/multiplayer');
  await noHorizontalOverflow(page, 'entry');
  const code = await create(page, 'NarrowHost');
  await noHorizontalOverflow(page, 'lobby');
  await page.selectOption('#mp-presentation-choice', 'responsive');
  await page.click('#mp-presentation-save');
  await expect(page.locator('#mp-presentation-status')).toContainText(/saved/i);
  await noHorizontalOverflow(page, 'lobby with Responsive selected');
  const peerContext = await browser.newContext({ baseURL, viewport: { width: 1200, height: 900 } });
  try {
    const peer = await peerContext.newPage();
    await join(peer, code, 'NarrowGuest');
    await expect(page.locator('#mp-roster .mp-player')).toHaveCount(2);
    await page.click('#mp-start');
    await expect(page.locator('#mp-game')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#mp-game-tick')).toHaveText(/Tick \d+/, { timeout: 20_000 });
    await noHorizontalOverflow(page, 'in a Responsive match');
    await page.evaluate(() => { document.getElementById('mp-movement-diagnostics').open = true; });
    await page.waitForTimeout(1200);
    await noHorizontalOverflow(page, 'in a match with diagnostics open');
  } finally {
    await peerContext.close();
  }
});
