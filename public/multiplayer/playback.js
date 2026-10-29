/*!
 * Responsive Brawl — smooth playback of OTHER players' authoritative movement.
 *
 * The server stays the only source of movement. This module does not simulate,
 * predict or extrapolate anything: it stores server-confirmed frames in tick
 * order and plays them back a short, intentional distance behind the live edge,
 * so ordinary network jitter is absorbed instead of being rendered as stutter.
 *
 * WHY IT CANNOT CUT CORNERS
 * Every rendered body is built from two ADJACENT confirmed frames and each body
 * segment interpolates only to where that same segment is in the next frame.
 * Segment i of tick T+1 is the cell segment i-1 vacated at tick T, so a
 * Right -> Up -> Left sequence is played as exactly those three turns. Nothing
 * is ever interpolated across a multi-tick gap: if the adjacent frame is missing
 * the playhead holds at the last confirmed tick and reports the gap.
 *
 * Wrapping is handled in toroidal space (the shortest step between two cells on
 * a board whose edges join), so a snake crossing an edge slides off one side and
 * on to the other. It can never be drawn flying across the board.
 *
 * The local player is NOT handled here. Prediction (step 2) owns that snake and
 * is deliberately independent of this buffer.
 */

// Tuning targets from the step-3 brief. They are targets, not guarantees: the
// achieved delay also includes the physical delivery time of the frame.
export const PLAYBACK_TUNING = Object.freeze({
  // Stable link: hide a couple of frames of ordinary jitter.
  stableDelayMs: 120,
  // Moderate jitter.
  moderateDelayMs: 260,
  // Heavy jitter / bursty delivery.
  heavyDelayMs: 480,
  // Hard bounds. Below this the buffer cannot hide one late frame; above it the
  // remote board would visibly trail the local snake for too long.
  minDelayMs: 90,
  maxDelayMs: 600,
  // Delay adaptation is deliberately slow (ms of delay per second), so the
  // remote snakes never visibly speed up or slow down to chase the target.
  adaptMsPerSecond: 40,
  // A gap this large in ticks is treated as a lost stream rather than jitter: the
  // buffer is discarded and an authoritative snapshot is requested.
  resyncGapTicks: 12,
  // Memory ceiling: never keep more than this many confirmed ticks.
  maxBufferTicks: 40,
  // If the playhead drifts this far behind, history is stale and is dropped.
  maxLagTicks: 20,
  // Jitter is measured over a short window so a burst raises the delay quickly
  // and a clean link lowers it slowly.
  jitterWindow: 8
});

const isTick = (value) => Number.isSafeInteger(value) && value >= 0;

export class RemotePlayback {
  constructor({ tickMs = 105, columns = 24, rows = 18, clock = () => performance.now(), limits = {} } = {}) {
    this.limits = { ...PLAYBACK_TUNING, ...limits };
    this.clock = clock;
    this.tickMs = Number.isFinite(tickMs) && tickMs > 0 ? tickMs : 105;
    // Board geometry is needed to resolve a wrapped step in toroidal space.
    this.columns = Number.isInteger(columns) && columns > 0 ? columns : 24;
    this.rows = Number.isInteger(rows) && rows > 0 ? rows : 18;
    this.enabled = false;
    this.frames = []; // ascending tick order, each { tick, players: Map, food, status, ts }
    this.byTick = new Map();
    this.playhead = null;
    this.lastSampleAt = null;
    this.delayMs = this.limits.stableDelayMs;
    this.targetDelayMs = this.limits.stableDelayMs;
    this.arrivals = [];
    this.jitterMs = 0;
    this.needsResync = false;
    this.stats = this.blankStats();
  }

  blankStats() {
    return {
      frames: 0, movementFrames: 0, snapshotFrames: 0, dropped: 0, duplicates: 0, outOfOrder: 0,
      missingTicks: 0, gaps: 0, underruns: 0, resyncs: 0, staleDrops: 0,
      delayRaised: 0, delayLowered: 0, adaptSteps: 0, samples: 0, interpolatedFrames: 0,
      heldFrames: 0, wrapSegments: 0, reconstructed: 0, reconstructRejects: 0
    };
  }

  enable(reason = 'responsive') {
    if (this.enabled) return false;
    this.enabled = true;
    this.reason = reason;
    this.stats = this.blankStats();
    return true;
  }

  disable(reason = 'classic') {
    const was = this.enabled;
    this.enabled = false;
    this.reason = reason;
    this.reset();
    return was;
  }

  configure({ tickMs, columns, rows }) {
    if (Number.isFinite(tickMs) && tickMs > 0 && tickMs !== this.tickMs) {
      this.tickMs = tickMs;
      this.playhead = null; // a speed change re-anchors the clock, it never stretches
    }
    if (Number.isInteger(columns) && columns > 0) this.columns = columns;
    if (Number.isInteger(rows) && rows > 0) this.rows = rows;
  }

  reset(reason = 'reset') {
    this.frames = [];
    this.byTick.clear();
    this.playhead = null;
    this.lastSampleAt = null;
    this.arrivals = [];
    this.jitterMs = 0;
    this.needsResync = false;
    this.lastReason = reason;
  }

  // ---- intake -------------------------------------------------------------

  // A complete authoritative snapshot. Bodies arrive whole, so this is the only
  // place a player's body is taken verbatim (and the only recovery path).
  pushSnapshot(frame, at = this.clock()) {
    if (!this.enabled || !frame || !isTick(frame.t) || !Array.isArray(frame.p)) return false;
    const players = new Map();
    for (const player of frame.p) {
      if (!Number.isSafeInteger(player.i) || !Array.isArray(player.b)) continue;
      players.set(player.i, {
        cells: player.b.slice(), dir: player.d, len: Number.isInteger(player.l) ? player.l : player.b.length,
        alive: player.a !== false, frozen: !!player.fr, score: player.sc
      });
    }
    if (frame.b && Number.isInteger(frame.b.c) && Number.isInteger(frame.b.r)) {
      this.columns = frame.b.c; this.rows = frame.b.r;
    }
    this.stats.snapshotFrames += 1;
    this.accept({ tick: frame.t, players, food: frame.f, status: frame.s, ts: frame.ts, full: true }, at);
    return true;
  }

  // A compact movement frame: head, length and scalars per player. Bodies are
  // rebuilt from this buffer's own previous confirmed body, which is exactly the
  // reconstruction Simulation::Protocol.rebuild_body documents and the Rails
  // test proves. If there is no previous body (or the length jumps by more than
  // the one cell a tick can add), the frame is refused and a snapshot is asked
  // for: a wrong body is worse than a late one.
  pushMovement(frame, at = this.clock()) {
    if (!this.enabled || !frame || !isTick(frame.t)) return false;
    const previous = this.newest();
    if (!previous) {
      this.requestResync('no confirmed body to rebuild from');
      return false;
    }
    if (frame.t !== previous.tick + 1) {
      // Movement frames only make sense as a contiguous chain. A jump means the
      // chain is broken, and rebuilding a body across it would be a guess.
      this.noteGap(previous.tick, frame.t);
      return false;
    }
    const players = new Map();
    for (const entry of frame.p || []) {
      const before = previous.players.get(entry.i);
      if (!Number.isSafeInteger(entry.h) || !before) {
        this.stats.reconstructRejects += 1;
        this.requestResync('movement frame without a usable previous body');
        return false;
      }
      const length = Number.isInteger(entry.l) ? entry.l : before.cells.length;
      if (length < 1 || length > before.cells.length + 1) {
        this.stats.reconstructRejects += 1;
        this.requestResync(`impossible length ${length} after ${before.cells.length}`);
        return false;
      }
      const cells = [entry.h, ...before.cells.slice(0, length - 1)];
      players.set(entry.i, {
        cells, dir: entry.d, len: length, alive: entry.a !== false,
        frozen: !!entry.fr, score: entry.sc
      });
      this.stats.reconstructed += 1;
    }
    this.stats.movementFrames += 1;
    this.accept({ tick: frame.t, players, food: frame.f, status: frame.s, ts: frame.ts, full: false }, at);
    return true;
  }

  accept(frame, at) {
    const existing = this.byTick.get(frame.tick);
    if (existing) {
      // The same tick twice is never replayed as movement, but the NEWEST server
      // statement about that tick wins when it says something structural. The
      // engine publishes the eliminating frame at the tick the snake died, so
      // dropping it would leave a dead snake drawn as alive. A complete frame
      // also always outranks a reconstructed one, because it is what the server
      // actually holds.
      this.stats.duplicates += 1;
      const structural = frame.status !== existing.status ||
        [...frame.players].some(([id, player]) => {
          const before = existing.players.get(id);
          return !before || before.alive !== player.alive || before.frozen !== player.frozen;
        });
      if ((frame.full && !existing.full) || structural) {
        this.byTick.set(frame.tick, frame);
        const index = this.frames.findIndex((entry) => entry.tick === frame.tick);
        if (index >= 0) this.frames[index] = frame;
      }
      return false;
    }
    const newest = this.newest();
    if (newest && frame.tick < newest.tick) {
      this.stats.outOfOrder += 1;
      return false;
    }
    if (newest && frame.tick > newest.tick + 1) this.noteGap(newest.tick, frame.tick);

    this.frames.push(frame);
    this.byTick.set(frame.tick, frame);
    this.stats.frames += 1;
    this.trim();
    this.observeArrival(frame.tick, at);
    return true;
  }

  noteGap(fromTick, toTick) {
    this.stats.gaps += 1;
    this.stats.missingTicks += Math.max(1, toTick - fromTick - 1);
    if (toTick - fromTick > this.limits.resyncGapTicks) this.requestResync(`gap of ${toTick - fromTick} ticks`);
  }

  requestResync(reason) {
    if (this.needsResync === reason) return;
    this.needsResync = reason;
    this.stats.resyncs += 1;
  }

  takeResyncRequest() {
    const reason = this.needsResync;
    this.needsResync = false;
    return reason;
  }

  trim() {
    const newest = this.newest();
    if (!newest) return;
    // Keep at most maxBufferTicks entries, counting the newest one.
    const floor = newest.tick - this.limits.maxBufferTicks + 1;
    if (this.frames.length && this.frames[0].tick < floor) {
      const kept = this.frames.filter((frame) => frame.tick >= floor);
      this.stats.dropped += this.frames.length - kept.length;
      this.frames = kept;
      this.byTick.clear();
      for (const frame of kept) this.byTick.set(frame.tick, frame);
    }
  }

  newest() {
    return this.frames.length ? this.frames[this.frames.length - 1] : null;
  }

  oldest() {
    return this.frames.length ? this.frames[0] : null;
  }

  // ---- adaptive delay -----------------------------------------------------

  // Arrival spacing is the only jitter signal a browser has without extra
  // traffic. Delivery should be one tick apart; the spread of the excess over a
  // short window is a robust proxy for how much buffering is needed.
  observeArrival(tick, at) {
    this.arrivals.push({ tick, at });
    if (this.arrivals.length > this.limits.jitterWindow) this.arrivals.shift();
    if (this.arrivals.length < 3) return;

    const excess = [];
    for (let index = 1; index < this.arrivals.length; index += 1) {
      const previous = this.arrivals[index - 1];
      const current = this.arrivals[index];
      const ticks = current.tick - previous.tick;
      if (ticks <= 0) continue;
      excess.push(Math.max(0, (current.at - previous.at) - ticks * this.tickMs));
    }
    if (!excess.length) return;
    excess.sort((a, b) => a - b);
    // Median absolute spread: one slow burst raises it, one early packet does not.
    const median = excess[Math.floor(excess.length / 2)];
    const spread = excess[excess.length - 1] - median;
    this.jitterMs = Math.round(median + spread);
    const target = this.limits.stableDelayMs + this.jitterMs * 1.5;
    this.targetDelayMs = Math.max(this.limits.minDelayMs,
      Math.min(this.limits.maxDelayMs, Math.round(target)));
  }

  // Delay is nudged, never jumped: at most adaptMsPerSecond of change, applied
  // proportionally to the elapsed time. Remote snakes therefore never visibly
  // change speed to "catch up" with a new buffer target.
  adaptDelay(dtMs) {
    if (this.delayMs === this.targetDelayMs) return;
    const step = (this.limits.adaptMsPerSecond * dtMs) / 1000;
    if (this.delayMs < this.targetDelayMs) {
      this.delayMs = Math.min(this.targetDelayMs, this.delayMs + step);
      this.stats.delayRaised += 1;
    } else {
      this.delayMs = Math.max(this.targetDelayMs, this.delayMs - step);
      this.stats.delayLowered += 1;
    }
    this.stats.adaptSteps += 1;
  }

  get delayTicks() {
    return Math.max(1, Math.round(this.delayMs / this.tickMs));
  }

  // ---- playhead -----------------------------------------------------------

  // The playhead is a float tick advanced by the MONOTONIC clock, not by frame
  // arrivals: that is what makes playback smooth when packets are not.
  sample(now = this.clock()) {
    if (!this.enabled) return null;
    const newest = this.newest();
    if (!newest) return null;

    if (this.lastSampleAt === null) {
      this.lastSampleAt = now;
      // Start one delay behind the live edge: that lag IS the jitter buffer.
      this.playhead = newest.tick - this.delayTicks;
    }
    const dt = Math.max(0, now - this.lastSampleAt);
    this.lastSampleAt = now;
    this.adaptDelay(dt);

    this.playhead += dt / this.tickMs;

    const liveTarget = newest.tick - this.delayTicks;
    if (liveTarget - this.playhead > this.limits.maxLagTicks) {
      // Far behind the buffer target: the history we hold is stale, so drop it
      // rather than replaying seconds of old board.
      this.stats.staleDrops += 1;
      this.playhead = liveTarget;
      this.trim();
    } else if (liveTarget - this.playhead > 2) {
      // Mildly behind: converge by playing a little faster (bounded at ~1.6x for
      // that instant only) instead of jumping the remote snakes forward.
      this.playhead += Math.min(liveTarget - this.playhead, dt / this.tickMs * 0.6);
    }

    const oldest = this.oldest();
    if (this.playhead < oldest.tick) this.playhead = oldest.tick;
    if (this.playhead > newest.tick) {
      // Out of confirmed history. STOP at the newest confirmed state; no
      // movement is fabricated to fill the gap.
      this.playhead = newest.tick;
      if (dt > 0) this.stats.underruns += 1;
    }
    this.stats.samples += 1;

    const base = Math.floor(this.playhead);
    const alpha = Math.min(1, Math.max(0, this.playhead - base));
    const older = this.byTick.get(base);
    const newer = this.byTick.get(base + 1);
    const sample = {
      tick: base, nextTick: newer ? base + 1 : null, alpha,
      delayMs: Math.round(this.delayMs), targetDelayMs: this.targetDelayMs,
      buffered: this.frames.length, bufferedTicks: newest.tick - base,
      atLiveEdge: this.playhead >= newest.tick, players: null
    };
    // Interpolation needs BOTH adjacent confirmed ticks. Without the next one the
    // display holds exactly where the server last confirmed it.
    if (!older || !newer) {
      sample.players = older ? older.players : null;
      sample.interpolated = false;
      if (older) this.stats.heldFrames += 1;
      return sample;
    }
    sample.players = this.blend(older, newer, alpha);
    sample.interpolated = true;
    this.stats.interpolatedFrames += 1;
    return sample;
  }

  // Per segment: from where it is in the OLDER frame to where the SAME segment
  // is in the newer frame, in continuous toroidal space. Length differences are
  // handled by clamping to the older body (a growing tail stays put; a vacated
  // tail is simply not drawn).
  blend(older, newer, alpha) {
    const out = new Map();
    for (const [id, next] of newer.players) {
      const before = older.players.get(id);
      if (!before) { out.set(id, next); continue; }
      const cells = [];
      for (let index = 0; index < next.cells.length; index += 1) {
        const to = next.cells[index];
        const from = before.cells[Math.min(index, before.cells.length - 1)];
        if (!Number.isInteger(to) || !Number.isInteger(from)) {
          cells.push({ cell: to, x: to % this.columns, y: Math.floor(to / this.columns), smooth: false });
          continue;
        }
        const delta = this.toroidalDelta(from, to);
        const fx = from % this.columns; const fy = Math.floor(from / this.columns);
        if (!delta) {
          // Not a single-cell move: this segment is not animated at all. Its
          // confirmed position is drawn, which is always a real server cell.
          cells.push({ cell: to, x: to % this.columns, y: Math.floor(to / this.columns), smooth: false });
          continue;
        }
        cells.push({
          cell: to, from, wraps: delta.wraps, smooth: true,
          // Continuous absolute coordinates, possibly outside [0, columns) /
          // [0, rows) for exactly one tick while a snake straddles an edge.
          x: fx + delta.dx * alpha,
          y: fy + delta.dy * alpha
        });
        if (delta.wraps) this.stats.wrapSegments += 1;
      }
      out.set(id, { ...next, smooth: cells });
    }
    return out;
  }

  // Shortest step between two cells on a board whose edges are joined, in whole
  // cells. Anything longer than a single cell is not a movement and is refused
  // (that is what stops a cross-board interpolation).
  toroidalDelta(from, to, columns = this.columns, rows = this.rows) {
    if (!columns || !rows) return null;
    const fx = from % columns; const fy = Math.floor(from / columns);
    const tx = to % columns; const ty = Math.floor(to / columns);
    let dx = tx - fx;
    let dy = ty - fy;
    let wraps = false;
    if (Math.abs(dx) > 1) {
      const wrapped = dx > 0 ? dx - columns : dx + columns;
      if (Math.abs(wrapped) === 1) { dx = wrapped; wraps = true; }
      else return null;
    }
    if (Math.abs(dy) > 1) {
      const wrapped = dy > 0 ? dy - rows : dy + rows;
      if (Math.abs(wrapped) === 1) { dy = wrapped; wraps = true; }
      else return null;
    }
    if (Math.abs(dx) + Math.abs(dy) > 1) return null;
    return { dx, dy, wraps };
  }

  summary() {
    const newest = this.newest();
    const oldest = this.oldest();
    return {
      ...this.stats,
      enabled: this.enabled, reason: this.reason,
      delayMs: Math.round(this.delayMs), targetDelayMs: this.targetDelayMs,
      jitterMs: this.jitterMs, delayTicks: this.delayTicks,
      buffered: this.frames.length, maxBufferTicks: this.limits.maxBufferTicks,
      oldestTick: oldest ? oldest.tick : null, newestTick: newest ? newest.tick : null,
      playheadTick: this.playhead === null ? null : Math.floor(this.playhead),
      // "measured" values come from this browser's own clock; estimates are
      // derived from tick cadence and are labelled as such in diagnostics.
      measured: { delayMs: Math.round(this.delayMs), jitterMs: this.jitterMs, buffered: this.frames.length },
      estimated: { delayTicks: this.delayTicks, targetDelayMs: this.targetDelayMs }
    };
  }
}
