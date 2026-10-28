// Reassemble oversized Action Cable snapshots. Normal snapshots bypass this
// module. A chunk is NOT gameplay state: only the complete, validated server
// snapshot may reach the renderer or input controls.
export class SnapshotChunks {
  constructor({ maxParts = 2048, maxBytes = 4_000_000 } = {}) {
    this.maxParts = maxParts;
    this.maxBytes = maxBytes;
    this.reset();
  }

  reset() {
    this.pending = null;
  }

  receive(chunk, matchId, lastTick = -1) {
    if (!chunk || chunk.type !== 'snapshot_chunk' ||
        !Number.isSafeInteger(chunk.m) || chunk.m !== matchId ||
        !Number.isSafeInteger(chunk.t) || chunk.t < lastTick ||
        !Number.isInteger(chunk.parts) || chunk.parts < 2 || chunk.parts > this.maxParts ||
        !Number.isInteger(chunk.part) || chunk.part < 0 || chunk.part >= chunk.parts ||
        typeof chunk.data !== 'string' || chunk.data.length > 3000) {
      this.reset();
      return null;
    }

    if (chunk.part === 0) {
      // A newer first chunk supersedes any incomplete frame. This is not a
      // replay buffer; missing packets must not stall or resurrect old cells.
      this.pending = { matchId, tick: chunk.t, count: chunk.parts,
                       next: 0, bytes: 0, parts: [] };
    }
    const pending = this.pending;
    if (!pending || pending.matchId !== matchId || pending.tick !== chunk.t ||
        pending.count !== chunk.parts || chunk.part !== pending.next) {
      this.reset();
      return null;
    }
    pending.parts.push(chunk.data);
    pending.next += 1;
    pending.bytes += chunk.data.length;
    if (pending.bytes > this.maxBytes) {
      this.reset();
      return null;
    }
    if (pending.next !== pending.count) return null;

    this.reset();
    try {
      const snapshot = JSON.parse(pending.parts.join(''));
      return snapshot.type === 'snapshot' && snapshot.v === 1 &&
        snapshot.m === matchId && snapshot.t === pending.tick &&
        Array.isArray(snapshot.p) && Array.isArray(snapshot.f) ? snapshot : null;
    } catch {
      return null;
    }
  }
}
