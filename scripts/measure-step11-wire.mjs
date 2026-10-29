// Step 3 wire measurement: how much smaller is a compact movement frame than the
// complete snapshot the same tick would have sent? Run with:
//   node scripts/measure-step11-wire.mjs
// Numbers come from the real Ruby encoder via tests/support/*.json fixtures and,
// for the movement frame, from the deterministic reconstruction the server emits
// (head + length + scalars), so they reflect the shipped payloads.
import { readFileSync } from 'node:fs';

const trace = JSON.parse(readFileSync(new URL('../tests/fixtures/prediction-trace.json', import.meta.url)));
const frame = trace.scenarios.find((entry) => entry.name === 'wrap').frames.at(-1);

const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

// The full snapshot as MatchChannel sends it.
const snapshot = { ...frame, type: 'snapshot' };

// The compact movement frame Simulation::Protocol.encode_movement would produce
// for the same tick: metadata dropped, bodies reduced to their head.
const movement = {
  v: frame.v, type: 'movement', m: frame.m, strategy: frame.strategy, s: frame.s, t: frame.t,
  ts: frame.ts, f: frame.f,
  p: frame.p.map((player) => ({
    i: player.i, h: player.b[0], d: player.d, l: player.l, sc: player.sc, a: player.a,
    fr: player.fr, gu: player.gu, cy: player.cy, is: player.is, it: player.it,
    el: player.el, er: player.er
  }))
};

const rows = [
  { players: frame.p.length, playersCount: frame.p.length, snapshot: bytes(snapshot), movement: bytes(movement) }
];
const scale = (count) => {
  const perPlayer = (bytes(snapshot) - bytes({ ...snapshot, p: [] })) / frame.p.length;
  const perPlayerMovement = (bytes(movement) - bytes({ ...movement, p: [] })) / frame.p.length;
  const base = bytes({ ...snapshot, p: [] });
  const baseMovement = bytes({ ...movement, p: [] });
  return { players: count, snapshot: Math.round(base + perPlayer * count), movement: Math.round(baseMovement + perPlayerMovement * count) };
};
for (const count of [2, 4, 8, 16, 32, 64]) rows.push(scale(count));

console.log('tick_ms', trace.config.tick_ms, 'board', `${frame.b.c}x${frame.b.r}`, 'bodies', frame.p.map((p) => p.b.length).join('/'));
console.log('players  full snapshot  movement frame  saved');
for (const row of rows) {
  const saved = row.snapshot - row.movement;
  console.log(String(row.players).padEnd(8), String(row.snapshot).padEnd(14), String(row.movement).padEnd(15),
    `${saved} B (${((saved / row.snapshot) * 100).toFixed(0)}%)`);
}
const live = rows[0];
const perSecond = Math.round(1000 / trace.config.tick_ms);
console.log(`at tick_ms=${trace.config.tick_ms} (${perSecond} frames/s) a two-player Brawl saves`,
  `${(live.snapshot - live.movement) * perSecond} B/s per socket`);

// A realistic mid-match Brawl: the 250-cell body fixture captured from the real
// transport (tests/fixtures/mobile3-notify-packets.json). This is the case the
// compact frame exists for — the longer the snakes, the more of the frame was
// body cells that only move one cell per tick.
try {
  const { snapshot: long } = JSON.parse(readFileSync(new URL('../tests/fixtures/mobile3-notify-packets.json', import.meta.url)));
  const longMovement = {
    v: long.v, type: 'movement', m: long.m, strategy: long.strategy, s: long.s, t: long.t, ts: long.ts, f: long.f,
    p: long.p.map((player) => ({
      i: player.i, h: player.b[0], d: player.d, l: player.l, sc: player.sc, a: player.a,
      fr: player.fr, gu: player.gu, cy: player.cy, is: player.is, it: player.it, el: player.el, er: player.er
    }))
  };
  const before = bytes({ ...long, type: 'snapshot' });
  const after = bytes(longMovement);
  console.log(`\nreal 8-player Brawl, bodies ${long.p.map((p) => p.b.length).join('/')} cells:`);
  console.log(`  snapshot ${before} B -> movement ${after} B (saved ${before - after} B, ` +
    `${(((before - after) / before) * 100).toFixed(0)}%)`);
  console.log(`  NOTE: this snapshot exceeds PostgreSQL's 8 kB NOTIFY cap and was chunked into several`);
  console.log(`  messages; the movement frame fits in ONE, so the chunk reassembly path is skipped too.`);
} catch (error) {
  console.log('\n(long-body fixture unavailable:', error.message, ')');
}
