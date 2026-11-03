/*!
 * Responsive Brawl — smooth playback of OTHER players' authoritative movement.
 *
 * The server stays the only source of what other snakes did. This module does
 * not predict a turn. It stores confirmed frames and plays them on the same
 * fixed clock as single-player: one whole cell per tickMs, never when a packet
 * happens to arrive, and never between squares.
 *
 * The clock starts a short delay behind the newest confirmed tick (the adaptive
 * buffer, about one tick on a stable link) and then runs at 1x. A late packet
 * is already in that buffer, so the snake does not hitch. An early packet
 * waits for the clock. The playhead never speeds up to catch a burst and never
 * rewinds. One dropped tick is filled in only when every snake kept going
 * straight and both confirmed heads leave a single possible body. Any turn, or
 * a wider hole, waits for a real snapshot and then takes the next stored cell
 * — it does not freeze, and it does not dump the whole buffer in one paint.
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
const wrap = (value, size) => ((value % size) + size) % size;
const DIRECTIONS = Object.freeze({
  up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0]
});

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
    this.surplusMs = 0;
    this.clockArmed = false;
    this.lastFrameAt = null;
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
      missingTicks: 0, gaps: 0, underruns: 0, resyncs: 0, staleDrops: 0, bridgedGaps: 0,
      delayRaised: 0, delayLowered: 0, adaptSteps: 0, samples: 0, interpolatedFrames: 0,
      steppedFrames: 0, heldFrames: 0, wrapSegments: 0, reconstructed: 0, reconstructRejects: 0
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
      this.clockArmed = false;
    }
    if (Number.isInteger(columns) && columns > 0) this.columns = columns;
    if (Number.isInteger(rows) && rows > 0) this.rows = rows;
  }

  reset(reason = 'reset') {
    this.frames = [];
    this.byTick.clear();
    this.playhead = null;
    this.lastSampleAt = null;
    this.surplusMs = 0;
    this.clockArmed = false;
    this.lastFrameAt = null;
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
    this.accept({
      tick: frame.t, players, food: frame.f, status: frame.s, ts: frame.ts, full: true, raw: frame
    }, at);
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
    if (frame.t <= previous.tick) {
      // A duplicate or late packet is not a gap. Ignore it without resetting a
      // healthy buffer or repeatedly asking the server for another snapshot.
      if (frame.t === previous.tick) this.stats.duplicates += 1;
      else this.stats.outOfOrder += 1;
      return false;
    }
    if (frame.t !== previous.tick + 1) {
      // A hole is not a body we are allowed to invent. Ask for the snapshot
      // that actually contains it. One request, not a reconstructed snake.
      this.noteGap(previous.tick, frame.t);
      this.requestResync(`broken movement chain at tick ${frame.t}`);
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
      const cells = this.reconstructConfirmedBody(entry, before);
      if (!cells) {
        this.stats.reconstructRejects += 1;
        this.requestResync('invalid or missing confirmed movement');
        return false;
      }
      players.set(entry.i, {
        cells, dir: entry.d, len: length, alive: entry.a !== false,
        frozen: !!entry.fr, score: entry.sc,
        // The remaining wire scalars (applied input seq/tick, elimination,
        // connection state, grace deadline) are kept so materialize() can hand
        // the predictor and the HUD a complete frame for this tick.
        raw: entry
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
    if (!newest || frame.tick > newest.tick) {
      if (newest && frame.tick > newest.tick + 1) this.noteGap(newest.tick, frame.tick);
      this.frames.push(frame);
    } else {
      // Late, but still the server's statement for that tick. Discarding it
      // is how ±120 ms of jitter became a permanent hole. Keep tick order.
      this.stats.outOfOrder += 1;
      const index = this.frames.findIndex((entry) => entry.tick > frame.tick);
      if (index < 0) this.frames.push(frame);
      else this.frames.splice(index, 0, frame);
    }
    this.byTick.set(frame.tick, frame);
    this.stats.frames += 1;
    this.lastFrameAt = at;
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

  reconstructConfirmedBody(entry, previous) {
    const columns = this.columns, rows = this.rows;
    const body = previous?.cells;
    const head = entry?.h;
    const length = Number.isInteger(entry?.l) ? entry.l : body?.length;
    if (!Array.isArray(body) || !body.length || !Number.isSafeInteger(head) ||
        !Number.isInteger(columns) || columns < 1 || !Number.isInteger(rows) || rows < 1 ||
        head < 0 || head >= columns * rows || !Number.isInteger(length) ||
        length < body.length || length > body.length + 1) return null;

    const oldHead = body[0];
    if (!Number.isSafeInteger(oldHead) || oldHead < 0 || oldHead >= columns * rows) return null;
    if (entry.fr === true || entry.a === false) {
      return head === oldHead && length === body.length ? body.slice() : null;
    }

    // A live, unfrozen snake moves exactly one orthogonal grid cell per tick,
    // including across an edge. If that is not true, a compact tick is missing:
    // fail closed and request a complete server snapshot rather than inventing a
    // body or animating a jump across the board.
    const dx = Math.abs((head % columns) - (oldHead % columns));
    const dy = Math.abs(Math.floor(head / columns) - Math.floor(oldHead / columns));
    const adjacent = (dy === 0 && (dx === 1 || dx === columns - 1)) ||
                     (dx === 0 && (dy === 1 || dy === rows - 1));
    if (!adjacent) return null;
    return [head, ...body.slice(0, length - 1)];
  }

  // One dropped tick while every snake kept its heading. The cell between the
  // two confirmed heads is the only one a straight step can land on, and the
  // tail after two steps depends only on how many cells were added. When that
  // middle body is unique it is stored too, so the clock can tick through the
  // gap instead of skipping a square. A turn is not unique: return null and
  // the caller asks for a snapshot.
  straightBridge(previous, frame) {
    const entries = frame.p || [];
    if (!entries.length || entries.length !== previous.players.size) return null;
    const currentPlayers = new Map();
    const intermediatePlayers = new Map();
    let canShowMissing = true;
    for (const entry of entries) {
      const before = previous.players.get(entry.i);
      const built = before ? this.straightPair(before, entry) : null;
      if (!built) return null;
      currentPlayers.set(entry.i, built.current);
      if (!built.intermediate) canShowMissing = false;
      else intermediatePlayers.set(entry.i, built.intermediate);
    }
    if (currentPlayers.size !== previous.players.size) return null;
    this.stats.reconstructed += currentPlayers.size * (canShowMissing ? 2 : 1);
    const current = {
      tick: frame.t, players: currentPlayers, food: frame.f,
      status: frame.s, ts: frame.ts, full: false
    };
    const intermediate = canShowMissing ? {
      tick: previous.tick + 1, players: intermediatePlayers, food: previous.food,
      status: previous.status, ts: previous.ts, full: false
    } : null;
    return { intermediate, current };
  }

  straightPair(before, entry) {
    const length = Number.isInteger(entry.l) ? entry.l : null;
    if (!Number.isInteger(length) || length < 1 || !Number.isSafeInteger(entry.h)) return null;
    const sameState = !!entry.fr === !!before.frozen && (entry.a === false) === (before.alive === false);
    if (!sameState || entry.d !== before.dir) return null;
    if (entry.fr === true || entry.a === false) {
      if (entry.h !== before.cells[0] || length !== before.cells.length) return null;
      const player = this.movementPlayer(entry, before.cells.slice());
      return { current: player, intermediate: this.movementPlayer(entry, before.cells.slice()) };
    }
    const delta = length - before.cells.length;
    if (delta < 0 || delta > 2) return null;
    const mid = this.stepCell(before.cells[0], before.dir);
    const head = mid === null ? null : this.stepCell(mid, before.dir);
    if (head !== entry.h) return null;
    if (delta === 0 || delta === 2) {
      const grew = delta === 2;
      const midCells = this.stepBody(before.cells, mid, grew);
      const finalCells = midCells && this.stepBody(midCells, head, grew);
      if (!finalCells || finalCells.length !== length || finalCells[0] !== head) return null;
      return {
        current: this.movementPlayer(entry, finalCells),
        intermediate: this.movementPlayer(entry, midCells, before.dir)
      };
    }
    const finalCells = [head, mid, ...before.cells].slice(0, length);
    if (finalCells.length !== length || finalCells[0] !== head) return null;
    // One eat across the two ticks: the final body is fixed, the middle tail
    // is not. Leave the hole so the clock shows this confirmed body instead
    // of a tail we would have to invent.
    return { current: this.movementPlayer(entry, finalCells), intermediate: null };
  }

  movementPlayer(entry, cells, direction = entry.d) {
    return {
      cells, dir: direction, len: cells.length, alive: entry.a !== false,
      frozen: !!entry.fr, score: entry.sc, raw: entry
    };
  }

  stepCell(index, direction) {
    const delta = DIRECTIONS[direction];
    if (!delta || !Number.isSafeInteger(index)) return null;
    const x = wrap((index % this.columns) + delta[0], this.columns);
    const y = wrap(Math.floor(index / this.columns) + delta[1], this.rows);
    return y * this.columns + x;
  }

  stepBody(cells, newHead, grew) {
    if (!Array.isArray(cells) || !cells.length || !Number.isSafeInteger(newHead)) return null;
    const next = [newHead, ...cells];
    if (!grew) next.pop();
    return next;
  }

  // Turns the newest RECONSTRUCTED tick back into a complete, Protocol-v1
  // shaped snapshot. The bodies are the ones pushMovement rebuilt (lossless, as
  // the Rails movement_protocol_test proves), the per-player scalars are the
  // movement frame's own, and the fields a compact frame does not carry (names,
  // colours, standings, board, rules) are carried forward from `previous`, the
  // last complete frame the renderer holds. Survival and frozen-tick counters
  // advance once per tick this frame covers (two when a straight dropped tick
  // was rebuilt with it).
  //
  // This is what lets local prediction reconcile on EVERY tick in Responsive
  // Brawl instead of only on the periodic complete snapshot: without it the own
  // snake ran to its lead ceiling, stalled, and jumped at every full frame.
  materialize(frame, previous) {
    const stored = this.newest();
    if (!stored || !frame || stored.tick !== frame.t || !previous || !Array.isArray(previous.p)) return null;
    const byId = new Map(previous.p.map((player) => [player.i, player]));
    const players = [];
    for (const entry of frame.p || []) {
      const rebuilt = stored.players.get(entry.i);
      const meta = byId.get(entry.i);
      if (!rebuilt || !meta) return null;
      const alive = entry.a !== false;
      const frozen = entry.fr === true;
      // A bridged frame covers the dropped tick too. Survival and freeze
      // counters step once per confirmed tick, so a one-tick hole adds two.
      const passed = frame.t === previous.t + 2 ? 2 : 1;
      players.push({
        ...meta,
        ...entry,
        b: rebuilt.cells.slice(),
        l: rebuilt.cells.length,
        a: alive,
        fr: frozen,
        sv: (Number.isInteger(meta.sv) ? meta.sv : 0) + (alive && !frozen && meta.a !== false ? passed : 0),
        lg: Math.max(Number.isInteger(meta.lg) ? meta.lg : 0, rebuilt.cells.length),
        fz: (Number.isInteger(meta.fz) ? meta.fz : 0) + (alive && frozen ? passed : 0)
      });
      // A compact frame has no `h` in a snapshot; drop the movement-only key.
      delete players[players.length - 1].h;
    }
    const scores = new Map(players.map((player) => [player.i, player.sc]));
    return {
      ...previous,
      type: 'snapshot',
      reconstructed: true,
      m: frame.m ?? previous.m,
      s: frame.s ?? previous.s,
      t: frame.t,
      ts: Number.isFinite(frame.ts) ? frame.ts : previous.ts,
      b: { c: this.columns, r: this.rows },
      f: Array.isArray(frame.f) ? frame.f : previous.f,
      p: players,
      // Placements change only with eliminations, which the server always sends
      // as a complete frame; scores are authoritative in the movement frame.
      q: Array.isArray(previous.q)
        ? previous.q.map((entry) => (scores.has(entry.i) ? { ...entry, sc: scores.get(entry.i) } : entry))
        : previous.q
    };
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
    // One confirmed tick of render delay. Not an adaptive cushion: a cushion
    // that only grows is how snakes drifted further apart the longer you played.
    return 1;
  }

  // ---- playhead -----------------------------------------------------------

  // Whole confirmed cells. The target is newest.tick - 1 on every sample.
  // Elapsed time moves the playhead toward that target and is kept, so a late
  // frame or a catch-up burst is spent instead of becoming a permanent offset.
  // Nothing is drawn between squares, and a missing tick is the next stored
  // cell rather than an invented body.
  sample(now = this.clock()) {
    if (!this.enabled) return null;
    const newest = this.newest();
    if (!newest) return null;
    const oldest = this.oldest();
    const target = Math.max(oldest.tick, newest.tick - this.delayTicks);

    if (this.playhead === null || this.lastSampleAt === null) {
      this.playhead = target;
      this.lastSampleAt = now;
      this.surplusMs = 0;
      this.clockArmed = true;
    } else {
      const dt = Math.max(0, now - this.lastSampleAt);
      this.lastSampleAt = now;
      this.surplusMs += dt;
      let steps = 0;
      while (this.surplusMs >= this.tickMs && this.playhead < target && steps < 2) {
        this.surplusMs -= this.tickMs;
        this.playhead += 1;
        steps += 1;
      }
      if (this.playhead > target) this.playhead = target;
      if (this.playhead >= target && this.surplusMs > this.tickMs) this.surplusMs = this.tickMs;
    }
    if (this.playhead < oldest.tick) this.playhead = oldest.tick;

    if (!this.byTick.has(this.playhead)) {
      const floorTick = this.playhead;
      const nextStored = this.frames.find((frame) => frame.tick >= floorTick && frame.tick <= newest.tick);
      if (nextStored) {
        this.playhead = nextStored.tick;
        this.stats.heldFrames += 1;
      }
    }

    this.stats.samples += 1;
    const base = this.playhead;
    const older = this.byTick.get(base);
    const sample = {
      tick: older ? older.tick : base, nextTick: null, alpha: 0,
      delayMs: this.delayTicks * this.tickMs, targetDelayMs: this.delayTicks * this.tickMs,
      buffered: this.frames.length, bufferedTicks: Math.max(0, newest.tick - base),
      atLiveEdge: base >= newest.tick, players: null, interpolated: false, frame: null
    };
    if (!older) {
      sample.food = null;
      return sample;
    }
    sample.food = Array.isArray(older.food) ? older.food : null;
    sample.players = older.players;
    sample.frame = older.raw || null;
    sample.tick = older.tick;
    this.stats.steppedFrames += 1;
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
          // Continuous coordinates, possibly just outside the board for the
          // one tick a snake straddles an edge. The canvas draws both sides.
          x: fx + delta.dx * alpha,
          y: fy + delta.dy * alpha
        });
        if (delta.wraps) this.stats.wrapSegments += 1;
      }
      out.set(id, { ...next, smooth: cells });
    }
    // A player present only in the older frame (just eliminated from the
    // compact set) keeps the last confirmed body. Never drop them mid-segment.
    for (const [id, before] of older.players) {
      if (!out.has(id)) out.set(id, before);
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
