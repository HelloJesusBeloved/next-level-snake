// Discrete snapshot presentation, not interpolation or a second game engine.
// Only frames actually received from Rails can be returned by take().
// Controls always use the newest received snapshot, never this display queue.
export class GridCadence {
  constructor({ tickMs = 105, enabled = true, maxHoldMs = 50, capacity = 3 } = {}) {
    this.tickMs = tickMs;
    this.enabled = enabled;
    this.maxHoldMs = maxHoldMs;
    this.capacity = capacity;
    this.reset();
  }

  reset() {
    this.queue = [];
    this.offsets = [];
    this.anchor = null;
    this.last = null;
    this.phase = 0;
    this.presentedTick = -1;
    this.coalesced = 0;
    this.resets = 0;
    this.waitMs = 0;
  }

  configure({ tickMs = this.tickMs, enabled = this.enabled } = {}) {
    if (tickMs !== this.tickMs || enabled !== this.enabled) {
      this.tickMs = tickMs;
      this.enabled = enabled;
      this.reset();
    }
  }

  get maxWait() { return Math.min(this.maxHoldMs, this.tickMs / 2); }
  get pending() { return this.queue.length > 0; }

  receive(frame, at, urgent = false) {
    if (!frame || !Number.isInteger(frame.t) || !Number.isFinite(at)) return false;
    if (this.last && frame.m === this.last.frame.m && frame.t < this.last.frame.t) return false;
    const previous = this.last;
    const changedMatch = previous && frame.m !== previous.frame.m;
    const gap = previous && frame.t > previous.frame.t + 1;
    const stalled = previous && at - previous.at > Math.max(200, this.tickMs * 2);
    // TCP can deliver several buffered frames in a few milliseconds. They
    // cannot each occupy a visible refresh; never replay this stale history.
    const burst = previous && frame.t > previous.frame.t &&
      at - previous.at < Math.min(12, this.tickMs * 0.2);

    if (!this.anchor || urgent || changedMatch || gap || stalled || burst || !this.enabled) {
      this.coalesced += this.queue.length;
      this.queue.length = 0;
      this.offsets.length = 0;
      this.anchor = { tick: frame.t, at };
      this.phase = 0;
      if (previous && (gap || stalled || burst)) this.resets++;
      if (changedMatch) this.presentedTick = -1;
    }

    let due = at;
    if (this.enabled && !urgent && !gap && !stalled && !burst) {
      const nominal = this.anchor.at + (frame.t - this.anchor.tick) * this.tickMs;
      const offset = at - nominal;
      this.offsets.push(offset);
      if (this.offsets.length > 48) this.offsets.shift();
      if (this.offsets.length >= 6) {
        const sorted = this.offsets.slice().sort((a, b) => a - b);
        const low = sorted[0];
        const spread = sorted[Math.floor((sorted.length - 1) * 0.9)] - low;
        // Ordinary sub-frame timing noise is not a reason to add delay.
        const target = low + (spread > 12 ? Math.min(this.maxWait, spread) : 0);
        // Do not jump the display clock on every arrival (another source of
        // jitter). A phase adjustment costs at most 4ms per received tick.
        this.phase += Math.max(-4, Math.min(4, target - this.phase));
      }
      due = Math.max(at, Math.min(nominal + this.phase, at + this.maxWait));
    }
    this.queue.push({ frame, receivedAt: at, due });
    while (this.queue.length > this.capacity) { this.queue.shift(); this.coalesced++; }
    this.last = { frame, at };
    return true;
  }

  take(at) {
    let newest = null;
    while (this.queue.length && this.queue[0].due <= at) {
      if (newest) this.coalesced++;
      newest = this.queue.shift();
    }
    if (!newest) return null;
    if (newest.frame.t < this.presentedTick) return null;
    this.presentedTick = newest.frame.t;
    this.waitMs = at - newest.receivedAt;
    return newest.frame;
  }
}

// Read-only, bounded diagnostics. No telemetry is sent anywhere; clocks are
// monotonic and all values describe a browser observation, not physical scanout.
export class MovementTimings {
  constructor(limit = 180) {
    this.limit = limit;
    this.arrivalMs = [];
    this.serverMs = [];
    this.variationMs = [];
    this.drawMs = [];
    this.paintDelayMs = [];
    this.previous = null;
    this.received = 0;
    this.painted = 0;
    this.skippedTicks = 0;
  }
  push(list, value) {
    if (!Number.isFinite(value)) return;
    list.push(value);
    if (list.length > this.limit) list.shift();
  }
  receive(frame, at) {
    const before = this.previous;
    if (before && frame.m !== before.frame.m) this.previous = null;
    if (this.previous && frame.t > before.frame.t) {
      const delta = frame.t - before.frame.t;
      this.push(this.arrivalMs, at - before.at);
      if (frame.ts > 0 && before.frame.ts > 0) {
        const elapsed = frame.ts - before.frame.ts;
        this.push(this.serverMs, elapsed / delta);
        this.push(this.variationMs, Math.abs((at - before.at) - elapsed));
      }
      this.skippedTicks += Math.max(0, delta - 1);
    }
    this.previous = { frame, at };
    this.received++;
  }
  draw(duration, delay) {
    this.push(this.drawMs, duration);
    this.push(this.paintDelayMs, delay);
    this.painted++;
  }
  stats(list) {
    if (!list.length) return { samples: 0, p50: 0, p95: 0, max: 0 };
    const sorted = list.slice().sort((a, b) => a - b);
    const q = (p) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] * 10) / 10;
    return { samples: sorted.length, p50: q(.5), p95: q(.95), max: q(1) };
  }
  summary() {
    return {
      received: this.received, painted: this.painted, skippedServerTicks: this.skippedTicks,
      serverTickMs: this.stats(this.serverMs), arrivalGapMs: this.stats(this.arrivalMs),
      deliveryVariationMs: this.stats(this.variationMs), drawCostMs: this.stats(this.drawMs),
      receiveToPaintMs: this.stats(this.paintDelayMs),
    };
  }
}

// Normally submit at the next display callback. WebKit/low-power browser
// scheduling can postpone rAF even while WebSocket events are arriving; an
// already-received board should not wait indefinitely for that callback.
// This timeout is presentation-only, not a game clock or network retry.
export class FrameGate {
  constructor({ request, cancel, later = (cb, ms) => setTimeout(cb, ms), clear = (id) => clearTimeout(id), timeoutMs = 32 } = {}) {
    this.requestFrame = request;
    this.cancelFrame = cancel;
    this.later = later;
    this.clearTimer = clear;
    this.timeoutMs = timeoutMs;
    this.pending = false;
    this.frame = null;
    this.timer = null;
    this.version = 0;
    this.fallbacks = 0;
  }
  schedule(callback) {
    if (this.pending) return;
    this.pending = true;
    const version = ++this.version;
    const fire = (fallback) => {
      if (!this.pending || version !== this.version) return;
      this.pending = false;
      if (this.frame != null) this.cancelFrame(this.frame);
      if (this.timer != null) this.clearTimer(this.timer);
      this.frame = this.timer = null;
      if (fallback) this.fallbacks++;
      callback();
    };
    this.frame = this.requestFrame(() => fire(false));
    if (this.pending) this.timer = this.later(() => fire(true), this.timeoutMs);
  }
  cancel() {
    this.version++;
    this.pending = false;
    if (this.frame != null) this.cancelFrame(this.frame);
    if (this.timer != null) this.clearTimer(this.timer);
    this.frame = this.timer = null;
  }
}
