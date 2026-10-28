// Canvas-only multiplayer renderer. It never moves a snake or decides a
// collision, score or winner; it draws only versioned server snapshots from
// Simulation::Protocol v1, which the leased simulator owns.
//
// RENDERING MODEL: whole authoritative frames, grid locked. The latest
// received state updates controls immediately. The display uses one rAF per
// refresh and a bounded cadence queue on coarse pointers when arrival jitter
// is measured; it NEVER fabricates cells, interpolates, or advances time.
// A turn/death/freeze/status change bypasses the queue. Long stalls discard
// stale history rather than playing catch-up. Clean links have no intentional
// hold; jittery links can hold a frame <= min(50ms, half a tick) plus the next
// refresh. This trade-off is observable and switchable in Movement diagnostics.
import { createPlayBudget, text, hudKey } from './play-budget.js?v=step10-mobile3';
import { GridCadence, MovementTimings, FrameGate } from './grid-cadence.js?v=step10-mobile3';

const HEX = /^#[0-9a-f]{6}$/i;

export class MultiplayerGameRenderer {
  constructor({ canvas, scoreboard, status, ownParticipantId, budget = null,
                cadenceEnabled = null, clock = () => performance.now(),
                frameRequest = (cb) => requestAnimationFrame(cb),
                frameCancel = (id) => cancelAnimationFrame(id),
                timerRequest = (cb, ms) => setTimeout(cb, ms), timerCancel = (id) => clearTimeout(id) }) {
    this.canvas = canvas;
    this.scoreboard = scoreboard;
    this.status = status;
    this.ownParticipantId = ownParticipantId ?? null;
    this.snapshot = null; // newest RECEIVED frame; controls must never wait on display
    this.paintSnapshot = null; // newest PRESENTED complete server frame
    this.clock = clock;
    this.frameRequest = frameRequest;
    this.frameCancel = frameCancel;
    this.frameGate = new FrameGate({ request: frameRequest, cancel: frameCancel, later: timerRequest, clear: timerCancel });
    this.viewPaused = false;
    this.coarsePointer = !!window.matchMedia?.('(any-pointer: coarse)').matches;
    // Delivery pacing on a jittery tunnel can add 30–60 ms of receive-to-
    // paint delay. It improved spacing in synthetic traces, but made the
    // actual phone feel late. Start in lowest-latency mode; smoothing remains
    // an explicit opt-in in Movement diagnostics.
    this.cadence = new GridCadence({ enabled: cadenceEnabled ?? false });
    this.timings = new MovementTimings();
    this.receivedAt = new WeakMap();
    // The first context request determines its attributes for its lifetime.
    // The whole board is opaque: avoid an unnecessary alpha-compositing pass.
    // Do NOT request desynchronized: it can tear/flicker on some devices.
    this.context = canvas.getContext('2d', { alpha: false });
    // Death dust: spawned LOCALLY from the authoritative body cells of a newly
    // eliminated snake. Coordinates are never transmitted.
    this.dust = [];
    this.dustFrame = 0;
    this.followId = null;
    this.tickMs = 105;
    this.frozenTimer = 0;
    this.serverOffsetMs = 0;
    this.paintFrame = 0;
    this.dirty = false;
    this.scoreSignature = '';
    this.scoreRows = new Map();
    this.active = true; // mounted renderers are active; the lobby explicitly pauses hidden panes
    this.hidden = document.hidden;
    this.hudBudget = budget || createPlayBudget();
    // Only the canvas and the network move at tick cadence. HUD labels update
    // at <= 1 Hz (or immediately when an important control change occurs).
    this.hudBudget.start();
    this.onVisibility = () => {
      this.hidden = document.hidden;
      if (this.hidden) {
        this.hudBudget.stop();
        this.stopFreezeRings();
        this.discardPendingFrames();
      } else {
        this.hudBudget.start();
        this.hudBudget.add('scores', () => this.drawScoreboard());
        // Do not replay any frames collected while the tab was suspended.
        this.cadence.reset();
        if (this.snapshot) this.cadence.receive(this.snapshot, this.clock(), true);
        this.requestDraw();
      }
    };
    document.addEventListener('visibilitychange', this.onVisibility);
    this.view = { width: 0, height: 0, dpr: 1 };
    this.theme = this.readTheme();
    this.gridCache = null;
    this.reducedMotion = typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.resizePending = false;
    this.resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          if (this.resizePending) return;
          this.resizePending = true;
          // One measure per frame, never one per resize event.
          requestAnimationFrame(() => { this.resizePending = false; this.measure(); });
        }) : null;
    this.resizeObserver?.observe(canvas);
    this.themeObserver = new MutationObserver(() => {
      this.theme = this.readTheme();
      this.gridCache = null;
      this.requestDraw();
    });
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    this.measure();
  }

  readTheme() {
    const css = getComputedStyle(document.documentElement);
    return {
      background: css.getPropertyValue('--ink').trim() || '#0c0e10',
      grid: css.getPropertyValue('--line').trim() || 'rgba(255,255,255,.08)',
      accent: css.getPropertyValue('--green').trim() || '#35ff6b',
      red: css.getPropertyValue('--red').trim() || '#ff3b30',
    };
  }

  // Called on construction and by the ResizeObserver only — never in a paint.
  // Mobile browsers fire a resize storm whenever the URL bar shows or hides;
  // re-rasterising the grid layer for a one-pixel change is exactly the kind of
  // work that reads as jank on a phone, so sub-threshold changes are ignored.
  measure(force = false) {
    const rect = this.canvas.getBoundingClientRect();
    // Cap the backing store: a 3x phone would otherwise paint 9x the pixels of
    // a 1x screen for no visible gain in a block-art game.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const previous = this.view;
    const material = force || !previous.width ||
      Math.abs(rect.width - previous.width) >= 2 ||
      Math.abs(rect.height - previous.height) >= 2 ||
      dpr !== previous.dpr;
    if (!material) return;
    this.view = { width: rect.width, height: rect.height, dpr };
    this.gridCache = null;
    this.requestDraw();
  }

  reset() {
    this.discardPendingFrames();
    this.snapshot = null;
    this.paintSnapshot = null;
    this.timings = new MovementTimings();
    this.receivedAt = new WeakMap();
    this.dust = [];
    this.followId = null;
    this.serverOffsetMs = 0;
    this.scoreSignature = '';
    this.scoreRows.clear();
    if (this.dustFrame) cancelAnimationFrame(this.dustFrame);
    this.dustFrame = 0;
    this.stopFreezeRings();
    this.hudBudget.add('scores', () => this.drawScoreboard());
    this.requestDraw();
    return this;
  }

  setActive(active) {
    const wasPaused = this.viewPaused;
    this.active = active;
    this.viewPaused = !active;
    if (!active) this.discardPendingFrames();
    if (active) {
      this.hudBudget.flush('scores');
      if (wasPaused && this.snapshot) {
        this.cadence.receive(this.snapshot, this.clock(), true);
        this.requestDraw();
      }
    }
  }

  discardPendingFrames() {
    this.frameGate.cancel();
    this.paintFrame = 0;
    this.cadence.reset();
  }

  // User steering bypasses display pacing. The next server-confirmed turn is
  // urgent too (see accept). This does NOT predict the requested direction.
  expedite() {
    this.discardPendingFrames();
    if (this.snapshot) {
      const at = this.clock();
      this.cadence.receive(this.snapshot, at, true);
      const frame = this.cadence.take(at);
      if (frame && frame !== this.paintSnapshot && !this.hidden && !this.viewPaused) this.present(frame, at);
    }
  }

  setCadenceEnabled(enabled) {
    this.cadence.configure({ enabled });
    this.expedite();
  }

  movementDiagnostics() {
    return {
      ...this.timings.summary(), release: 'step10-mobile3', cadenceEnabled: this.cadence.enabled,
      maxHoldMs: this.cadence.maxWait, phaseMs: Math.round(this.cadence.phase),
      queued: this.cadence.queue.length, coalesced: this.cadence.coalesced,
      displayWatchdog: this.frameGate.fallbacks,
      receivedTick: this.snapshot?.t ?? null, displayedTick: this.paintSnapshot?.t ?? null,
      lastSnapshotAgeMs: this.timings.previous ? Math.round(this.clock() - this.timings.previous.at) : null,
      context: this.context?.getContextAttributes?.() || null,
    };
  }

  setOwnParticipant(id) {
    const nextId = id == null ? null : Number(id);
    if (nextId === this.ownParticipantId) return;
    this.ownParticipantId = nextId;
    this.scoreSignature = '';
    this.hudBudget.add('scores', () => this.drawScoreboard());
    this.requestDraw();
  }

  setTickMs(ms) {
    if (Number.isFinite(ms) && ms > 0 && ms !== this.tickMs) {
      this.tickMs = ms;
      this.cadence.configure({ tickMs: ms });
      if (this.snapshot) this.cadence.receive(this.snapshot, this.clock(), true);
      this.requestDraw();
    }
  }

  setFollow(id) {
    this.followId = id == null ? null : Number(id);
    this.requestDraw();
  }

  static formatSurvival(ticks, tickMs) {
    const totalSeconds = Math.max(0, Math.round((Number(ticks) || 0) * (Number(tickMs) || 0) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  // At most one canvas submission per refresh. WebSocket messages delivered
  // in a TCP burst must not each repaint a frame that can never be displayed.
  requestDraw(invalidate = true) {
    if (invalidate) this.dirty = true;
    if (this.frameGate.pending || this.hidden || this.viewPaused) return;
    this.frameGate.schedule(() => {
      const at = this.clock();
      const frame = this.cadence.take(at);
      if (frame) this.present(frame, at);
      else if (this.paintSnapshot && this.dirty) {
        this.draw();
        this.dirty = false;
      }
      if (this.cadence.pending) this.requestDraw(false);
    });
  }

  present(frame, at) {
    this.paintSnapshot = frame;
    const start = this.clock();
    this.draw();
    this.dirty = false;
    this.timings.draw(this.clock() - start, at - (this.receivedAt.get(frame) ?? at));
  }

  accept(snapshot) {
    if (!snapshot || snapshot.v !== 1 || snapshot.type !== 'snapshot' ||
        !Number.isInteger(snapshot.t) || !snapshot.b || !Array.isArray(snapshot.p) ||
        !Array.isArray(snapshot.f)) return false;
    if (this.snapshot && snapshot.m !== this.snapshot.m) return false;
    if (this.snapshot && snapshot.t < this.snapshot.t) return false; // stale/reordered
    const cols = snapshot.b.c; const rows = snapshot.b.r;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols * rows > 96 * 72) return false;
    const total = cols * rows;
    for (const player of snapshot.p) {
      if (!Number.isInteger(player.i) || !Array.isArray(player.b) || !HEX.test(player.c)) return false;
      if (player.b.some((cell) => !Number.isInteger(cell) || cell < 0 || cell >= total)) return false;
    }
    if (snapshot.f.some((food) => !Number.isInteger(food.c) || food.c < 0 || food.c >= total)) return false;
    const previous = this.snapshot;
    // Elimination is an authoritative receipt-time event, even if alive and
    // dead frames arrived in one browser task before a visible refresh.
    this.spawnDustForNewlyEliminated(snapshot, previous);
    const important = !previous || snapshot.s !== previous.s || snapshot.p.some((player) => {
      const before = previous.p.find((p) => p.i === player.i);
      if (!before || before.a !== player.a || !!before.fr !== !!player.fr || before.cy !== player.cy) return true;
      return player.i === this.ownParticipantId && (before.d !== player.d || before.sc !== player.sc);
    });
    const at = this.clock();
    this.receivedAt.set(snapshot, at);
    this.timings.receive(snapshot, at);
    if (Number.isFinite(snapshot.ts) && snapshot.ts > 0) this.serverOffsetMs = snapshot.ts - Date.now();

    this.snapshot = snapshot;
    this.hudBudget.add('scores', () => this.drawScoreboard());
    // Keep authoritative receipt/control state current even if display is
    // paced or paused. Only the visual frame goes through the tiny queue.
    if (!this.hidden && !this.viewPaused) {
      this.cadence.receive(snapshot, at, important);
      if (!this.cadence.enabled && this.coarsePointer) {
        // The existing frame gate races rAF against a 32ms watchdog. On a
        // phone this is an avoidable receive-to-paint delay even with pacing
        // OFF; real clean-link measurements were 34ms p95 with pacing and
        // ~15ms p95 without. A mobile canvas paint is <1ms in that profile.
        // Draw the just-received complete frame now. Browser scanout is still
        // up to the device and the server remains sole movement authority.
        this.frameGate.cancel();
        const frame = this.cadence.take(at);
        if (frame) this.present(frame, at);
      } else if (important) {
        // A confirmed turn, elimination, freeze, reconnect or result must not
        // acquire another display-queue delay. Ordinary motion is coalesced.
        this.frameGate.cancel();
        const frame = this.cadence.take(at);
        if (frame) this.present(frame, at);
      } else this.requestDraw(false);
    }
    if (important) {
      this.hudBudget.flush('scores');
    }
    if (snapshot.p.some((player) => player.fr)) this.startFreezeRings();
    else this.stopFreezeRings();
    return true;
  }

  spawnDustForNewlyEliminated(snapshot, previous) {
    if (this.reducedMotion || !previous) return;
    const wasAlive = new Map(previous.p.map((player) => [player.i, player.a]));
    for (const player of snapshot.p) {
      if (wasAlive.get(player.i) === true && player.a === false && Array.isArray(player.b)) {
        const cells = player.b.slice(0, 64);
        for (const index of cells) {
          const x = index % snapshot.b.c; const y = Math.floor(index / snapshot.b.c);
          for (let k = 0; k < 3; k++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 0.4 + Math.random() * 1.6;
            this.dust.push({
              x: x + 0.5, y: y + 0.5,
              vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 0.5,
              life: 1, decay: 0.012 + Math.random() * 0.02,
              size: 0.08 + Math.random() * 0.16,
              color: HEX.test(player.c) ? player.c : '#808080',
            });
          }
        }
      }
    }
    if (this.dust.length) this.pumpDust();
  }

  pumpDust() {
    if (this.dustFrame) return;
    const step = () => {
      this.dustFrame = 0;
      for (const particle of this.dust) {
        particle.x += particle.vx * 0.06;
        particle.y += particle.vy * 0.06;
        particle.vy += 0.02;
        particle.life -= particle.decay;
      }
      this.dust = this.dust.filter((particle) => particle.life > 0);
      this.requestDraw();
      if (this.dust.length) this.dustFrame = requestAnimationFrame(step);
    };
    this.dustFrame = requestAnimationFrame(step);
  }

  dustCountForTests() { return this.dust.length; }

  graceSecondsLeft(player) {
    if (!Number.isFinite(player.gu)) return 0;
    return Math.max(0, Math.ceil((player.gu - (Date.now() + this.serverOffsetMs)) / 1000));
  }

  // The only continuously animated element: the red loading ring on a frozen
  // head. Snakes themselves never animate between ticks. Runs at 20 fps and
  // only while somebody is actually frozen.
  startFreezeRings() {
    if (this.frozenTimer || this.reducedMotion || this.hidden || this.viewPaused) return;
    this.frozenTimer = window.setInterval(() => {
      if (!this.snapshot || !this.snapshot.p.some((player) => player.fr)) {
        this.stopFreezeRings();
        this.requestDraw();
        return;
      }
      this.paintFrozenLabels();
      this.requestDraw();
    }, 50);
  }

  stopFreezeRings() {
    if (!this.frozenTimer) return;
    window.clearInterval(this.frozenTimer);
    this.frozenTimer = 0;
  }

  paintFrozenLabels() {
    for (const player of this.snapshot?.p || []) {
      const node = this.scoreRows.get(player.i)?.tag;
      if (!node || !player.fr) continue;
      text(node, `frozen ${this.graceSecondsLeft(player)}s`);
    }
  }

  // Signature-based reconciliation: only rows that changed are touched.
  drawScoreboard() {
    if (!this.scoreboard || !this.snapshot) return;
    // Visibility is stateful, never offsetParent (which forces layout on a
    // dirty DOM). The browser still gets every authoritative canvas frame.
    if (this.hidden || !this.active) return;
    // Cheap signature: string concatenation, no JSON.stringify and no
    // intermediate arrays per snapshot (this runs at the tick rate).
    const signature = hudKey(this.snapshot, this.ownParticipantId, this.tickMs);
    if (signature === this.scoreSignature) {
      this.paintFrozenLabels();
      return;
    }
    this.scoreSignature = signature;
    const players = new Map((this.snapshot.p || []).map((player) => [player.i, player]));
    const fragment = document.createDocumentFragment();
    const nextRows = new Map();
    let structureChanged = false;
    for (const standing of this.snapshot.q || []) {
      const player = players.get(standing.i);
      if (!player) continue;
      const existing = this.scoreRows.get(standing.i);
      if (existing) {
        text(existing.place, `${standing.p}.`);
        text(existing.score, `${standing.sc} pts`);
        text(existing.length, `${player.l} long`);
        text(existing.survived, MultiplayerGameRenderer.formatSurvival(player.sv, this.tickMs));
        if (existing.row.classList.contains('is-you') !== (player.i === this.ownParticipantId)) {
          existing.row.classList.toggle('is-you', player.i === this.ownParticipantId);
        }
        this.paintTag(existing.tag, player);
        nextRows.set(player.i, existing);
        continue;
      }
      structureChanged = true;
      const row = document.createElement('li');
      row.className = `mp-game-score${player.i === this.ownParticipantId ? ' is-you' : ''}`;
      row.dataset.playerId = String(player.i);
      const color = document.createElement('span');
      color.className = 'mp-identity-color';
      color.style.setProperty('--player-color', HEX.test(player.c) ? player.c : '#808080');
      color.setAttribute('aria-hidden', 'true');
      const place = document.createElement('span'); place.className = 'mp-game-score__place';
      place.textContent = `${standing.p}.`;
      const name = document.createElement('span'); name.className = 'mp-game-score__name';
      name.textContent = player.n;
      const score = document.createElement('strong'); score.className = 'mp-game-score__points';
      score.textContent = `${standing.sc} pts`;
      const length = document.createElement('span'); length.className = 'mp-game-score__meta';
      length.textContent = `${player.l} long`;
      const survived = document.createElement('span'); survived.className = 'mp-game-score__meta';
      survived.textContent = MultiplayerGameRenderer.formatSurvival(player.sv, this.tickMs);
      const tag = document.createElement('span');
      this.paintTag(tag, player);
      row.append(color, place, name, score, length, survived, tag);
      fragment.append(row);
      nextRows.set(player.i, { row, place, score, length, survived, tag });
    }
    this.scoreRows = nextRows;
    const previousIds = [...this.scoreboard.children].map((row) => row.dataset.playerId);
    const order = [...nextRows.keys()].map(String);
    if (structureChanged || previousIds.join(',') !== order.join(',')) {
      this.scoreboard.replaceChildren(...Array.from(nextRows.values(), (entry) => entry.row));
    }
  }

  paintTag(tag, player) {
    if (player.a && player.fr) {
      if (tag.className !== 'mp-game-score__tag is-frozen') tag.className = 'mp-game-score__tag is-frozen';
      text(tag, `frozen ${this.graceSecondsLeft(player)}s`);
    } else if (player.a) {
      if (tag.className !== 'mp-game-score__tag is-alive') tag.className = 'mp-game-score__tag is-alive';
      text(tag, 'alive');
    } else {
      if (tag.className !== 'mp-game-score__tag') tag.className = 'mp-game-score__tag';
      text(tag, 'out');
    }
  }

  // Whole, server-confirmed cells only. No interpolation or extrapolation.
  draw() {
    const snapshot = this.paintSnapshot;
    const canvas = this.canvas;
    if (!snapshot || !canvas || this.hidden || this.viewPaused) return;
    if (!this.view.width || !this.view.height) {
      this.measure();
      if (!this.view.width || !this.view.height) return;
    }
    const { width, height, dpr } = this.view;
    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const pixelHeight = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth; canvas.height = pixelHeight;
    }
    const ctx = this.context;
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const cols = snapshot.b.c; const rows = snapshot.b.r;
    const cell = Math.min(width / cols, height / rows);
    const ox = (width - cell * cols) / 2;
    const oy = (height - cell * rows) / 2;

    // Background
    ctx.fillStyle = this.theme.background;
    ctx.fillRect(0, 0, width, height);

    // Grid lines - single fast batch path (42 line segments, 0.01ms)
    ctx.strokeStyle = this.theme.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= cols; x++) {
      const px = Math.round(ox + x * cell) + 0.5;
      ctx.moveTo(px, oy); ctx.lineTo(px, oy + rows * cell);
    }
    for (let y = 0; y <= rows; y++) {
      const py = Math.round(oy + y * cell) + 0.5;
      ctx.moveTo(ox, py); ctx.lineTo(ox + cols * cell, py);
    }
    ctx.stroke();

    // Food (zero allocations in loop)
    for (let f = 0; f < snapshot.f.length; f++) {
      const food = snapshot.f[f];
      const x = food.c % cols; const y = Math.floor(food.c / cols);
      let color = this.theme.red;
      for (let p = 0; p < snapshot.p.length; p++) {
        if (snapshot.p[p].i === food.o) {
          if (HEX.test(snapshot.p[p].c)) color = snapshot.p[p].c;
          break;
        }
      }
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(ox + (x + 0.5) * cell, oy + (y + 0.5) * cell, Math.max(2, cell * 0.31), 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.9)';
      ctx.lineWidth = Math.max(1, cell * .06);
      ctx.stroke();
    }

    // Snakes
    const followAlive = this.followId != null &&
      snapshot.p.some((player) => player.i === this.followId && player.a);
    const pad = Math.max(1, cell * .09);
    for (let p = 0; p < snapshot.p.length; p++) {
      const player = snapshot.p[p];
      const color = HEX.test(player.c) ? player.c : '#808080';
      ctx.globalAlpha = (player.a ? 1 : 0.3) * ((followAlive && player.i !== this.followId) ? 0.35 : 1);
      ctx.fillStyle = color;
      const body = player.b;
      ctx.beginPath();
      for (let part = 0; part < body.length; part++) {
        const index = body[part];
        const x = index % cols; const y = Math.floor(index / cols);
        const left = Math.round(ox + x * cell + pad);
        const top = Math.round(oy + y * cell + pad);
        const size = Math.max(1, Math.round(cell - pad * 2));
        ctx.rect(left, top, size, size);
      }
      ctx.fill();

      // Following/own head double ring
      if (body.length && (player.i === this.ownParticipantId || player.i === this.followId)) {
        const index = body[0];
        const x = index % cols; const y = Math.floor(index / cols);
        const left = Math.round(ox + x * cell + pad);
        const top = Math.round(oy + y * cell + pad);
        const size = Math.max(1, Math.round(cell - pad * 2));
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = Math.max(2, cell * .1);
        ctx.strokeRect(left, top, size, size);
        ctx.strokeStyle = this.theme.accent;
        ctx.lineWidth = 1;
        ctx.strokeRect(left + pad, top + pad, Math.max(1, size - pad * 2), Math.max(1, size - pad * 2));
      }
    }
    ctx.globalAlpha = 1;

    // Disconnected snakes stay exactly where the server left them, with a
    // small red loading circle on the head.
    for (let p = 0; p < snapshot.p.length; p++) {
      const player = snapshot.p[p];
      if (!player.a || !player.fr || !Array.isArray(player.b) || player.b.length === 0) continue;
      const index = player.b[0];
      const x = index % cols; const y = Math.floor(index / cols);
      const cx = ox + (x + 0.5) * cell;
      const cy = oy + (y + 0.5) * cell;
      const radius = Math.max(3.5, cell * 0.34);
      const phase = this.reducedMotion ? 0 : (performance.now() / 700) % 1;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = 'rgba(0,0,0,.65)';
      ctx.lineWidth = Math.max(2, cell * 0.16);
      ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = this.theme.red;
      ctx.lineWidth = Math.max(2, cell * 0.16);
      ctx.beginPath();
      ctx.arc(cx, cy, radius, phase * Math.PI * 2, phase * Math.PI * 2 + Math.PI * 1.25);
      ctx.stroke();
      ctx.fillStyle = this.theme.red;
      ctx.beginPath(); ctx.arc(cx, cy, Math.max(1.2, cell * 0.1), 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // Client-only death dust.
    for (const particle of this.dust) {
      const px = ox + particle.x * cell;
      const py = oy + particle.y * cell;
      ctx.globalAlpha = Math.max(0, Math.min(1, particle.life));
      ctx.fillStyle = particle.color;
      const particleSize = Math.max(1, particle.size * cell * particle.life);
      ctx.fillRect(px - particleSize / 2, py - particleSize / 2, particleSize, particleSize);
    }
    ctx.globalAlpha = 1;
  }

  destroy() {
    this.hudBudget.stop();
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.dustFrame) cancelAnimationFrame(this.dustFrame);
    this.discardPendingFrames();
    this.stopFreezeRings();
    this.dustFrame = 0;
    this.paintFrame = 0;
    this.dust = [];
    this.gridCache = null;
    this.resizeObserver?.disconnect();
    this.themeObserver?.disconnect();
  }
}
