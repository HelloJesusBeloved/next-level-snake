// Step 10 mobile pass: budget the *presentation* work, never the game.
//
// A Brawl is a discrete grid. The world still moves at the server's tick rate,
// but the DOM does NOT have to reflow 10 or 24 times per second for a number
// whose display changes only once a second (survival time, tick readout,
// status). The renderer paints every authoritative frame; this clock only
// updates non-critical live text.
//
// The clock is an injectable task sampler so unit tests can advance it without
// a wall-clock sleep. No timer decides a snake's movement, score or freeze.
export function createPlayBudget({ now = () => performance.now(), schedule = (cb) => setTimeout(cb, 1000), cancel = (id) => clearTimeout(id), interval = 1000 } = {}) {
  let running = false;
  let timer = null;
  let pending = new Map();
  let last = 0;

  function drain() {
    timer = null;
    if (!running) return;
    const nowAt = now();
    if (nowAt - last < interval) {
      timer = schedule(drain, interval - (nowAt - last));
      return;
    }
    last = nowAt;
    const work = [...pending.values()];
    pending.clear();
    for (const task of work) task();
  }

  return {
    start() {
      if (running) return;
      running = true;
      if (!timer) timer = schedule(drain, interval);
    },
    stop() {
      running = false;
      if (timer) cancel(timer);
      timer = null;
      pending.clear();
    },
    // Requests work by key. Several frames arriving at once do not produce
    // several DOM mutations: the latest task for each key wins.
    add(key, task) {
      if (!running) return;
      pending.set(key, task);
      if (!timer) timer = schedule(drain, Math.max(0, interval - (now() - last)));
    },
    // Terminal state and an important connection change may be shown at once;
    // this is never used for frame movement or for user-input decisions.
    flush(key) {
      if (!running) return;
      const work = pending.get(key);
      if (work) { pending.delete(key); work(); }
    },
    get size() { return pending.size; },
  };
}

// A cheap read-only text update guard: assigning the SAME text to a node
// still creates a mutation and may re-trigger style/ARIA calculations. It
// costs almost nothing to compare here instead of invalidating the full page.
export function text(node, value) {
  if (node && node.textContent !== String(value)) node.textContent = String(value);
}

// Build the only display keys that matter: not the full snapshot, not the
// tick, not the survival tick counter (which must not reflow 20x per second).
export function hudKey(snapshot, ownId, tickMs) {
  if (!snapshot) return '';
  const players = snapshot.p || [];
  return `${snapshot.m}:${snapshot.s}:${ownId}:${tickMs}:${players.map((p) =>
    `${p.i}:${p.a ? 1 : 0}:${p.fr ? 1 : 0}:${p.sc}:${p.l}:${p.n}:${p.c}:${Math.floor(p.sv * tickMs / 1000)}`
  ).join(';')}`;
}
