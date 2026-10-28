// Touch steering geometry for the Brawl arena. Pure maths plus an injectable
// sink, so the exact finger path a player uses can be unit tested without a
// real screen. It never invents, predicts or reorders a turn: it only decides
// WHEN a completed gesture is far enough along one axis to be sent.
//
// The bug this replaces: the origin was measured once per gesture, so an
// L-shaped swipe (down, then left) had to travel further left than it travelled
// down before the second turn fired — or never fired at all if the two legs
// were similar in length. A fast "down then left" therefore landed one or more
// cells late, which reads as input lag and puts the snake a square off from
// where the player aimed.
export const SWIPE_THRESHOLD_PX = 14;

// One leg of a gesture. Returns the axis-dominant direction, or null while the
// finger is still inside the threshold. An exact diagonal tie is deliberately
// unresolved: guessing would send a turn the player did not choose.
export function legDirection(from, to, threshold = SWIPE_THRESHOLD_PX) {
  if (!from || !to) return null;
  const dx = Number(to.x) - Number(from.x);
  const dy = Number(to.y) - Number(from.y);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < threshold) return null;
  if (Math.abs(dx) === Math.abs(dy)) return null;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'down' : 'up';
}

// Accumulates one pointer gesture and emits turns as soon as each leg is
// unambiguous. After every emission the origin is RE-ANCHORED to the current
// finger position, so each subsequent leg only has to cross the threshold from
// where the previous turn fired. That is what makes a fast L-swipe land on the
// immediately following ticks.
export class SwipeSteering {
  constructor({ threshold = SWIPE_THRESHOLD_PX, send = () => {} } = {}) {
    this.threshold = threshold;
    this.send = send;
    this.reset();
  }

  reset() {
    this.anchor = null;
    this.last = null;
    this.emitted = 0;
  }

  get active() { return this.anchor !== null; }

  // A gesture only starts on a real finger/pen contact.
  begin(point) {
    if (!point) return;
    this.anchor = { x: Number(point.x), y: Number(point.y) };
    this.last = null;
    this.emitted = 0;
  }

  // Called for every pointer move. Emits zero or one turn.
  move(point) {
    if (!this.anchor || !point) return null;
    const direction = legDirection(this.anchor, point, this.threshold);
    if (!direction) return null;
    // ALWAYS consume the travel, including a duplicate leg. If the anchor were
    // held while the finger kept going the same way, that accumulated distance
    // would still dominate the axis comparison and delay the next real turn —
    // the very failure this class exists to remove.
    this.anchor = { x: Number(point.x), y: Number(point.y) };
    if (direction === this.last) return null; // duplicate the server would reject
    this.last = direction;
    this.emitted += 1;
    this.send(direction);
    return direction;
  }

  // Lifting the finger still commits whatever leg was in progress, so a very
  // fast flick whose second leg never got a separate move event is not lost.
  // A cancelled gesture sends nothing.
  end(point) {
    if (!this.anchor) { this.reset(); return null; }
    const direction = legDirection(this.anchor, point, this.threshold);
    this.reset();
    if (!direction || direction === this.last) return null;
    this.send(direction);
    return direction;
  }

  cancel() { this.reset(); }
}
