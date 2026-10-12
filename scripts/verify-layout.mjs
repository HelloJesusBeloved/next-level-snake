import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3000';
const browser = await chromium.launch({ headless: true });
const errors = [];

try {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    localStorage.setItem('snake.settings.v1', JSON.stringify({ theme: 'violet' }));
  });
  await context.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/me') return route.fulfill({ json: { user: { username: 'tester' } } });
    if (path === '/api/scores') return route.fulfill({ json: { best: {}, xp: { level: 2, into: 40, span: 100, toNext: 60, pct: 0.4, xp: 140 } } });
    if (path === '/api/profile') {
      return route.fulfill({
        json: {
          user: {
            username: 'tester',
            is_you: true,
            favorite_theme: 'violet',
            created_at: new Date().toISOString(),
            rank: 1,
            games: [
              {
                id: 7,
                score: 12,
                speed_level: 3,
                speed_custom: null,
                growth: 1,
                growth_custom: null,
                created_at: new Date().toISOString(),
                end_state: {
                  cols: 24,
                  rows: 18,
                  snake: [100, 101, 102, 103, 104],
                  food: 200,
                  crash: 105,
                  cause: 'crash',
                },
              },
            ],
          },
        },
      });
    }
    return route.fulfill({ json: { board: 'standard', total: 0, rows: [] } });
  });

  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));

  const rects = async () => page.evaluate(() => {
    const r = (id) => {
      const el = document.getElementById(id);
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height, bottom: b.bottom, right: b.right };
    };
    const stage = document.querySelector('.stage').getBoundingClientRect();
    const openSource = Array.from(document.querySelectorAll('a')).find((a) => a.textContent.includes('Open Source'));
    return {
      stage: { x: stage.x, y: stage.y, bottom: stage.bottom },
      score: r('scoreboard'),
      mods: r('settings-card'),
      controls: r('controls-card'),
      openSourceHref: openSource ? openSource.getAttribute('href') : null,
      openSourceVisible: !!(openSource && openSource.getBoundingClientRect().width > 0),
      gaps: null,
    };
  });

  const near = (a, b, msg, tol = 3) => assert.ok(Math.abs(a - b) <= tol, `${msg} (${a} vs ${b})`);

  // ---- HOME: Open Source button + evenly spaced vertical rail ----
  for (const width of [1920, 1440, 1280, 1200, 1101]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(baseURL, { waitUntil: 'networkidle' });
    await page.locator('#settings-theme [data-theme="violet"][aria-pressed="true"]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    const p = await rects();

    assert.equal(p.openSourceHref, 'https://github.com/HelloJesusBeloved/next-level-snake');
    assert.ok(p.openSourceVisible, `${width}: Open Source button must be visible`);

    // Vertical sidebar: same x, Controls last, even gaps
    near(p.score.x, p.mods.x, `${width}: Scoreboard and Modifiers share a column`);
    near(p.score.x, p.controls.x, `${width}: Controls shares the sidebar column`);
    assert.ok(p.mods.y > p.score.bottom - 1, `${width}: Modifiers under Scoreboard`);
    assert.ok(p.controls.y > p.mods.bottom - 1, `${width}: Controls under Modifiers (bottom panel)`);
    const g1 = p.mods.y - p.score.bottom;
    const g2 = p.controls.y - p.mods.bottom;
    near(g1, g2, `${width}: even gaps between the three panels`, 4);
    near(g1, 18, `${width}: gap should be the rail gap (18px)`, 4);
    assert.ok(p.score.y < p.stage.bottom, `${width}: rail stays beside the game`);
    assert.ok(p.score.x < 360, `${width}: rail is on the side`);
    console.log(`PASS home sidebar @ ${width}px (gap ${g1.toFixed(1)}/${g2.toFixed(1)})`);
  }

  // Narrow two-column: Controls under Scoreboard, not full-width under Modifiers
  for (const width of [1100, 900, 721]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(baseURL, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    const p = await rects();
    near(p.controls.x, p.score.x, `${width}: Controls under Scoreboard`);
    near(p.controls.w, p.score.w, `${width}: Controls not stretched`);
    assert.ok(p.mods.x > p.score.right - 2, `${width}: Modifiers is the right column`);
    assert.ok(p.controls.y > p.score.bottom - 1, `${width}: Controls below Scoreboard`);
    console.log(`PASS home two-col @ ${width}px`);
  }

  // Single column order
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(baseURL, { waitUntil: 'networkidle' });
  const phone = await rects();
  assert.ok(phone.mods.y > phone.score.bottom - 1);
  assert.ok(phone.controls.y > phone.mods.bottom - 1);
  console.log('PASS home phone stack order');

  // ---- PROFILE: no "View profile in", skin side panel, enlargeable boards ----
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(`${baseURL}/profile`, { waitUntil: 'networkidle' });
  await page.locator('#pf-skin-theme').waitFor();
  await page.locator('#pf-log').waitFor();
  await page.evaluate(() => document.fonts.ready);

  const bodyText = await page.locator('body').innerText();
  assert.ok(!bodyText.includes('View profile in'), 'Profile must not show "View profile in"');
  assert.ok(!bodyText.toLowerCase().includes('arcade wraps the screen'), 'Skin panel must not include the arcade description text');

  const pf = await page.evaluate(() => {
    const skin = document.getElementById('pf-skin-card').getBoundingClientRect();
    const root = document.getElementById('profile-root').getBoundingClientRect();
    const openSource = Array.from(document.querySelectorAll('a')).find((a) => a.textContent.includes('Open Source'));
    const enlarge = document.querySelector('[data-enlarge]');
    const hint = document.querySelector('#pf-skin-card .setting__hint');
    const mods = document.querySelector('#pf-skin-card #settings-speed, #pf-skin-card #settings-growth');
    return {
      skin: { x: skin.x, y: skin.y, w: skin.width, right: skin.right },
      root: { x: root.x, y: root.y },
      openSource: openSource ? openSource.getAttribute('href') : null,
      hasEnlarge: !!enlarge,
      enlargeId: enlarge ? enlarge.getAttribute('data-enlarge') : null,
      hasHint: !!hint,
      hasMods: !!mods,
      pressed: document.querySelector('#pf-skin-theme [aria-pressed="true"]')?.getAttribute('data-theme') || null,
    };
  });
  assert.equal(pf.openSource, 'https://github.com/HelloJesusBeloved/next-level-snake');
  assert.ok(pf.skin.x < 360, 'Cabinet skin panel is a left side panel');
  assert.ok(pf.root.x > pf.skin.right - 2, 'Profile content sits beside the skin panel');
  assert.equal(pf.hasHint, false, 'Skin panel has no arcade description');
  assert.equal(pf.hasMods, false, 'Skin panel has no game modifiers');
  assert.ok(pf.hasEnlarge, 'Game log ending board is clickable');
  console.log('PASS profile shell + skin side panel + no view-profile-in');

  // Click enlarge and confirm lightbox opens with a board
  await page.locator('[data-enlarge]').first().click();
  await page.waitForFunction(() => {
    const dlg = document.getElementById('board-lightbox');
    return dlg && (dlg.open || dlg.hasAttribute('open'));
  });
  const enlarged = await page.evaluate(() => {
    const frame = document.getElementById('board-lightbox-frame');
    return {
      hasSvg: !!(frame && frame.querySelector('svg.board')),
      cap: document.getElementById('board-lightbox-cap')?.textContent || '',
    };
  });
  assert.ok(enlarged.hasSvg, 'Enlarged board shows the ending position SVG');
  assert.ok(enlarged.cap.includes('12 points'), 'Lightbox caption includes the score');
  await page.locator('#board-lightbox-close').click();
  await page.waitForFunction(() => {
    const dlg = document.getElementById('board-lightbox');
    return dlg && !dlg.open && !dlg.hasAttribute('open');
  });
  console.log('PASS game log board enlarge + close');

  // Skin panel changes global theme
  await page.locator('#pf-skin-theme [data-theme="classic"]').click();
  await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'classic');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('snake.settings.v1') || '{}').theme);
  assert.equal(stored, 'classic');
  console.log('PASS profile skin panel controls global theme');

  // ---- GATE: a signed-out visitor sees no cabinet skin panel ----
  const guest = await browser.newContext();
  await guest.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/me') return route.fulfill({ json: { user: null } });
    if (path === '/api/profile') return route.fulfill({ status: 401, json: { error: 'Sign in to see your profile' } });
    return route.fulfill({ json: { best: {}, xp: null } });
  });
  const gp = await guest.newPage();
  await gp.setViewportSize({ width: 1280, height: 1000 });
  await gp.goto(`${baseURL}/profile`, { waitUntil: 'networkidle' });
  await gp.locator('#gate-signin').waitFor();
  const gate = await gp.evaluate(() => {
    const side = document.querySelector('.pf-side');
    const cs = getComputedStyle(side);
    const rect = side.getBoundingClientRect();
    return {
      gateShown: document.body.innerText.includes('Sign in to see your profile'),
      skinDisplay: cs.display,
      skinWidth: rect.width,
      skinText: side.innerText,
      layoutCols: getComputedStyle(document.querySelector('.pf-layout')).gridTemplateColumns,
    };
  });
  assert.ok(gate.gateShown, 'the sign-in gate is shown');
  assert.equal(gate.skinDisplay, 'none', 'cabinet skin panel is display:none on the sign-in gate');
  assert.equal(gate.skinWidth, 0, 'cabinet skin panel takes no space on the sign-in gate');
  assert.ok(!gate.layoutCols.includes(' '), 'the gate uses a single full-width column');
  await guest.close();
  console.log('PASS sign-in gate hides the cabinet skin panel');

  assert.equal(errors.length, 0, `Browser errors: ${errors.join('; ')}`);
  console.log('PASS no browser exceptions');
} finally {
  await browser.close();
}
