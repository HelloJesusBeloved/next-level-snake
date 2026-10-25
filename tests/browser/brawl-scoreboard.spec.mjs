import { test, expect } from '@playwright/test';

// Step 9: live scoreboard columns, elimination presentation and results.
// Live assertions run against a real Brawl; deterministic rendering behavior
// (dust, reduced motion, results table, overlay) is exercised by importing the
// real production modules in the page and feeding them crafted snapshots.

async function hostRoom(page, name) {
  await page.goto('/multiplayer');
  await page.fill('#mp-name', name);
  await page.click('#mp-create');
  await expect(page.locator('#mp-room')).toBeVisible();
  return (await page.locator('#mp-room-code').textContent()).trim();
}

async function joinRoom(page, code, name) {
  await page.goto(`/multiplayer/${code}`);
  await page.fill('#mp-name', name);
  await page.click('#mp-join');
  await expect(page.locator('#mp-room')).toBeVisible();
}

function snapshot(partials) {
  return {
    v: 1, type: 'snapshot', m: 7, s: 'running', t: 42, r: 'brawl',
    b: { c: 24, r: 18 }, e: null, w: null,
    q: [
      { i: 1, p: 1, sc: 5, sv: 600, lg: 8 },
      { i: 2, p: 2, sc: 3, sv: 900, lg: 6 },
    ],
    p: [
      { i: 1, n: 'Ada', c: '#FF0000', sc: 5, l: 8, a: true, d: 'right', b: [100, 99, 98], sv: 600, lg: 8, el: null, er: null },
      { i: 2, n: 'Grace', c: '#00FF00', sc: 3, l: 6, a: false, d: 'up', b: [200, 199], sv: 900, lg: 6, el: 30, er: 'self_collision' },
    ],
    f: [{ c: 300, o: 1 }],
    ...partials,
  };
}

test('the live scoreboard shows rank, color, name, points, length, survival and status', async ({ browser, baseURL }) => {
  const contextA = await browser.newContext({ baseURL });
  const contextB = await browser.newContext({ baseURL });
  const host = await contextA.newPage();
  const guest = await contextB.newPage();
  try {
    const code = await hostRoom(host, 'Ada');
    await joinRoom(guest, code, 'Grace');
    await host.click('#mp-start');
    await expect(host.locator('#mp-game-canvas')).toBeVisible();
    await expect(host.locator('#mp-game-scores .mp-game-score')).toHaveCount(2);

    const rows = host.locator('#mp-game-scores .mp-game-score');
    await expect(rows.nth(0).locator('.mp-game-score__place')).toHaveText('1.');
    await expect(rows.nth(1).locator('.mp-game-score__place')).toHaveText('2.');
    for (const row of [rows.nth(0), rows.nth(1)]) {
      await expect(row.locator('.mp-game-score__points')).toContainText('pts');
      await expect(row.locator('.mp-game-score__meta').first()).toContainText('long');
      await expect(row.locator('.mp-game-score__meta').nth(1)).toContainText(/\d+:\d{2}/);
      await expect(row.locator('.mp-game-score__tag')).toBeVisible();
    }
    // Own row is highlighted on each client.
    await expect(host.locator('#mp-game-scores .mp-game-score.is-you .mp-game-score__name')).toHaveText('Ada');
    await expect(guest.locator('#mp-game-scores .mp-game-score.is-you .mp-game-score__name')).toHaveText('Grace');
    // Board / Standings / Lobby tabs switch panes without dropping membership.
    await host.click('[data-game-pane="standings"]');
    await expect(host.locator('#mp-standings-pane')).toBeVisible();
    await host.click('[data-game-pane="board"]');
    await expect(host.locator('#mp-board-pane')).toBeVisible();
    await host.click('[data-game-pane="lobby"]');
    await expect(host.locator('#mp-back-to-board-row')).toBeVisible();
    await host.click('#mp-board-view');
    await expect(host.locator('#mp-board-pane')).toBeVisible();
    const state = await host.request.get('/api/rooms/current').then((r) => r.json());
    expect(state.room.code).toBe(code);
  } finally {
    await contextA.close();
    await contextB.close();
  }
});

test('elimination spawns local dust, keeps final scores, and shows the overlay', async ({ page }) => {
  await page.goto('/multiplayer');
  const result = await page.evaluate(async () => {
    const { MultiplayerGameRenderer } = await import('/multiplayer/game-renderer.js');
    const ui = await import('/multiplayer/game-ui.js');
    const canvas = document.createElement('canvas');
    canvas.style.width = '480px'; canvas.style.height = '360px';
    document.body.append(canvas);
    const list = document.createElement('ol');
    document.body.append(list);
    const renderer = new MultiplayerGameRenderer({ canvas, scoreboard: list, status: null, ownParticipantId: 2 });
    const alive = {
      v: 1, type: 'snapshot', m: 7, s: 'running', t: 10, r: 'brawl', b: { c: 24, r: 18 },
      e: null, w: null, q: [{ i: 1, p: 1, sc: 0, sv: 100, lg: 3 }, { i: 2, p: 2, sc: 2, sv: 100, lg: 5 }],
      p: [
        { i: 1, n: 'Ada', c: '#FF0000', sc: 0, l: 3, a: true, d: 'right', b: [100, 99, 98], sv: 100, lg: 3, el: null, er: null },
        { i: 2, n: 'Grace', c: '#00FF00', sc: 2, l: 5, a: true, d: 'up', b: [200, 199, 198, 197, 196], sv: 100, lg: 5, el: null, er: null },
      ],
      f: [],
    };
    const dead = JSON.parse(JSON.stringify(alive));
    dead.t = 11;
    dead.p[1].a = false; dead.p[1].el = 11; dead.p[1].er = 'self_collision';
    const acceptedAlive = renderer.accept(alive);
    const dustBefore = renderer.dustCountForTests();
    const acceptedDead = renderer.accept(dead);
    // Scoreboard keeps the eliminated player with their final score.
    const rows = [...list.querySelectorAll('.mp-game-score')].map((row) => row.textContent);
    const overlayWrap = document.createElement('div');
    overlayWrap.innerHTML = `<div id="mp-eliminated" hidden><span id="mp-eliminated-name"></span><span id="mp-eliminated-score"></span></div>`;
    document.body.append(overlayWrap);
    const died = ui.newlyEliminated(alive, dead);
    ui.showEliminationOverlay(document, { name: 'Your snake', score: 2, placement: 2, total: 2 });
    const overlay = {
      visible: !document.querySelector('#mp-eliminated').hidden,
      text: document.querySelector('#mp-eliminated-score').textContent,
    };
    const results = ui.buildResultsTable({ ...dead, s: 'completed' }, 100, 2);
    document.body.append(results);
    const resultsText = [...results.querySelectorAll('tbody tr')].map((row) => row.textContent);
    const dustAfter = renderer.dustCountForTests();
    renderer.destroy();
    canvas.remove(); list.remove(); overlayWrap.remove(); results.remove();
    return { acceptedAlive, acceptedDead, dustBefore, dustAfter, rows, died, overlay, resultsText };
  });
  expect(result.acceptedAlive).toBe(true);
  expect(result.acceptedDead).toBe(true);
  expect(result.dustBefore).toBe(0);
  expect(result.dustAfter).toBeGreaterThan(0, 'dust spawns locally from the dead body cells');
  expect(result.rows[1]).toContain('out');
  expect(result.rows[1]).toContain('2 pts');
  expect(result.died).toEqual([2]);
  expect(result.overlay.visible).toBe(true);
  expect(result.overlay.text).toContain('2 points');
  expect(result.resultsText).toHaveLength(2);
  expect(result.resultsText[0]).toContain('Ada');
  expect(result.resultsText[1]).toContain('Grace');
});

test('reduced motion disables dust while keeping the dead body and scores', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/multiplayer');
  const result = await page.evaluate(async () => {
    const { MultiplayerGameRenderer } = await import('/multiplayer/game-renderer.js');
    const canvas = document.createElement('canvas');
    canvas.style.width = '480px'; canvas.style.height = '360px';
    document.body.append(canvas);
    const renderer = new MultiplayerGameRenderer({ canvas, scoreboard: null, status: null, ownParticipantId: 1 });
    const alive = {
      v: 1, type: 'snapshot', m: 7, s: 'running', t: 10, r: 'brawl', b: { c: 24, r: 18 },
      e: null, w: null, q: [{ i: 1, p: 1, sc: 0, sv: 10, lg: 3 }],
      p: [{ i: 1, n: 'Ada', c: '#FF0000', sc: 0, l: 3, a: true, d: 'right', b: [100, 99, 98], sv: 10, lg: 3, el: null, er: null }],
      f: [],
    };
    const dead = JSON.parse(JSON.stringify(alive));
    dead.t = 11; dead.p[0].a = false; dead.p[0].el = 11;
    renderer.accept(alive);
    renderer.accept(dead);
    const dust = renderer.dustCountForTests();
    renderer.destroy();
    canvas.remove();
    return { dust };
  });
  expect(result.dust).toBe(0);
});

test('spectator follow picker lists living players and highlights the followed snake', async ({ page }) => {
  await page.goto('/multiplayer');
  const result = await page.evaluate(async () => {
    const { MultiplayerGameRenderer } = await import('/multiplayer/game-renderer.js');
    const canvas = document.createElement('canvas');
    canvas.style.width = '480px'; canvas.style.height = '360px';
    document.body.append(canvas);
    const renderer = new MultiplayerGameRenderer({ canvas, scoreboard: null, status: null, ownParticipantId: null });
    const snap = {
      v: 1, type: 'snapshot', m: 7, s: 'running', t: 10, r: 'brawl', b: { c: 24, r: 18 },
      e: null, w: null, q: [{ i: 1, p: 1, sc: 1, sv: 10, lg: 4 }, { i: 2, p: 2, sc: 0, sv: 10, lg: 3 }],
      p: [
        { i: 1, n: 'Ada', c: '#FF0000', sc: 1, l: 4, a: true, d: 'right', b: [100, 99, 98, 97], sv: 10, lg: 4, el: null, er: null },
        { i: 2, n: 'Grace', c: '#00FF00', sc: 0, l: 3, a: false, d: 'up', b: [200, 199, 198], sv: 10, lg: 3, el: 5, er: 'self_collision' },
      ],
      f: [],
    };
    const accepted = renderer.accept(snap);
    renderer.setFollow(1);
    renderer.destroy();
    canvas.remove();
    return { accepted, followId: renderer.followId, living: snap.p.filter((p) => p.a).map((p) => p.n) };
  });
  expect(result.accepted).toBe(true);
  expect(result.followId).toBe(1);
  expect(result.living).toEqual(['Ada']);
});
