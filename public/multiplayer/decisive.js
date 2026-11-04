/*!
 * Responsive Brawl — the local snake is decisive.
 *
 * The browser steps this player's snake on one clock, the same way
 * public/game.js does: a key changes the next cell, and a packet never
 * relocates the body. Every step reports the cell that was actually entered.
 * The server checks that cell is one legal step on from the last one it
 * accepted and paints it for everyone else. Food still spawns on the server;
 * landing on that cell grows the local snake immediately, and the report is
 * how the server counts the point and respawns.
 *
 * Classic does not import this. Other players are not simulated here.
 */
const DIRECTIONS = Object.freeze({
  up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0]
});
const OPPOSITE = Object.freeze({ up: 'down', down: 'up', left: 'right', right: 'left' });
const QUEUE_CAP = 2;
const CATCHUP_CAP = 5;

const wrap = (value, size) => ((value % size) + size) % size;

export class DecisiveSnake {
  constructor({ tickMs = 105, columns = 24, rows = 18, ownParticipantId = null,
                growth = 1, clock = () => performance.now(), onStep = null } = {}) {
    this.tickMs = tickMs;
    this.columns = columns;
    this.rows = rows;
    this.ownParticipantId = ownParticipantId;
    this.growth = growth;
    this.clock = clock;
    this.onStep = onStep;
    this.reason = 'off';
    this.enabled = false;
    this.seeded = false;
    this.dead = false;
    this.frozen = false;
    this.running = false;
    this.body = [];
    this.direction = 'right';
    this.queue = [];
    this.grow = 0;
    this.score = 0;
    this.serverScore = 0;
    this.pellet = null;
    this.ignoredFood = null;
    this.tick = 0;
    this.serverTick = 0;
    this.seq = 0;
    this.pendingSeqs = [];
    this.nextStepAt = null;
    this.matchId = null;
    this.submitted = 0;
    this.refused = 0;
    this.eaten = 0;
    this.frozenPauses = 0;
    this.resets = 0;
    this.steps = 0;
  }

  enable(reason = 'responsive') {
    this.enabled = true;
    this.reason = reason;
    return true;
  }

  disable(reason = 'classic') {
    this.enabled = false;
    this.reason = reason;
    this.seeded = false;
    this.dead = false;
    this.running = false;
    this.body = [];
    this.queue = [];
    this.pellet = null;
    this.ignoredFood = null;
    this.nextStepAt = null;
    return true;
  }

  get active() {
    return this.enabled && this.seeded && this.running && !this.dead && !this.frozen;
  }

  get shownScore() {
    return Math.max(this.score, this.serverScore);
  }

  // The pellet to draw. Null after a local bite until the server's cell changes,
  // so the eaten one does not stay on the board and the respawn is not drawn early.
  get food() {
    if (this.ignoredFood !== null && this.pellet === this.ignoredFood) return null;
    return this.pellet;
  }

  configure({ tickMs, columns, rows, ownParticipantId, growth } = {}) {
    if (Number.isFinite(tickMs) && tickMs > 0) this.tickMs = tickMs;
    if (Number.isInteger(columns) && columns > 0) this.columns = columns;
    if (Number.isInteger(rows) && rows > 0) this.rows = rows;
    if (ownParticipantId != null) this.ownParticipantId = Number(ownParticipantId);
    if (Number.isInteger(growth) && growth >= 0) this.growth = growth;
  }

  noteSequenceMirror(last) {
    const seq = Number(last);
    if (Number.isInteger(seq) && seq >= 0) this.seq = seq;
  }

  noteQueued() { return false; }
  noteApplied() { return false; }
  noteRejected() { return false; }
  setLeadTargetMs() { return null; }

  reset(reason = 'reset', { reconnect = false } = {}) {
    this.seeded = false;
    this.dead = false;
    this.frozen = false;
    this.running = false;
    this.body = [];
    this.queue = [];
    this.grow = 0;
    this.pellet = null;
    this.ignoredFood = null;
    this.nextStepAt = null;
    this.tick = 0;
    this.pendingSeqs = [];
    if (reconnect) this.resets += 1;
    return false;
  }

  // Stop the clock without throwing away the body. A finished board, a
  // paused match, or a rematch click all hold here so the snake stays on the
  // cell it was already on.
  hold(reason = 'hold') {
    this.running = false;
    this.nextStepAt = null;
    this.queue = [];
    this.reason = reason;
    return true;
  }

  observe(frame) {
    if (!this.enabled || !frame || !Array.isArray(frame.p)) return false;
    const own = frame.p.find((player) => Number(player.i) === Number(this.ownParticipantId));
    if (!own || !Array.isArray(own.b) || own.b.length === 0) return false;
    if (Number.isInteger(frame.b?.c)) this.columns = frame.b.c;
    if (Number.isInteger(frame.b?.r)) this.rows = frame.b.r;
    if (Number.isInteger(frame.tick_ms) && frame.tick_ms > 0) this.tickMs = frame.tick_ms;
    const matchChanged = this.matchId != null && frame.m != null && frame.m !== this.matchId;
    if (frame.m != null) this.matchId = frame.m;
    if (Number.isInteger(frame.t)) this.serverTick = frame.t;

    if (!this.seeded || matchChanged || this.body.length === 0) this.seedFrom(own, frame);
    this.adoptRemote(own, frame);
    return true;
  }

  // A movement frame whose body could not be rebuilt. Take the pellet only.
  glimpse(frame) {
    if (!this.seeded || !frame) return false;
    this.adoptFood(frame);
    if (Number.isInteger(frame.t)) this.serverTick = frame.t;
    return true;
  }

  seedFrom(own, frame) {
    this.body = own.b.slice();
    this.direction = DIRECTIONS[own.d] ? own.d : 'right';
    this.queue = [];
    this.grow = 0;
    this.score = Number.isInteger(own.sc) ? own.sc : 0;
    this.serverScore = this.score;
    this.dead = own.a === false;
    this.frozen = !!own.fr;
    // Only a live running frame starts the clock. A completed or abandoned
    // board is a picture of the last cells, not a match to keep playing.
    this.running = frame.s === 'running' && !this.dead && !this.frozen;
    this.pellet = null;
    this.ignoredFood = null;
    this.tick = 0;
    this.seeded = true;
    this.matchId = frame.m;
    this.adoptFood(frame);
    this.nextStepAt = this.running ? this.clock() + this.tickMs : null;
  }

  adoptRemote(own, frame) {
    if (Number.isInteger(own.sc)) this.serverScore = own.sc;
    if (own.sc > this.score) this.score = own.sc;
    this.adoptFood(frame);
    if (own.a === false) {
      this.dead = true;
      this.running = false;
      this.nextStepAt = null;
      return;
    }
    // Anything other than a running frame holds. Do not mark a living winner
    // dead just because the match ended — the final body should stay visible.
    if (own.fr || frame.s !== 'running') {
      if (own.fr && !this.frozen) this.frozenPauses += 1;
      this.frozen = !!own.fr;
      this.running = false;
      this.nextStepAt = null;
      this.queue = [];
      return;
    }
    const resume = !this.running && !this.dead;
    this.frozen = false;
    this.running = true;
    if (resume) this.nextStepAt = this.clock() + this.tickMs;
  }

  adoptFood(frame) {
    if (!frame || !Array.isArray(frame.f)) return;
    const owned = frame.f.find((food) => food && Number.isInteger(food.o) &&
      Number(food.o) === Number(this.ownParticipantId) && Number.isInteger(food.c));
    let cell = owned ? owned.c : null;
    const anyOwned = frame.f.some((food) => food && Number.isInteger(food.o));
    if (cell === null && !anyOwned) {
      const shared = frame.f.find((food) => food && Number.isInteger(food.c));
      cell = shared ? shared.c : null;
    }
    if (this.ignoredFood !== null && cell !== this.ignoredFood) this.ignoredFood = null;
    this.pellet = cell;
  }

  submit(direction) {
    this.submitted += 1;
    if (!this.active) {
      this.refused += 1;
      return { rejectedReason: 'inactive', scheduledTick: null };
    }
    if (!DIRECTIONS[direction]) {
      this.refused += 1;
      return { rejectedReason: 'invalid', scheduledTick: null };
    }
    const last = this.queue.length ? this.queue[this.queue.length - 1] : this.direction;
    if (direction === last) {
      this.refused += 1;
      return { rejectedReason: 'duplicate', scheduledTick: null };
    }
    if (this.body.length > 1 && direction === OPPOSITE[last]) {
      this.refused += 1;
      return { rejectedReason: 'reversal', scheduledTick: null };
    }
    if (this.queue.length >= QUEUE_CAP) {
      this.refused += 1;
      return { rejectedReason: 'queue_full', scheduledTick: null };
    }
    this.queue.push(direction);
    return { rejectedReason: null, direction, scheduledTick: this.tick + 1 };
  }

  advance(now) {
    if (!this.active || this.nextStepAt === null) return 0;
    let steps = 0;
    while (steps < CATCHUP_CAP && now >= this.nextStepAt) {
      this.stepOnce();
      steps += 1;
      this.nextStepAt += this.tickMs;
      if (!this.active) break;
    }
    // A hidden tab does not skip cells. Missed time is dropped and the snake
    // continues from the cell it is already on, one step per tickMs.
    if (this.active && this.nextStepAt !== null && now - this.nextStepAt > this.tickMs) {
      this.nextStepAt = now + this.tickMs;
    }
    return steps;
  }

  stepOnce() {
    if (this.queue.length) {
      const next = this.queue.shift();
      if (!(this.body.length > 1 && next === OPPOSITE[this.direction])) this.direction = next;
    }
    const delta = DIRECTIONS[this.direction];
    const head = this.body[0];
    const x = head % this.columns;
    const y = Math.floor(head / this.columns);
    const nx = wrap(x + delta[0], this.columns);
    const ny = wrap(y + delta[1], this.rows);
    const nextCell = ny * this.columns + nx;
    const limit = this.grow > 0 ? this.body.length : Math.max(0, this.body.length - 1);
    for (let index = 0; index < limit; index += 1) {
      if (this.body[index] !== nextCell) continue;
      this.dead = true;
      this.running = false;
      this.queue = [];
      this.nextStepAt = null;
      this.emitReport(nextCell);
      return;
    }
    this.body = [nextCell, ...this.body];
    if (this.pellet !== null && nextCell === this.pellet && this.ignoredFood !== this.pellet) {
      this.score += 1;
      this.grow += this.growth;
      this.eaten += 1;
      this.ignoredFood = this.pellet;
    }
    if (this.grow > 0) this.grow -= 1;
    else this.body.pop();
    this.tick += 1;
    this.steps += 1;
    this.emitReport(this.body[0]);
  }

  emitReport(cell) {
    this.seq += 1;
    this.pendingSeqs.push(this.seq);
    if (this.pendingSeqs.length > 60) this.pendingSeqs.shift();
    const report = {
      v: 1, type: 'report', match: this.matchId,
      tick: this.serverTick, seq: this.seq, dir: this.direction, c: cell
    };
    this.onStep?.(report);
  }

  // Replaces only this player's cells, direction, length and score.
  // Every other player object is returned untouched.
  displayFrame(frame) {
    if (!this.seeded || !frame || !Array.isArray(frame.p)) return frame;
    return {
      ...frame,
      p: frame.p.map((player) => {
        if (Number(player.i) !== Number(this.ownParticipantId)) return player;
        return {
          ...player,
          b: this.body.slice(),
          d: this.direction,
          l: this.body.length,
          sc: this.shownScore,
          a: !this.dead && player.a !== false,
          pr: 1
        };
      })
    };
  }

  summary() {
    return {
      decisive: true,
      enabled: this.enabled,
      active: this.active,
      seeded: this.seeded,
      reason: this.reason,
      confirmedTick: this.serverTick,
      predictedTick: this.tick,
      predictedTicks: this.steps,
      pending: this.queue.length,
      pendingSeqs: this.pendingSeqs.slice(),
      reportedSeq: this.seq,
      localHead: this.body[0] ?? null,
      submitted: this.submitted,
      queuedAcks: 0,
      appliedAcks: 0,
      rejectedAcks: 0,
      refused: this.refused,
      reconciliations: 0,
      corrections: 0,
      correctionRate: 0,
      maxCorrectionCells: 0,
      staleFrames: 0,
      duplicateFrames: 0,
      lead: 0,
      leadTarget: 0,
      leadStalls: 0,
      horizonRefusals: 0,
      droppedPending: 0,
      catchupDiscards: 0,
      foreignApplied: 0,
      predictedFood: this.eaten,
      predictedGrowths: this.eaten,
      frozenPauses: this.frozenPauses,
      blockedTurns: 0,
      resetForReconnect: this.resets,
      limits: { maxLeadTicks: 0 },
    };
  }
}
