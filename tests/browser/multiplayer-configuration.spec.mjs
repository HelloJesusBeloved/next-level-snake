import { test, expect } from '@playwright/test';

// Real Rails room API + Action Cable. No configuration endpoints are mocked.
const themes = ['classic', 'arcade', 'vintage', 'terminal', 'paper', 'violet', 'sunsetfire'];
const desktop = { viewport: { width: 1440, height: 960 }, screen: { width: 1920, height: 1080 }, isMobile: false, hasTouch: false };
const mobile = { viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

async function create(page, name = 'ColorHost') {
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

async function current(page) {
  const response = await page.request.get('/api/rooms/current');
  expect(response.ok()).toBe(true);
  return response.json();
}

test('each player gets a unique persisted solid color; claimed choices are disabled and live changes propagate', async ({ page, browser, baseURL }) => {
  const code = await create(page);
  const peerContext = await browser.newContext({ baseURL });
  try {
    const peer = await peerContext.newPage();
    await join(peer, code, 'ColorGuest');
    await expect(page.locator('#mp-roster .mp-player')).toHaveCount(2);
    const a = await current(page);
    const b = await current(peer);
    expect(a.member.color.hex).toMatch(/^#[0-9A-F]{6}$/);
    expect(a.member.color.slot).not.toBe(b.member.color.slot);
    await expect(page.locator(`#mp-color-options button[data-slot="${b.member.color.slot}"]`)).toBeDisabled();
    const free = a.room.colors.options.filter((option) => !option.taken_by && !option.locked);
    expect(free.length).toBeGreaterThanOrEqual(6);
    const chosen = free[0];
    await page.locator(`#mp-color-options button[data-slot="${chosen.slot}"]`).click();
    await expect(page.locator('#mp-color-status')).toContainText('reserved');
    await expect(page.locator('#mp-my-color')).toContainText(chosen.hex);
    await expect(peer.locator(`#mp-roster [data-member-id="${a.member.id}"] .mp-identity-color`))
      .toHaveAttribute('style', `--player-color:${chosen.hex}`);
    await expect(peer.locator(`#mp-color-options button[data-slot="${chosen.slot}"]`)).toBeDisabled();
    await page.reload();
    await expect(page.locator('#mp-my-color')).toContainText(chosen.hex);
    expect((await current(page)).member.color.slot).toBe(chosen.slot);
  } finally { await peerContext.close(); }
});

test('solid swatches have a dual contrast edge, accessible names, and readable usernames in every theme', async ({ page }) => {
  await create(page, 'VisibleName');
  for (const theme of themes) {
    await page.locator(`#mp-themes button[data-theme="${theme}"]`).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const dot = page.locator('#mp-roster .mp-identity-color').first();
    await expect(dot).toBeVisible();
    await expect(dot).toHaveCSS('border-top-color', 'rgb(17, 17, 17)');
    const shadow = await dot.evaluate((node) => getComputedStyle(node).boxShadow);
    expect(shadow).toContain('255, 255, 255');
    await expect(page.locator('#mp-roster .mp-player__name')).toHaveText('VisibleName');
    await expect(page.locator('#mp-color-options button').first()).toHaveAttribute('aria-label', /hue.*#[0-9A-F]{6}/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});

test('desktop-only host can save presets/custom sizes, but one mobile participant forces 24 × 18 live', async ({ browser, baseURL }) => {
  const hostContext = await browser.newContext({ baseURL, ...desktop });
  const peerContext = await browser.newContext({ baseURL, ...desktop });
  const phoneContext = await browser.newContext({ baseURL, ...mobile });
  try {
    const host = await hostContext.newPage();
    const peer = await peerContext.newPage();
    const phone = await phoneContext.newPage();
    const code = await create(host, 'DesktopHost');
    await expect(host.locator('#mp-board-save')).toBeEnabled();
    await join(peer, code, 'DesktopGuest');
    await expect(host.locator('#mp-board-save')).toBeEnabled();
    await expect(peer.locator('#mp-board-save')).toBeHidden();
    await expect(peer.locator('#mp-board-preset')).toBeDisabled();
    await host.selectOption('#mp-board-preset', 'large');
    await host.click('#mp-board-save');
    await expect(host.locator('#mp-board-status')).toContainText('saved');
    await expect(peer.locator('#mp-board-current')).toHaveText('48 × 36');
    await host.fill('#mp-board-columns', '52');
    await host.fill('#mp-board-rows', '39');
    await host.click('#mp-board-save');
    await expect(host.locator('#mp-board-current')).toHaveText('52 × 39');
    await join(phone, code, 'TouchPlayer');
    await expect(host.locator('#mp-board-current')).toHaveText('24 × 18');
    await expect(host.locator('#mp-board-save')).toBeDisabled();
    await expect(host.locator('#mp-board-reason')).toContainText('Mobile or unverified');
    expect((await current(phone)).member.device).toBe('mobile');
    await phone.click('#mp-leave');
    await expect(host.locator('#mp-board-save')).toBeEnabled();
    await expect(host.locator('#mp-board-current')).toHaveText('52 × 39');
  } finally {
    await hostContext.close(); await peerContext.close(); await phoneContext.close();
  }
});

test('viewport resize reports are conservative and never need a manual refresh', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, ...desktop });
  try {
    const page = await context.newPage();
    await create(page, 'ResizingHost');
    await expect(page.locator('#mp-board-save')).toBeEnabled();
    await page.selectOption('#mp-board-preset', 'roomy');
    await page.click('#mp-board-save');
    await expect(page.locator('#mp-board-current')).toHaveText('40 × 30');
    await page.setViewportSize({ width: 800, height: 760 });
    await expect(page.locator('#mp-board-current')).toHaveText('24 × 18');
    await expect(page.locator('#mp-board-save')).toBeDisabled();
    await page.setViewportSize({ width: 1440, height: 960 });
    await expect(page.locator('#mp-board-save')).toBeEnabled();
    await expect(page.locator('#mp-board-current')).toHaveText('40 × 30');
  } finally { await context.close(); }
});


test('a mobile-sized tab cannot be overwritten by desktop reports from another tab of the same player', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, ...desktop });
  try {
    const host = await context.newPage();
    const code = await create(host, 'TwoTabs');
    await expect(host.locator('#mp-board-save')).toBeEnabled();
    const narrow = await context.newPage();
    await narrow.setViewportSize({ width: 600, height: 800 });
    await narrow.goto(`/multiplayer/${code}`);
    await expect(narrow.locator('#mp-room')).toBeVisible();
    await expect(host.locator('#mp-board-save')).toBeDisabled();
    // The first tab reports desktop again. The mobile tab must still win.
    await host.evaluate(() => window.dispatchEvent(new Event('resize')));
    await expect(host.locator('#mp-board-reason')).toContainText('Mobile or unverified');
    await expect(host.locator('#mp-board-current')).toHaveText('24 × 18');
    await expect(host.locator('#mp-roster .mp-player')).toHaveCount(1);
    expect((await current(host)).member.device).toBe('mobile');
  } finally { await context.close(); }
});
