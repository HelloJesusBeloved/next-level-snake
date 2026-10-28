// Real Rails/Action Cable end-to-end probe. NOT a standalone or predicted game.
// Run: PLAYWRIGHT_BASE_URL=http://127.0.0.1:3100 node scripts/profile-brawl-cadence.mjs
// CPU_RATE=4, SPEED=3, JITTER=1, SECONDS=10, OUTPUT=/tmp/cadence.json
import { chromium, webkit, devices } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3100';
const engineName = process.env.BROWSER === 'webkit' ? 'webkit' : 'chromium';
const rate = engineName === 'chromium' ? Number(process.env.CPU_RATE || 4) : 1;
const speed = Number(process.env.SPEED || 3);
const jitter = process.env.JITTER === '1';
const seconds = Number(process.env.SECONDS || 10);
const pacingOff = process.env.PACING_OFF === '1';
const extraRooms = Math.max(0, Number(process.env.EXTRA_ROOMS || 0));
const players = Math.max(2, Number(process.env.PLAYERS || 2));
const cleanup = [];
const contexts = [];
const browser = await (engineName === 'webkit' ? webkit : chromium).launch({ headless: true, ...(engineName === 'chromium' ? { args: ['--disable-dev-shm-usage'] } : {}) });
const phone = devices[engineName === 'webkit' ? 'iPhone 13' : 'Pixel 7'];
const a = await browser.newContext({ ...phone, baseURL, viewport: { width: 390, height: 844 } });
const b = await browser.newContext({ ...phone, baseURL });
const page = await a.newPage();
const other = await b.newPage();
const errors = [];
const timers = new Set();
const wire = [];
const inputs = [];
let lastDelivery = 0;
let snapshotCount = 0;
page.on('pageerror', (error) => errors.push(error.message));
if (jitter) {
  await page.routeWebSocket('**/cable', (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((raw) => { server.send(raw); });
    server.onMessage((raw) => {
      let frame;
      try { frame = JSON.parse(raw.toString()).message; } catch {}
      // Ordered delivery models a WebSocket over jittery Wi-Fi: no reordering,
      // no packet loss, no invented snapshots. A 220ms stall once every 37 frames.
      const pattern = [0, 38, 5, 52, 12, 26, 0, 44];
      const isSnapshot = frame?.type === 'snapshot';
      const delay = isSnapshot ? (snapshotCount % 37 === 36 ? 220 : pattern[snapshotCount % pattern.length]) : 0;
      if (isSnapshot) snapshotCount++;
      // ACKs, room events and heartbeats must queue behind an earlier delayed
      // message too, just as they do on the actual ordered WebSocket/TCP stream.
      const due = Math.max(performance.now() + delay, lastDelivery);
      lastDelivery = due;
      const timer = setTimeout(() => { timers.delete(timer); try { ws.send(raw); } catch {} }, Math.max(0, due - performance.now()));
      timers.add(timer);
    });
  });
}
const cdp = engineName === 'chromium' ? await a.newCDPSession(page) : null;
if (cdp) {
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  await cdp.send('Network.enable');
}
const onReceived = ({ response }) => {
  try {
    const frame = JSON.parse(response.payloadData).message;
    if (frame?.type === 'snapshot') wire.push({ at: performance.now(), tick: frame.t, ts: frame.ts });
    if (frame?.type === 'input_ack') inputs.push({ kind: 'ack', at: performance.now(), seq: frame.seq, accepted: frame.accepted });
  } catch {}
};
const onSent = ({ response }) => {
  try {
    const raw = JSON.parse(response.payloadData);
    const input = raw.data ? JSON.parse(raw.data) : null;
    if (input?.action === 'input') inputs.push({ kind: 'sent', at: performance.now(), seq: input.seq });
  } catch {}
};
if (cdp) {
  cdp.on('Network.webSocketFrameReceived', onReceived);
  cdp.on('Network.webSocketFrameSent', onSent);
} else {
  page.on('websocket', (socket) => {
    socket.on('framereceived', ({ payload }) => onReceived({ response: { payloadData: payload.toString() } }));
    socket.on('framesent', ({ payload }) => onSent({ response: { payloadData: payload.toString() } }));
  });
}

try {
  for (let i = 0; i < extraRooms; i++) {
    const host = await browser.newContext({ baseURL });
    const peer = await browser.newContext({ baseURL });
    contexts.push(host, peer);
    const created = await (await host.request.post('/api/rooms', { data: { display_name: `Load-${i}`, settings: { speed_level: speed } } })).json();
    if (!created.room) throw new Error('Could not create load room');
    const code = created.room.code;
    cleanup.push(() => host.request.post(`/api/rooms/${code}/disband`, { data: {} }));
    await peer.request.post(`/api/rooms/${code}/join`, { data: { display_name: 'Load peer' } });
    const start = await host.request.post(`/api/rooms/${code}/start`, { data: {} });
    if (!start.ok()) throw new Error(`Could not start load room ${i}`);
  }
  const response = await a.request.post('/api/rooms', { data: { display_name: `Cadence-${Date.now()}`, settings: { speed_level: speed } } });
  const created = await response.json();
  if (!response.ok() || !created.room) throw new Error(`create: ${response.status()} ${JSON.stringify(created)}`);
  const code = created.room.code;
  cleanup.push(() => a.request.post(`/api/rooms/${code}/disband`, { data: {} }));
  const joined = await b.request.post(`/api/rooms/${code}/join`, { data: { display_name: 'Peer' } });
  if (!joined.ok()) throw new Error(`join: ${joined.status()}`);
  for (let i = 2; i < players; i++) {
    const peer = await browser.newContext({ baseURL }); contexts.push(peer);
    const joined = await peer.request.post(`/api/rooms/${code}/join`, { data: { display_name: `Peer ${i}` } });
    if (!joined.ok()) throw new Error(`join extra player: ${joined.status()}`);
  }
  await page.goto(`/multiplayer/${code}`);
  await other.goto(`/multiplayer/${code}`);
  await page.waitForFunction(() => document.querySelector('#mp-room')?.hidden === false);
  // Instrument actual renderer method calls. rAF observations are browser
  // opportunities, NOT a claim to measure physical screen scanout.
  await page.evaluate(async () => {
    // Instrument the module the app ACTUALLY loaded, not a second copy under
    // an old ?v=step8 URL (which would silently measure the wrong class).
    const loaded = performance.getEntriesByType('resource').map(entry => entry.name)
      .find(url => new URL(url).pathname === '/multiplayer/game-renderer.js');
    if (!loaded) throw new Error('Active renderer module was not observed');
    const { MultiplayerGameRenderer: Renderer } = await import(loaded);
    const records = window.__cadence = { arrivals: [], draws: [], opportunities: [], longTasks: [], inputTaps: [], refreshIntervals: [], mutations: 0, enabled: true, lastDraw: null };
    document.addEventListener('pointerdown', (event) => {
      const direction = event.target.closest('[data-game-dir]')?.dataset.gameDir;
      if (records.enabled && direction) records.inputTaps.push({ at: performance.now(), direction });
    }, { capture: true });
    const accept = Renderer.prototype.accept;
    Renderer.prototype.accept = function (frame) {
      window.__profileRenderer = this;
      if (records.enabled) records.arrivals.push({ at: performance.now(), tick: frame.t, ts: frame.ts,
        direction: frame.p?.find(p => p.i === this.ownParticipantId)?.d });
      return accept.call(this, frame);
    };
    const draw = Renderer.prototype.draw;
    Renderer.prototype.draw = function () {
      const start = performance.now();
      const result = draw.call(this);
      const displayed = this.paintSnapshot || this.snapshot;
      if (records.enabled && displayed) {
        records.lastDraw = displayed.t;
        records.draws.push({ at: start, tick: displayed.t, duration: performance.now() - start,
          direction: displayed.p?.find(p => p.i === this.ownParticipantId)?.d });
      }
      return result;
    };
    new MutationObserver((mutations) => { if (records.enabled) records.mutations += mutations.length; })
      .observe(document.querySelector('#mp-game'), { subtree: true, childList: true, attributes: true, characterData: true });
    records.longTasksSupported = PerformanceObserver.supportedEntryTypes.includes('longtask');
    if (records.longTasksSupported) {
      new PerformanceObserver((list) => { if (records.enabled) records.longTasks.push(...list.getEntries().map((e) => ({ at: e.startTime, duration: e.duration }))); })
        .observe({ entryTypes: ['longtask'] });
    }
    let priorRefresh = null;
    const opportunity = (at) => {
      if (!records.enabled) return;
      if (priorRefresh != null) records.refreshIntervals.push(at - priorRefresh);
      priorRefresh = at;
      if (records.lastDraw !== records.opportunities.at(-1)?.tick) records.opportunities.push({ at, tick: records.lastDraw });
      requestAnimationFrame(opportunity);
    };
    requestAnimationFrame(opportunity);
  });
  const started = await a.request.post(`/api/rooms/${code}/start`, { data: {} });
  if (!started.ok()) throw new Error(`start: ${started.status()} ${await started.text()}`);
  await page.waitForFunction(() => Number(document.querySelector('#mp-game')?.dataset.tick) > 5);
  await page.bringToFront();
  await page.locator('#mp-game-canvas').scrollIntoViewIfNeeded();
  if (pacingOff) {
    const pacing = page.locator('#mp-movement-pacing');
    if (await pacing.count() !== 1) throw new Error('Pacing switch missing: sync assets and restart production Rails');
    await page.locator('#mp-movement-diagnostics').evaluate((node) => { node.open = true; });
    await pacing.uncheck();
    await page.locator('#mp-movement-diagnostics').evaluate((node) => { node.open = false; });
    await page.locator('#mp-game-canvas').scrollIntoViewIfNeeded();
  }
  await page.waitForTimeout(500);
  await page.evaluate(() => { const r = window.__cadence; r.arrivals.length = r.draws.length = r.opportunities.length = r.longTasks.length = 0; r.mutations = 0; r.refreshIntervals.length = 0; });
  await page.waitForTimeout(seconds * 1000);
  // Exercise real touch after measuring undisturbed straight movement.
  for (const dir of ['up', 'left', 'down', 'right']) {
    await page.locator(`[data-game-dir="${dir}"]`).tap();
    await page.waitForTimeout(180);
  }
  const records = await page.evaluate(() => {
    window.__cadence.enabled = false;
    return { ...window.__cadence, diagnostics: window.__profileRenderer?.movementDiagnostics?.() };
  });
  const stats = (values) => {
    const sorted = values.slice().sort((a,b) => a-b);
    const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
    return { count: sorted.length, min: q(0), median: q(.5), p95: q(.95), max: q(1) };
  };
  const intervals = (events) => events.slice(1).map((e,i) => e.at - events[i].at);
  const distinct = (events) => events.filter((e,i) => !i || e.tick !== events[i-1].tick);
  const draws = distinct(records.draws);
  const summary = {
    engine: engineName, cpuRate: rate, speed, jitter, pacingOff, extraRooms, players, errors,
    arrivals: stats(intervals(distinct(records.arrivals))),
    displayOpportunities: stats(intervals(records.opportunities.filter(e => e.tick != null))),
    refreshIntervals: stats(records.refreshIntervals),
    drawCost: stats(records.draws.map(e => e.duration)),
    arrivalToDraw: stats(draws.map(e => { const arrival = records.arrivals.find(a => a.tick === e.tick); return arrival ? e.at - arrival.at : 0; })),
    tickGaps: records.arrivals.slice(1).filter((e,i) => e.tick > records.arrivals[i].tick + 1).map((e,i) => e.tick),
    longTasks: records.longTasksSupported ? records.longTasks : null, mutations: records.mutations,
    diagnostics: records.diagnostics,
    serverIntervals: stats(records.arrivals.slice(1).flatMap((e,i) => {
      const prior = records.arrivals[i];
      return e.tick > prior.tick && e.ts > 0 && prior.ts > 0 ? [(e.ts-prior.ts)/(e.tick-prior.tick)] : [];
    })),
    turnReceiveToPaint: stats(records.inputTaps.flatMap(tap => {
      const receipt = records.arrivals.find(e => e.at >= tap.at && e.direction === tap.direction);
      const paint = receipt && draws.find(e => e.tick === receipt.tick && e.direction === tap.direction);
      return receipt && paint ? [paint.at-receipt.at] : [];
    })),
    touchToConfirmedPaint: stats(records.inputTaps.flatMap(tap => {
      const paint = draws.find(e => e.at >= tap.at && e.direction === tap.direction);
      return paint ? [paint.at-tap.at] : [];
    })),
    inputAck: stats(inputs.filter(e => e.kind === 'ack').flatMap(e => { const sent = inputs.find(s => s.kind === 'sent' && s.seq === e.seq); return sent ? [e.at - sent.at] : []; })),
  };
  console.log(JSON.stringify(summary, null, 2));
  await writeFile(process.env.OUTPUT || '/tmp/cadence.json', JSON.stringify({ summary, records, wire, inputs }, null, 2));
  await a.request.post(`/api/rooms/${code}/disband`, { data: {} });
} finally {
  for (const timer of timers) clearTimeout(timer);
  for (const close of cleanup) { try { await close(); } catch {} }
  await browser.close();
}
