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
import { createPlayBudget, text, hudKey } from './play-budget.js?v=step10-mobile4';
import { GridCadence, MovementTimings, FrameGate } from './grid-cadence.js?v=step10-mobile4';
import { LocalPredictor } from './prediction.js?v=step11-responsive-5';
import { RemotePlayback } from './playback.js?v=step11-responsive-5';

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
    this.snapshotDiagnostics = { missing: 0, duplicate: 0, stale: 0 };
    this.snapshotSignature = null;
    this.snapshotVerdict = { applied: false, stale: false, duplicate: false, missingTicks: 0 };
    // ---- step 2: local prediction for THIS player's snake -------------------
    // One predictor per renderer, so canvas painting and steering share a single
    // tick phase. It stays inert (null-free, but disabled) for Classic Brawl:
    // every draw path below checks `localDisplay` before it changes a pixel, so
    // the shipped Classic behaviour is the same code that ran before this file.
    this.local = null;
    this.predictionMode = { active: false, source: 'off', testOnly: false };
    this.paintOverride = null; // frame actually painted (authoritative + predicted cells). Named apart
    // from paintFrame, which is the display frame-gate handle: two owners for one
    // field would silently break the rAF gate (and Classic with it).
    this.localDisplay = false;
    this.predictionLoop = null;
    // ---- step 3: smooth playback of OTHER players --------------------------
    // Independent of `local` in both directions: prediction owns this player's
    // snake, playback owns the rest of the board. Neither reads the other's
    // state, so a correction to one can never move the other.
    this.playback = null;
    this.playbackDraws = 0;
    this.playbackDrawCost = 0;
    this.lastPlaybackSample = null;
    this.onResyncNeeded = null;
    // null, not 0: the FIRST request must be allowed through. Starting at 0 made
    // every request inside the first second of a match look throttled, which is
    // exactly when a fresh subscription is most likely to need a seed.
    this.lastResyncAt = null;
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
    this.snapshotDiagnostics = { missing: 0, duplicate: 0, stale: 0 };
    this.snapshotSignature = null;
    this.snapshotVerdict = { applied: false, stale: false, duplicate: false, missingTicks: 0 };
    // A new round, a resubscribe or a reconnect: every unconfirmed prediction is
    // obsolete the moment this renderer resets. Nothing is replayed from before
    // the gap — the next authoritative frame restarts prediction from server
    // state only.
    this.stopPredictionLoop();
    this.paintOverride = null;
    this.localDisplay = false;
    this.local?.reset('renderer reset', { reconnect: true });
    this.playback?.reset('renderer reset');
    this.lastPlaybackSample = null;
    this.lastPaintedPlaybackTick = null;
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

  // ---- step 2: prediction control -----------------------------------------
  // The mode comes from the caller, which reads it off the AUTHORITATIVE match
  // strategy (or the explicit test override). Nothing here can infer or assume
  // Responsive: no strategy, no prediction.
  setPredictionMode(mode, match = null) {
    const next = { active: !!(mode && mode.active), source: mode?.source || 'off',
                   testOnly: !!(mode && mode.testOnly) };
    const changed = next.active !== this.predictionMode.active || next.source !== this.predictionMode.source;
    this.predictionMode = next;
    if (!next.active) {
      if (this.local) this.local.disable(match?.presentation_strategy || 'classic');
      if (this.playback) this.playback.disable(match?.presentation_strategy || 'classic');
      this.lastPlaybackSample = null;
      this.stopPredictionLoop();
      this.paintOverride = null;
      this.localDisplay = false;
      return changed;
    }
    this.local = this.local || new LocalPredictor({
      tickMs: this.tickMs, columns: match?.columns, rows: match?.rows,
      ownParticipantId: this.ownParticipantId, clock: this.clock
    });
    this.local.enable(next.source === 'test' ? 'test override' : 'responsive');
    this.playback = this.playback || new RemotePlayback({
      tickMs: this.tickMs, columns: this.snapshot?.b?.c, rows: this.snapshot?.b?.r, clock: this.clock
    });
    this.playback.enable(next.source === 'test' ? 'test override' : 'responsive');
    this.playback.configure({ tickMs: this.tickMs, columns: match?.columns, rows: match?.rows });
    this.configureLocal(match);
    this.startPredictionLoop();
    return changed;
  }

  configureLocal(match) {
    if (!this.local) return;
    this.local.configure({
      tickMs: this.tickMs, columns: match?.columns ?? this.snapshot?.b?.c,
      rows: match?.rows ?? this.snapshot?.b?.r, ownParticipantId: this.ownParticipantId,
      growth: Number.isInteger(match?.growth) ? match.growth : undefined,
      mode: match?.mode
    });
    if (this.snapshot) this.local.observe(this.snapshot, { applied: true });
  }

  // Steers the LOCAL view only. It never sends anything and never claims the
  // turn happened: the return value is this module's own bounded scheduling
  // decision, which is exactly why a refused prediction still goes to the
  // server (the server owns turns; this only owns pixels).
  predict(direction, seq) {
    if (!this.local || !this.local.enabled) return null;
    const record = this.local.submit(direction, seq);
    if (record && !record.rejectedReason) this.expedite();
    return record;
  }

  // A compact tick-ordered movement frame: only heads, lengths and scalars. The
  // playback buffer rebuilds each body from its own confirmed history, and
  // refuses (asking for a snapshot) rather than guessing when it cannot.
  //
  // Returns the complete snapshot that frame amounts to (or false). The caller
  // routes it through the SAME path as a server snapshot, so in Responsive Brawl
  // every tick — not just the periodic complete frame — reconciles local
  // prediction, refreshes the authoritative own-state mirror the input path reads
  // (its `tick`, alive/frozen gating), the scoreboard and the HUD. A rebuilt body
  // is byte-identical to the server's (rails/test/simulation/movement_protocol_test),
  // so nothing here is a guess; a frame that cannot be rebuilt is refused and a
  // snapshot is requested instead.
  acceptMovement(frame) {
    if (!this.playback?.enabled) return false;
    const added = this.playback.pushMovement(frame, this.clock());
    const resync = this.playback.takeResyncRequest();
    if (resync) this.requestResync(resync);
    if (!added) return false;
    return this.playback.materialize(frame, this.snapshot) || false;
  }

  requestResync(reason) {
    if (!this.onResyncNeeded) return false;
    const now = this.clock();
    // Never more than one request per resync interval: the answer is a complete
    // authoritative frame, and asking repeatedly cannot make it arrive sooner.
    if (this.lastResyncAt !== null && now - this.lastResyncAt < 1_000) return false;
    this.lastResyncAt = now;
    this.onResyncNeeded(reason);
    return true;
  }

  // A measured round trip (input ack or match heartbeat) sets how far the local
  // view should lead the confirmed tick. See LocalPredictor#setLeadTargetMs.
  setRoundTripMs(rttMs) { return this.local?.setLeadTargetMs(rttMs) ?? null; }

  noteInputQueued(seq) { this.local?.noteQueued(seq); }
  noteInputApplied(seq, tick) { this.local?.noteApplied(seq, tick); }
  noteInputRejected(seq, reason) {
    if (this.local?.noteRejected(seq, reason)) this.expedite();
  }

  noteInputSequence(lastInputSeq) { this.local?.noteSequenceMirror(lastInputSeq); }

  resetPrediction({ reconnect = false } = {}) {
    this.stopPredictionLoop();
    this.paintOverride = null;
    this.localDisplay = false;
    // Both halves of Responsive Brawl are reset together: an unconfirmed input
    // OR a confirmed tick chain from before the gap is equally worthless, and
    // the fresh seed frame is what rebuilds them.
    this.playback?.reset(reconnect ? 'reconnect' : 'reset');
    this.lastPlaybackSample = null;
    return this.local?.reset(reconnect ? 'reconnect' : 'reset', { reconnect }) ?? false;
  }

  // Fixed-step prediction on a MONOTONIC clock, deliberately not tied to the
  // authoritative frame cadence: turns are consumed only at tick boundaries by
  // the engine's own rules, so a snake never rotates between grid ticks. The
  // rAF callback only decides WHEN to advance; elapsed time decides HOW MUCH.
  startPredictionLoop() {
    if (this.predictionLoop !== null || !this.local?.enabled) return false;
    // One coordinated animation loop for both halves of Responsive Brawl. Every
    // snake on the board now changes only on a confirmed logical tick: the local
    // one when the server confirms a step, the remote ones when the playback
    // playhead crosses into a new confirmed tick. Both are driven from the same
    // monotonic reading so the two halves can never disagree about "now".
    const step = () => {
      this.predictionLoop = null;
      if (!this.local?.enabled) return;
      const at = this.clock();
      const ticks = this.local.advance(at);
      const smooth = this.playback?.enabled ? this.playback.sample(at) : null;
      this.lastPlaybackSample = smooth;
      if (!this.hidden && !this.viewPaused && this.snapshot) {
        // Remote players step on whole cells, so the board only changes when the
        // playhead crosses into a new confirmed tick — never on a sub-tick blend.
        const playbackMoved = !!smooth && !!smooth.players &&
          smooth.tick !== this.lastPaintedPlaybackTick;
        if (playbackMoved) this.lastPaintedPlaybackTick = smooth.tick;
        if (ticks > 0) this.present(this.snapshot, at);
        else if (playbackMoved) this.presentPlayback(at);
      }
      if (this.local.enabled) this.predictionLoop = this.frameRequest(step);
    };
    this.predictionLoop = this.frameRequest(step);
    return true;
  }

  stopPredictionLoop() {
    if (this.predictionLoop === null) return false;
    this.frameCancel(this.predictionLoop);
    this.predictionLoop = null;
    return true;
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
      missingSnapshots: this.snapshotDiagnostics.missing,
      duplicateSnapshots: this.snapshotDiagnostics.duplicate,
      staleSnapshots: this.snapshotDiagnostics.stale,
      // Step 2: is the own snake currently being painted from prediction, and
      // what did reconciliation have to fix? Read from the predictor, never
      // guessed, so a claimed Responsive state always has a number behind it.
      prediction: this.local ? { ...this.local.summary(), painted: this.localDisplay,
                                 mode: this.predictionMode } : null,
      playback: this.playback ? {
        ...this.playback.summary(),
        painted: !!this.lastPlaybackSample?.players,
        playbackDraws: this.playbackDraws,
        playbackDrawCostMs: Math.round(this.playbackDrawCost * 100) / 100,
        lastSample: this.lastPlaybackSample ? {
          tick: this.lastPlaybackSample.tick,
          buffered: this.lastPlaybackSample.buffered, delayMs: this.lastPlaybackSample.delayMs,
          atLiveEdge: this.lastPlaybackSample.atLiveEdge, interpolated: false
        } : null
      } : null,
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
      // The predictor must run at the SAME fixed interval the engine steps at,
      // or "predicted" would just mean "drifted".
      this.local?.configure({ tickMs: ms });
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

  // A display frame produced purely by remote interpolation. It is NOT a server
  // arrival, so it must not enter the receive->paint timing series; only the
  // canvas cost is measured, separately.
  presentPlayback(at) {
    const start = this.clock();
    this.draw();
    const cost = this.clock() - start;
    this.playbackDrawCost = this.playbackDrawCost ? this.playbackDrawCost * 0.9 + cost * 0.1 : cost;
    this.playbackDraws += 1;
  }

  // What the canvas should draw for players OTHER than this one. Returns null
  // unless Responsive playback is armed and has a confirmed sample, which keeps
  // Classic on the original integer-cell path with no extra work per frame.
  smoothPlayers() {
    if (!this.playback?.enabled) return null;
    const sample = this.lastPlaybackSample;
    return sample && sample.players ? sample : null;
  }

  present(frame, at) {
    this.paintSnapshot = frame;
    // Only the own snake's cells/direction/length may come from prediction; the
    // frame painted is otherwise this exact authoritative frame, so remote
    // snakes, food, freeze rings, dust, themes and the canvas cache are all
    // still 100% server-confirmed. `paintSnapshot` stays authoritative so the
    // HUD, scoreboard and results never read a predicted value.
    const predicted = this.local && this.local.active ? this.local.displayFrame(frame) : null;
    this.paintOverride = predicted && predicted !== frame ? predicted : null;
    this.localDisplay = !!this.paintOverride;
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
    this.snapshotVerdict = { applied: false, stale: false, duplicate: false, missingTicks: 0 };
    if (this.snapshot && snapshot.t < this.snapshot.t) {
      this.snapshotDiagnostics.stale += 1; // stale or out-of-order authoritative tick
      this.snapshotVerdict.stale = true;
      return false;
    }
    const cols = snapshot.b.c; const rows = snapshot.b.r;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols * rows > 96 * 72) return false;
    const total = cols * rows;
    for (const player of snapshot.p) {
      if (!Number.isInteger(player.i) || !Array.isArray(player.b) || !HEX.test(player.c)) return false;
      if (player.b.some((cell) => !Number.isInteger(cell) || cell < 0 || cell >= total)) return false;
    }
    if (snapshot.f.some((food) => !Number.isInteger(food.c) || food.c < 0 || food.c >= total)) return false;
    const previous = this.snapshot;
    if (previous && snapshot.t === previous.t) {
      const signature = JSON.stringify([snapshot.s, snapshot.r, snapshot.b, snapshot.e,
        snapshot.w, snapshot.q, snapshot.p, snapshot.f]);
      const previousSignature = this.snapshotSignature || JSON.stringify([previous.s, previous.r, previous.b,
        previous.e, previous.w, previous.q, previous.p, previous.f]);
      if (signature === previousSignature) {
        this.snapshotDiagnostics.duplicate += 1;
        this.snapshotVerdict.duplicate = true;
        return false;
      }
      this.snapshotSignature = signature;
    } else {
      if (previous && snapshot.t > previous.t + 1) {
        this.snapshotDiagnostics.missing += snapshot.t - previous.t - 1;
        this.snapshotVerdict.missingTicks = snapshot.t - previous.t - 1;
      }
      // Same-tick comparisons are rare (idle keepalives or connection changes),
      // so don't serialize every growing snake on every movement frame.
      this.snapshotSignature = null;
    }
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
    this.snapshotVerdict.applied = true;
    // Reconcile prediction against the frame that was just accepted — and only
    // that one. Stale and duplicate frames returned above, so a repeated or
    // out-of-order update can never rewind a predicted snake (nor "confirm" a
    // tick the server has not run).
    this.local?.observe(snapshot, this.snapshotVerdict);
    // Complete snapshots are the recovery channel for playback too: they carry
    // whole bodies, so they re-seed remote history and correct any drift that a
    // compact movement chain could have accumulated.
    // A frame materialised FROM the playback buffer is already in it; only a
    // frame the server sent whole may re-seed remote history.
    if (this.playback?.enabled && !snapshot.reconstructed) {
      this.playback.configure({ columns: snapshot.b.c, rows: snapshot.b.r });
      this.playback.pushSnapshot(snapshot, this.clock());
      this.playback.takeResyncRequest();
    }
    if (this.local?.enabled && !this.local.active) this.stopPredictionLoop();
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
    const snapshot = this.paintOverride || this.paintSnapshot;
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

    // Step 3: remote players are drawn from confirmed history a bounded distance
    // behind the newest frame. `smooth` is null for Classic, which keeps the
    // integer-cell path below byte-for-byte the old code.
    const smooth = this.smoothPlayers();
    const ownId = this.ownParticipantId;

    // Food (zero allocations in the hot loop).
    //
    // A remote snake is deliberately held behind the newest frame, so its pellet
    // must be drawn where the snake you can SEE is — not where the newest frame
    // says it already ate it. Otherwise the pellet vanishes into empty board
    // several ticks before the visible bite. Brawl food is per player ("o" is the
    // owner), which makes the split exact: each pellet follows its own snake's
    // displayed tick, and the local player's pellet follows the newest frame
    // because the local snake does.
    const heldFood = smooth && Array.isArray(smooth.food) ? smooth.food : null;
    const heldByOwner = heldFood ? new Map() : null;
    if (heldByOwner) {
      for (let i = 0; i < heldFood.length; i++) {
        const pellet = heldFood[i];
        if (pellet && Number.isInteger(pellet.o)) heldByOwner.set(pellet.o, pellet);
      }
    }
    const pelletColor = (owner) => {
      for (let p = 0; p < snapshot.p.length; p++) {
        if (snapshot.p[p].i === owner && HEX.test(snapshot.p[p].c)) return snapshot.p[p].c;
      }
      return this.theme.red;
    };
    const drawPellet = (index, color) => {
      const x = index % cols; const y = Math.floor(index / cols);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(ox + (x + 0.5) * cell, oy + (y + 0.5) * cell, Math.max(2, cell * 0.31), 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.9)';
      ctx.lineWidth = Math.max(1, cell * .06);
      ctx.stroke();
    };
    const newestOwners = new Set();
    for (let f = 0; f < snapshot.f.length; f++) {
      const food = snapshot.f[f];
      if (Number.isInteger(food.o)) newestOwners.add(food.o);
      const remote = heldByOwner && food.o !== ownId ? heldByOwner.get(food.o) : null;
      drawPellet(remote && Number.isInteger(remote.c) ? remote.c : food.c, pelletColor(food.o));
    }
    // A pellet the newest frame no longer carries, but whose (delayed) snake has
    // not reached it yet on the board we are drawing: keep showing it until the
    // bite you can actually see happens.
    if (heldByOwner) {
      for (const [owner, pellet] of heldByOwner) {
        if (owner === ownId || newestOwners.has(owner)) continue;
        if (!Number.isInteger(pellet.c)) continue;
        drawPellet(pellet.c, pelletColor(owner));
      }
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
      const remote = smooth && smooth.players ? smooth.players.get(player.i) : null;
      // Whole confirmed cells for a remote snake; the newest confirmed cells for
      // this player. No fractional coordinates exist anywhere in this path, so a
      // snake can only ever occupy real grid squares — the same stepping as
      // Classic and as the local snake.
      const held = !!(remote && Array.isArray(remote.cells) && remote.cells.length) &&
        player.i !== ownId;
      const drawn = held ? remote.cells : body;
      ctx.beginPath();
      for (let part = 0; part < drawn.length; part += 1) {
        const index = drawn[part];
        const x = index % cols; const y = Math.floor(index / cols);
        const left = Math.round(ox + x * cell + pad);
        const top = Math.round(oy + y * cell + pad);
        const size = Math.max(1, Math.round(cell - pad * 2));
        ctx.rect(left, top, size, size);
      }
      ctx.fill();

      // Following/own head double ring. It reads the SAME cells that were just
      // drawn, so the marker can never sit on a different square from the head it
      // belongs to (it used to read the newest snapshot while a delayed snake was
      // painted from history, which is the "detached head pointer" report).
      if (drawn.length && (player.i === this.ownParticipantId || player.i === this.followId)) {
        const index = drawn[0];
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
      // The ring goes on the head that was actually drawn, not on the newest
      // frame's head, so it can never float off the snake.
      const frozenRemote = smooth && smooth.players && player.i !== ownId
        ? smooth.players.get(player.i) : null;
      const frozenCells = frozenRemote && Array.isArray(frozenRemote.cells) && frozenRemote.cells.length
        ? frozenRemote.cells : player.b;
      const index = frozenCells[0];
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
    // Step 2: the prediction loop owns one animation-frame callback, so it
    // must be released here too. The existing teardown assertion (no queued
    // repaint after destroy) is the guarantee that this is not optional.
    this.stopPredictionLoop();
    this.local?.disable('destroyed');
    this.playback?.disable('destroyed');
    this.playback = null;
    this.lastPlaybackSample = null;
    this.paintOverride = null;
    this.localDisplay = false;
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
