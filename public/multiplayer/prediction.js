/*!
 * Responsive Brawl — local movement prediction and server reconciliation.
 *
 * WHAT THIS IS: a small, deterministic replay of the ONE part of the server
 * rules that concerns the player's OWN snake: fixed logical ticks, a queued
 * turn, one cell of movement with edge wrapping, tail vacating vs growing, and
 * eating the food the server already told us about. It is written against
 * Simulation::World#step! / Simulation::Snake (rails/app/lib/simulation), not
 * against public/game.js, because the multiplayer authority is the Ruby engine.
 *
 * WHAT THIS IS NOT: it never decides anything official. The server alone owns
 * accepted turns for OTHER snakes, food spawning, points, collisions,
 * eliminations, placements and results. This module cannot express them:
 * there is no score setter, no elimination setter, no way to name another
 * player, and no inbound field is ever read as an instruction. Clients keep
 * sending only { v, type, match, tick, seq, dir } through the unchanged
 * Protocol v1 input envelope, and Simulation::Protocol::FORBIDDEN_INPUT_KEYS
 * still rejects any attempt to assert a position, body or score.
 *
 * So the split of responsibilities is:
 *   own snake, next few ticks  -> predicted here so a key press feels instant
 *   everything else, forever     -> whatever the authoritative snapshot says
 *
 * Reconciliation follows the fields prepared in Step 1: the frame tick "t" is
 * the confirmed state version, "is"/"it" per player say which input SEQUENCE
 * the simulation consumed and at which tick, and the socket's "input_ack" only
 * ever means QUEUED — never applied. An input_applied / input_rejected event or
 * a newer frame is the only thing that can retire a pending prediction.
 */

const DIRECTIONS = Object.freeze({
  up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0]
});

// Bounded by design. Prediction is a latency hide-and-seek game, not a second
// simulation of the match: the further ahead it runs, the more a correction can
// hurt. These ceilings are the whole policy, and every time one of them stops a
// tick it is counted so Movement diagnostics can show it.
export const PREDICTION_LIMITS = Object.freeze({
  // How many ticks the local view may run ahead of the last CONFIRMED tick.
  // At the fastest server speed (40 ms) that is ~240 ms ≈ two round trips of
  // a bad tunnel; beyond it the snake simply waits for the server instead of
  // inventing a path through a board nobody has validated.
  maxLeadTicks: 6,
  // A turn is only worth predicting if the server can plausibly still act on
  // it inside its own input window (Match#INPUT_FUTURE_WINDOW) — anything
  // further out is refused locally rather than queued into a guaranteed
  // correction. The durable queue accepts more; predicting more would not.
  maxHorizonTicks: 8,
  // Unconfirmed turns held for future ticks. The server's own direction queue
  // is 4 (Rules::BRAWL_QUEUE), so 8 is already generous.
  maxPendingInputs: 8,
  // Ticks executed in one advance() call. Mirrors Config::MAX_CATCHUP_TICKS: a
  // backgrounded tab must not burst-rewind the board when it wakes up.
  maxCatchupTicks: 5
});

// Steps 1/2 keep Responsive unreachable for ordinary players: the server will
// not start a Responsive match until Step 3. Prediction is therefore armed for
// real only by a server-confirmed strategy, plus ONE explicit, tab-local test
// override so the code path can be exercised (and measured) today.
export const RESPONSIVE_TEST_OVERRIDE = 'next-level-snake:responsive-prediction-test';

export function responsivePredictionEnabled({ strategy, search = '', storage = null } = {}) {
  if (strategy === 'responsive') return { active: true, source: 'server', testOnly: false };
  const armed = /(?:^|[?&])responsivePrediction=test(?:&|$)/.test(search) ||
    storage?.getItem?.(RESPONSIVE_TEST_OVERRIDE) === '1';
  // The URL flag is consumed once and remembered for the tab only: it can never
  // leak into a shared link that changes somebody else's game silently, and a
  // reload of a plain URL turns it back off.
  if (armed && /(?:^|[?&])responsivePrediction=test(?:&|$)/.test(search)) storage?.setItem?.(RESPONSIVE_TEST_OVERRIDE, '1');
  else if (!/responsivePrediction/.test(search) && storage?.getItem?.(RESPONSIVE_TEST_OVERRIDE) !== '1') {
    return { active: false, source: 'off', testOnly: false };
  }
  return armed || storage?.getItem?.(RESPONSIVE_TEST_OVERRIDE) === '1'
    ? { active: true, source: 'test', testOnly: true }
    : { active: false, source: 'off', testOnly: false };
}

const wrap = (value, size) => ((value % size) + size) % size;
const cellIndex = (x, y, columns) => y * columns + x;
const sameDir = (a, b) => !!a && !!b && a === b;
const reverseOf = (a, b) => !!a && !!b &&
  DIRECTIONS[a][0] === -DIRECTIONS[b][0] && DIRECTIONS[a][1] === -DIRECTIONS[b][1];

function normaliseBody(cells, columns) {
  if (!Array.isArray(cells) || !cells.length || !Number.isInteger(columns) || columns < 1) return null;
  const body = [];
  for (const cell of cells) {
    const index = Number.isInteger(cell) ? cell : cellIndex(cell[0], cell[1], columns);
    if (!Number.isInteger(index) || index < 0) return null;
    body.push([index % columns, Math.floor(index / columns)]);
  }
  return body;
}

function emptyStats() {
  return {
    predictedTicks: 0, submitted: 0, refused: 0, lateRescheduled: 0, droppedPending: 0,
    horizonRefusals: 0, leadStalls: 0, catchupDiscards: 0,
    queuedAcks: 0, appliedAcks: 0, rejectedAcks: 0, foreignApplied: 0,
    reconciliations: 0, corrections: 0, maxCorrectionCells: 0, snapped: 0,
    staleFrames: 0, duplicateFrames: 0, rejectedFrames: 0,
    predictedFood: 0, predictedGrowths: 0, blockedTurns: 0, frozenPauses: 0,
    retiredByFrame: 0,
    resetForReconnect: 0, resetForState: 0
  };
}

export class LocalPredictor {
  constructor(options = {}) {
    this.limits = { ...PREDICTION_LIMITS, ...(options.limits || {}) };
    this.clock = options.clock || (() => performance.now());
    this.onEvent = options.onEvent || null;
    this.tickMs = Number.isFinite(options.tickMs) && options.tickMs > 0 ? options.tickMs : 105;
    this.columns = Number.isInteger(options.columns) ? options.columns : 24;
    this.rows = Number.isInteger(options.rows) ? options.rows : 18;
    this.growth = Number.isInteger(options.growth) && options.growth >= 0 ? options.growth : 1;
    this.mode = options.mode === 'duel' ? 'duel' : 'brawl';
    // Rules::BRAWL_QUEUE / DUEL_QUEUE — the buffer depth is a mode rule, and a
    // mobile swipe burst must not be trimmed locally before the server saw it.
    this.maxQueuedDirections = Number.isInteger(options.maxQueuedDirections) ?
      options.maxQueuedDirections : (this.mode === 'brawl' ? 4 : 2);
    this.ownParticipantId = options.ownParticipantId ?? null;
    this.enabled = false;
    this.reason = null;
    this.stats = emptyStats();
    this.confirmed = null;
    this.predicted = null;
    this.pending = [];
    this.highestSeq = 0;
    this.lastRunAt = null;
    this.replaying = false;
    this.food = null;
    this.diagnostic = null;
    // What the local view asserted about each tick, kept so reconciliation can
    // answer the only question that matters — "was the prediction right about
    // the tick the server just confirmed?" — instead of comparing a position
    // three ticks ahead against a position now.
    this.predictedHeads = new Map();
  }

  // ---- configuration ------------------------------------------------------

  configure({ tickMs, columns, rows, growth, mode, maxQueuedDirections, ownParticipantId }) {
    let changed = false;
    const num = (value, current, positive = true) => {
      const next = positive ? (Number.isFinite(value) && value > 0 ? value : current)
        : (Number.isInteger(value) && value >= 0 ? value : current);
      if (next !== current) changed = true;
      return next;
    };
    this.tickMs = num(tickMs, this.tickMs);
    this.columns = num(columns, this.columns, false);
    this.rows = num(rows, this.rows, false);
    this.growth = num(growth, this.growth, false);
    if (mode === 'duel' || mode === 'brawl') {
      if (mode !== this.mode) changed = true;
      this.mode = mode;
    }
    if (Number.isInteger(maxQueuedDirections) && maxQueuedDirections > 0) this.maxQueuedDirections = maxQueuedDirections;
    if (ownParticipantId !== undefined) this.ownParticipantId = ownParticipantId;
    if (changed) this.disable('configuration changed');
    return changed;
  }

  enable(reason = 'responsive') {
    if (this.enabled) return false;
    this.enabled = true;
    this.reason = reason;
    this.stats = emptyStats();
    this.pending = [];
    return true;
  }

  disable(reason = 'classic') {
    const was = this.enabled;
    this.enabled = false;
    this.reason = reason;
    if (was) { this.confirmed = null; this.predicted = null; this.pending = []; this.food = null; }
    return was;
  }

  // Classic Brawl never touches this object: the renderer and the input path ask
  // `active` first, so the shipped behaviour is exactly the Step-10 code.
  get active() {
    return this.enabled && !!this.predicted && !!this.confirmed &&
      this.confirmed.status === 'running' && this.confirmed.alive !== false &&
      this.confirmed.frozen !== true;
  }

  reset(reason = 'reset', { reconnect = false } = {}) {
    this.predicted = null;
    this.pending = [];
    this.predictedHeads = new Map();
    this.food = null;
    this.lastRunAt = null;
    if (reconnect) this.stats.resetForReconnect += 1;
    else this.stats.resetForState += 1;
    this.emit({ type: 'reset', reason });
    return false;
  }

  emit(event) { this.onEvent?.(event); }

  // ---- authoritative input -------------------------------------------------

  // Feeds one player entry out of a snapshot. Returns whether prediction may
  // continue; a non-applicable frame (stale/duplicate/foreign) is ignored here
  // and counted, never applied.
  observe(snapshot, { stale = false, duplicate = false, applied = true } = {}) {
    if (!this.enabled) return false;
    if (applied === false || !snapshot || !Array.isArray(snapshot.p)) {
      this.stats.rejectedFrames += 1;
      return false;
    }
    const columns = snapshot.b?.c; const rows = snapshot.b?.r;
    if (!Number.isInteger(columns) || !Number.isInteger(rows)) { this.stats.rejectedFrames += 1; return false; }
    if (columns !== this.columns || rows !== this.rows) { this.columns = columns; this.rows = rows; }
    if (Number.isInteger(snapshot.tick_ms)) this.tickMs = snapshot.tick_ms;
    if (snapshot.r === 'duel' || snapshot.r === 'brawl') this.mode = snapshot.r;
    if (this.ownParticipantId === null || this.ownParticipantId === undefined) { this.stats.rejectedFrames += 1; return false; }

    const player = snapshot.p.find((entry) => Number(entry.i) === Number(this.ownParticipantId));
    if (!player) { this.reset('not a participant'); return false; }

    if (duplicate) { this.stats.duplicateFrames += 1; return !!this.predicted; }
    if (stale) { this.stats.staleFrames += 1; return !!this.predicted; }
    // A tick never moves backwards. Frames for a pending/paused/completed match
    // are still adopted (they own the truth about liveness) but only a running
    // match may be predicted ahead of.
    if (this.confirmed && Number.isInteger(snapshot.t) && snapshot.t < this.confirmed.tick) {
      this.stats.staleFrames += 1;
      return !!this.predicted;
    }

    const body = normaliseBody(player.b, columns);
    if (!body) { this.reset('unreadable body'); return false; }
    const tick = Number.isInteger(snapshot.t) ? snapshot.t : this.confirmed?.tick ?? 0;
    const appliedSeq = Number.isInteger(player.is) ? player.is : 0;
    // How far ahead of the OLD confirmed version the local view had run. It is
    // kept, not discarded: reconciliation re-anchors the state at the confirmed
    // tick and then replays exactly that distance forward. Snapping the local
    // clock back to the server's would add one full delivery delay of latency to
    // every single frame — the opposite of why this module exists — and it would
    // make a turn feel slower the further out the player already was.
    const ahead = this.predicted && this.confirmed ?
      Math.max(0, Math.min(this.limits.maxLeadTicks, this.predicted.tick - this.confirmed.tick)) : 0;

    this.stats.reconciliations += 1;
    // 1. Retire everything the simulation has already consumed or refused. This
    //    is the only place a pending prediction may be discarded as "applied".
    this.trim(appliedSeq);
    // 2. Adopt the confirmed state verbatim.
    this.confirmed = {
      tick, body, direction: player.d, queue: Array.isArray(player.q) ? player.q.slice() : [],
      alive: player.a !== false, frozen: !!player.fr, status: snapshot.s, score: player.sc,
      length: Number.isInteger(player.l) ? player.l : body.length, appliedSeq,
      appliedTick: Number.isInteger(player.it) ? player.it : null,
      growthRemaining: Number.isInteger(player.gr) ? player.gr : null
    };
    // 3. Correct the local view, then rebuild it from the confirmed state. A
    //    correction is a fact, not something to animate away.
    // A correction is a disagreement about a tick the server has ALREADY
    // confirmed. Measured against the confirmed head at that exact tick, not
    // against wherever the local view happens to be, so a healthy lead is never
    // miscounted as rubber-banding (and a real one can never be hidden by it).
    const wasPredicted = this.predictedHeads.get(tick);
    const authorityHead = body.length ? cellIndex(body[0][0], body[0][1], columns) : null;
    const correction = wasPredicted === undefined || authorityHead === null ? 0 :
      this.correctionDistance([wasPredicted], authorityHead);
    if (correction > 0) {
      this.stats.corrections += 1;
      this.stats.maxCorrectionCells = Math.max(this.stats.maxCorrectionCells, correction);
    }
    if (correction > this.limits.maxLeadTicks) this.stats.snapped += 1;
    this.rebuild();
    // 4. Re-apply only the turns the server has not consumed yet, at ticks that
    //    are strictly in the future relative to the confirmed state. Confirmed
    //    server ticks are never rewritten.
    this.reschedulePending();
    this.replayAhead(ahead);
    this.food = this.foodFor(player, snapshot);
    this.emit({ type: 'reconciled', tick, correction, pending: this.pending.length });
    return this.active;
  }

  // The only food the predictor knows is the food the server already published
  // for this player. It never invents or relocates a cell.
  foodFor(player, snapshot) {
    const entry = (snapshot.f || []).find((food) => Number(food.o) === Number(this.ownParticipantId));
    const index = entry ? entry.c : (Number.isInteger(player.fc) ? player.fc : null);
    return Number.isInteger(index) ? index : null;
  }

  // input_ack: the frame is QUEUED at the server. Nothing may be retired here.
  noteQueued(seq) {
    if (!Number.isInteger(seq)) return false;
    this.stats.queuedAcks += 1;
    const found = this.pending.find((entry) => entry.seq === seq);
    if (found) found.status = 'queued';
    return !!found;
  }

  // input_applied: the authoritative simulation consumed this envelope at tick
  // `tick`. It is now server state, so it leaves the local buffer.
  noteApplied(seq, tick) {
    if (!Number.isInteger(seq)) return false;
    this.stats.appliedAcks += 1;
    const before = this.pending.length;
    this.pending = this.pending.filter((entry) => entry.seq > seq);
    if (this.confirmed) this.confirmed.appliedSeq = Math.max(this.confirmed.appliedSeq, seq);
    if (Number.isInteger(tick) && this.confirmed) {
      this.confirmed.appliedTick = Math.max(this.confirmed.appliedTick ?? 0, tick);
    }
    return before !== this.pending.length;
  }

  // input_rejected / a rejected ack: the server will never move this snake for
  // that envelope, so the local prediction of it is withdrawn immediately.
  noteRejected(seq, reason = null) {
    if (!Number.isInteger(seq)) return false;
    this.stats.rejectedAcks += 1;
    const before = this.pending.length;
    this.pending = this.pending.filter((entry) => entry.seq !== seq);
    this.rebuild();
    this.reschedulePending();
    this.emit({ type: 'input_rejected', seq, reason });
    return before !== this.pending.length;
  }

  // Another tab (or another burst we did not author) advanced the server-side
  // sequence mirror: our buffer must not fight it.
  noteSequenceMirror(lastInputSeq) {
    if (!Number.isInteger(lastInputSeq) || lastInputSeq <= 0) return false;
    if (lastInputSeq <= this.highestSeq) return false;
    this.highestSeq = lastInputSeq;
    this.stats.foreignApplied += 1;
    this.trim(lastInputSeq);
    this.rebuild();
    this.reschedulePending();
    return true;
  }

  trim(appliedSeq) {
    if (!Number.isInteger(appliedSeq) || appliedSeq <= 0) return;
    const before = this.pending.length;
    this.pending = this.pending.filter((entry) => entry.seq > appliedSeq);
    // Counted separately from the explicit input_applied event: the frame is the
    // authority, the event is the courtesy notice.
    this.stats.retiredByFrame += Math.max(0, before - this.pending.length);
  }

  // ---- local input ---------------------------------------------------------

  // Returns the local decision only. Sending is the caller's job and is never
  // gated on this: an input the predictor refuses still goes to the server,
  // because the server is the authority on the turn, not on the pixels.
  submit(direction, seq) {
    const record = {
      seq: Number.isInteger(seq) ? seq : null, direction: null, intendedTick: null,
      scheduledTick: null, status: 'local', rejectedReason: null,
      appliedLocallyAt: null, consumed: false
    };
    if (!DIRECTIONS[direction]) { record.rejectedReason = 'unknown_direction'; this.stats.refused += 1; return record; }
    if (this.recordSeq(record.seq) === false) { record.rejectedReason = 'bad_sequence'; this.stats.refused += 1; return record; }
    if (!this.active) { record.rejectedReason = 'unavailable'; return record; }

    const reference = this.predicted.queue.length
      ? this.predicted.queue[this.predicted.queue.length - 1] : this.predicted.direction;
    // Mirror Snake#queue_direction: the same rules, so a locally refused turn is
    // a turn the server will refuse too. It is still sent (see above) because a
    // duplicate/reversal is what a real key burst looks like.
    if (sameDir(direction, reference)) { record.rejectedReason = 'duplicate_direction'; this.stats.refused += 1; return record; }
    if (reverseOf(direction, reference)) { record.rejectedReason = 'reversal'; this.stats.refused += 1; return record; }
    if (this.predicted.queue.length >= this.maxQueuedDirections) {
      record.rejectedReason = 'queue_full'; this.stats.refused += 1; return record;
    }

    const confirmedTick = this.confirmed.tick;
    const intended = Math.max(this.predicted.tick, confirmedTick) + 1;
    if (intended > confirmedTick + this.limits.maxHorizonTicks) {
      // Explicit bounded scheduling policy: an input whose intended tick can no
      // longer be reached honestly is refused locally instead of being pasted
      // into a confirmed tick. The server still gets the packet and decides.
      record.rejectedReason = 'horizon_exceeded';
      this.stats.horizonRefusals += 1;
      this.stats.refused += 1;
      return record;
    }
    if (intended > this.predicted.tick + 1) this.stats.lateRescheduled += 1;

    record.direction = direction;
    record.intendedTick = intended;
    record.scheduledTick = intended;
    this.predicted.queue.push(direction);
    // Exactly one intake: the queue above IS the prediction. A second, event
    // driven intake existed here before and could re-derive a turn the ticks had
    // already consumed, which steered the local snake through a corner the
    // server never confirmed. One owner, no double turns.
    record.status = 'queued';
    this.pending.push(record);
    this.stats.submitted += 1;
    if (this.pending.length > this.limits.maxPendingInputs) {
      // Oldest first: a stale turn that never reached the server must not block
      // the one the player just pressed.
      const dropped = this.pending.shift();
      dropped.rejectedReason = dropped.rejectedReason || 'pending_overflow';
      this.stats.droppedPending += 1;
      this.rebuild();
      this.reschedulePending();
    }
    this.emit({ type: 'predicted', seq: record.seq, direction, tick: intended });
    return record;
  }

  recordSeq(seq) {
    if (!Number.isInteger(seq) || seq <= 0) return false;
    if (seq <= this.highestSeq) return false;
    this.highestSeq = seq;
    return true;
  }

  // ---- fixed-step simulation ------------------------------------------------

  // Monotonic, fixed-step and independent of rAF: the caller may run this from a
  // timer or from the draw callback, the tick boundaries are identical either
  // way because they come from elapsed time, not from frame count.
  advance(now = this.clock()) {
    if (!this.active) {
      // Frozen, eliminated, pending, paused or finished: the server owns that
      // state and the local view simply stops. No predicted tick is ever run
      // through an authoritative freeze, and no death is ever painted early.
      if (this.enabled && this.confirmed && (this.confirmed.frozen || this.confirmed.alive === false)) {
        this.stats.frozenPauses += 1;
      }
      this.lastRunAt = now;
      return 0;
    }
    if (this.lastRunAt === null) { this.lastRunAt = now; return 0; }
    let elapsed = now - this.lastRunAt;
    if (!Number.isFinite(elapsed) || elapsed <= 0) return 0;
    const cap = this.tickMs * this.limits.maxCatchupTicks;
    if (elapsed > cap) {
      this.stats.catchupDiscards += Math.floor((elapsed - cap) / this.tickMs);
      elapsed = cap;
    }
    this.lastRunAt = now - (elapsed % this.tickMs);
    let ticks = 0;
    while (elapsed >= this.tickMs && ticks < this.limits.maxCatchupTicks) {
      elapsed -= this.tickMs;
      if (!this.runTick()) break;
      ticks += 1;
    }
    return ticks;
  }

  // Re-simulates the local view back out to where it was, from confirmed state.
  // Bounded by the same ceiling as normal play, so a long outage cannot make the
  // replay expensive.
  replayAhead(ticks) {
    if (!this.predicted || !ticks) return 0;
    this.replaying = true;
    let run = 0;
    try {
      while (run < ticks && run < this.limits.maxLeadTicks && this.predicted.tick <
             this.confirmed.tick + this.limits.maxLeadTicks) {
        if (!this.runTick()) break;
        run += 1;
      }
    } finally {
      this.replaying = false;
    }
    return run;
  }

  runTick() {
    if (!this.active) return false;
    // `replaying` re-derives ticks the client already painted, so the ceiling is
    // checked by the caller instead of stopping the replay at the old baseline.
    if (!this.replaying && this.predicted.tick - this.confirmed.tick >= this.limits.maxLeadTicks) {
      // Outage ceiling reached: the snake waits for a confirmed frame rather
      // than drawing an ever longer fictional path. Counted, never hidden.
      this.stats.leadStalls += 1;
      return false;
    }
    const tick = this.predicted.tick + 1;
    const state = this.predicted;
    // Snake#next_direction!: the neck direction is the final authority, so a
    // reversal that somehow got buffered cannot turn the snake around.
    let direction = state.direction;
    const candidate = state.queue.shift();
    if (candidate) {
      if (reverseOf(candidate, direction)) this.stats.blockedTurns += 1;
      else direction = candidate;
      // Remember which envelope this tick consumed. Reconciliation needs it to
      // tell "a turn still owed" apart from "a turn already spent locally and now
      // baked into the confirmed state" — re-playing the latter is how a
      // reconciler starts inventing extra corners.
      const spent = this.pending.find((entry) => entry.appliedLocallyAt === null &&
        entry.direction === candidate);
      if (spent) { spent.appliedLocallyAt = tick; spent.status = 'predicted'; }
    }
    const [dx, dy] = DIRECTIONS[direction];
    // Bodies are held as flat cell indexes, exactly like the wire format, so the
    // frame handed to the canvas needs no conversion. Decode to step.
    const head = state.body[0];
    const target = [wrap((head % this.columns) + dx, this.columns),
                    wrap(Math.floor(head / this.columns) + dy, this.rows)];

    // Brawl is non-solid: only a self-collision can end this snake, and that
    // rule is locally deterministic (the tail vacates unless growing). Duel
    // bodies and head-ons are NOT predictable, so nothing is assumed there.
    if (this.mode === 'brawl' && this.hitsSelf(state, target)) {
      this.remember(tick, state.body[0]);
      // The predicted head stops at the wall. The server declares the death; the
      // renderer never invents an elimination, a score freeze or a placement.
      this.stats.blockedTurns += 1;
      state.blocked = 'self_collision';
      state.direction = direction;
      state.tick = tick;
      this.predicted.tick = tick;
      if (!this.replaying) this.stats.predictedTicks += 1;
      return true;
    }

    state.direction = direction;
    state.body.unshift(target[1] * this.columns + target[0]);
    if (state.grow > 0) state.grow -= 1;
    else state.body.pop();
    state.length = state.body.length;
    state.tick = tick;
    this.predicted.tick = tick;
    if (!this.replaying) this.stats.predictedTicks += 1;
    this.remember(tick, state.body[0]);

    if (this.food !== null && state.body[0] === this.food) {
      // Known food only: growth may be predicted, the respawn cell and the
      // official score may not, so both stay exactly as the server said.
      this.stats.predictedFood += 1;
      this.stats.predictedGrowths += 1;
      state.grow += this.growth;
      for (let index = 0; index < this.growth; index += 1) state.body.push(state.body[state.body.length - 1]);
      state.length = state.body.length;
      this.food = null;
    }
    return true;
  }

  // Every tick the local view paints is recorded as a claim, including one
  // re-derived by a replay: the audit asks "was what you showed right?", and
  // that includes a tick you had to reconstruct.
  remember(tick, head) {
    this.predictedHeads.set(tick, head);
    if (this.confirmed) {
      for (const key of this.predictedHeads.keys()) {
        if (key < this.confirmed.tick - this.limits.maxLeadTicks) this.predictedHeads.delete(key);
      }
    }
  }

  hitsSelf(state, target) {
    const index = cellIndex(target[0], target[1], this.columns);
    // Snake#surviving_cells: while growing the tail stays, so it still blocks.
    const blocking = state.grow > 0 ? state.body.slice() : state.body.slice(0, -1);
    return blocking.includes(index);
  }

  rebuild() {
    if (!this.confirmed) { this.predicted = null; return; }
    this.predicted = {
      tick: this.confirmed.tick,
      body: this.confirmed.body.map((cell) => cellIndex(cell[0], cell[1], this.columns)),
      direction: this.confirmed.direction,
      queue: [],
      grow: 0,
      length: this.confirmed.length,
      blocked: null
    };
  }

  // Outstanding turns are replayed forward from the confirmed state. Anything
  // whose tick is already confirmed is dropped: confirmed server ticks are
  // immutable, and silently re-adding a turn the server skipped would just
  // manufacture the next correction.
  // Replay the outstanding turns in sequence order, one per tick boundary.
  // That is precisely what the server's own queue does with them (Rules::
  // BRAWL_QUEUE depth, Snake#next_direction! consuming one per step), so the
  // local view converges instead of racing ahead. Anything the confirmed frame
  // already consumed is gone; more turns than the horizon can carry are refused
  // rather than pasted into a confirmed tick.
  reschedulePending() {
    if (!this.predicted || !this.confirmed) return;
    const horizon = this.confirmed.tick + this.limits.maxHorizonTicks;
    const keep = [];
    this.predicted.queue = [];
    for (const entry of this.pending) {
      if (keep.length >= this.maxQueuedDirections) {
        this.stats.droppedPending += 1;
        continue;
      }
      // Already consumed by a local tick at or before the confirmed tick: the
      // state just adopted already contains it. Re-queueing it would steer the
      // snake through a corner the server has now confirmed as history.
      if (entry.appliedLocallyAt !== null && entry.appliedLocallyAt <= this.confirmed.tick) {
        entry.status = 'spent';
        continue;
      }
      entry.appliedLocallyAt = null;
      const target = this.confirmed.tick + keep.length + 1;
      if (target > horizon) {
        this.stats.horizonRefusals += 1;
        continue;
      }
      entry.scheduledTick = target;
      entry.consumed = keep.length > 0; // consumed by the FIRST predicted tick
      entry.status = 'pending';
      keep.push(entry);
      this.predicted.queue.push(entry.direction);
    }
    this.pending = keep;
  }

  correctionDistance(predictedBody, authoritativeBody) {
    if (!Array.isArray(predictedBody) || !predictedBody.length) return 0;
    const a = predictedBody[0];
    const b = Number.isInteger(authoritativeBody) ? authoritativeBody : null;
    if (b === null || a === b) return 0;
    const ax = a % this.columns; const ay = Math.floor(a / this.columns);
    const bx = b % this.columns; const by = Math.floor(b / this.columns);
    const dx = Math.min(Math.abs(ax - bx), this.columns - Math.abs(ax - bx));
    const dy = Math.min(Math.abs(ay - by), this.rows - Math.abs(ay - by));
    return dx + dy;
  }

  // ---- rendering -------------------------------------------------------------

  // Returns the frame the canvas should PAINT. Only this player's cells,
  // direction and length are replaced, and only while prediction is active;
  // remote snakes, food, scoreboard, freeze rings, dust and results are read
  // from the authoritative frame exactly as before, so Classic and every other
  // theme/caching path is byte-for-byte the old renderer.
  displayFrame(frame) {
    if (!this.active || !frame || !Array.isArray(frame.p)) return frame;
    const cells = this.predicted.body;
    const players = frame.p.map((player) => {
      if (Number(player.i) !== Number(this.ownParticipantId)) return player;
      return {
        ...player,
        b: cells,
        d: this.predicted.direction,
        l: cells.length,
        // Marked so the canvas and any reviewer can tell a predicted head from
        // a confirmed one. It is never authoritative and never persists.
        pr: 1
      };
    });
    return { ...frame, p: players, pr: 1 };
  }

  state() {
    if (!this.predicted) return null;
    return {
      tick: this.predicted.tick, confirmedTick: this.confirmed?.tick ?? null,
      body: this.predicted.body.slice(), direction: this.predicted.direction,
      queue: this.predicted.queue.slice(), length: this.predicted.body.length,
      blocked: this.predicted.blocked, lead: this.predicted.tick - (this.confirmed?.tick ?? 0),
      score: this.confirmed?.score ?? null, alive: this.confirmed?.alive ?? false,
      frozen: this.confirmed?.frozen ?? false, official: true
    };
  }

  summary() {
    const { limits, stats, pending, confirmed, predicted } = this;
    return {
      ...stats,
      enabled: this.enabled, active: this.active, reason: this.reason,
      mode: this.mode, tickMs: this.tickMs, growth: this.growth,
      lead: predicted && confirmed ? predicted.tick - confirmed.tick : 0,
      confirmedTick: confirmed?.tick ?? null, predictedTick: predicted?.tick ?? null,
      pending: pending.length,
      pendingSeqs: pending.map((entry) => entry.seq),
      highestSeq: this.highestSeq, appliedSeq: confirmed?.appliedSeq ?? 0,
      limits: { ...limits },
      correctionRate: stats.reconciliations ? stats.corrections / stats.reconciliations : 0,
      // The local view's own claims, tick by tick, for audits and diagnostics.
      predictedHeads: Object.fromEntries([...this.predictedHeads.entries()].sort((a, b) => a[0] - b[0]))
    };
  }
}
