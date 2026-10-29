# Responsive Brawl (step 11): local prediction + buffered remote playback

Responsive Brawl is a **presentation strategy**, not a game mode and not a rule
set. A room's `mode` (`brawl`/`duel`) still decides the authoritative rules, and
both presentation strategies are served by the same `Simulation::World`, the same
scoring and collision rules, and the same match result.

| | Classic Brawl (default) | Responsive Brawl |
| --- | --- | --- |
| Own snake | painted from the confirmed snapshot | **predicted locally** (step 2) |
| Other snakes | painted from the confirmed snapshot | **buffered, interpolated** (step 3) |
| Wire | one complete snapshot per frame | compact movement frames + periodic snapshots |
| Authority | server | server — unchanged |

## Where the code lives

| Concern | File |
| --- | --- |
| Strategy as a room/match setting | `rails/app/models/room.rb`, `.../concerns/room_configuration.rb`, `rails/app/models/match.rb` |
| Strategy on the wire | `rails/app/lib/simulation/protocol.rb` (`encode`, `encode_movement`) |
| Which frame type is sent | `rails/app/models/match_runner.rb` (`publish_frame`) |
| Chunking / resync | `rails/app/channels/match_channel.rb` |
| Local prediction | `public/multiplayer/prediction.js` |
| Remote playback | `public/multiplayer/playback.js` |
| Canvas integration | `public/multiplayer/game-renderer.js` (`present`, `presentPlayback`, `draw`) |
| Input/ack wiring, diagnostics | `public/multiplayer/lobby.js` |

## Remote playback model

A snapshot is a complete authoritative frame, so nothing is *simulated* for other
players. The browser keeps server-confirmed frames **keyed by tick**, and renders
at `playhead = newest confirmed tick - delayTicks`, advancing the playhead on the
monotonic clock (not on packet arrival).

Interpolation is between **two adjacent confirmed ticks only**, segment by
segment:

* segment `i` of tick `T+1` animates from segment `i` of tick `T` to where it is
  at `T+1`, so `Right -> Up -> Left` is played as those three turns;
* a segment moves at most **one cell** per tick — a longer jump (a missing tick)
  is never interpolated, the board holds instead;
* movement is resolved in **toroidal** space (shortest step on a board whose
  edges join), so a wrap slides off one edge and on to the other. A straddling
  segment is drawn on both sides for one tick. It is never dragged across the
  board;
* growth is a longer body (tail stays), a vacated tail simply disappears;
* the own snake is excluded whenever prediction is active, so the two systems
  never write the same cells.

### Adaptive delay

`PLAYBACK_TUNING` in `public/multiplayer/playback.js`:

| Link | Target added delay |
| --- | --- |
| stable | 120 ms |
| moderate jitter | 260 ms |
| heavy jitter | 480 ms |
| hard bounds | 90 – 600 ms |

The delay is nudged at most `40 ms per second` toward its target — remote snakes
never visibly change speed to chase it. Arrival spread (median + range of the
excess over one tick) is the jitter signal, and it is reported as an **estimate**;
the RTT in diagnostics is a **measured** input round trip. If confirmed history
runs out the board stops at the newest confirmed tick (counted as an underrun); if
the playhead falls more than `maxLagTicks` behind, stale history is dropped. At
most `maxBufferTicks` (40) ticks are retained.

### Recovery

| Situation | Behaviour |
| --- | --- |
| tick gap ≤ `resyncGapTicks` (12) | hold the confirmed body; the next full snapshot heals it |
| tick gap > 12 | discard and request a full frame (`MatchChannel#resync`) |
| compact frame with no usable predecessor, or an impossible length | refuse it, request a full frame |
| reconnect / rematch | prediction **and** playback buffers are reset; the seed snapshot rebuilds both |

## Wire format

`Simulation::Protocol.encode_movement` drops what does not change between ticks
(standings, board dims, rules mode, names, colours, placements) and sends only
heads, lengths and scalars. `Protocol.rebuild_body` documents the reconstruction
(`[head, *previous.take(len - 1)]`), and `rails/test/simulation/movement_protocol_test.rb`
proves a chain of movement frames rebuilds byte-identical bodies to the full
snapshots the same world emitted.

Measured with `node scripts/measure-step11-wire.mjs`:

| Case | Snapshot | Movement frame | Saved |
| --- | --- | --- | --- |
| 2 players, 3-cell bodies | 595 B | 351 B | 41 % |
| 8 players, 3-cell bodies | 1 696 B | 1 095 B | 35 % |
| **8 players, 250-cell bodies** | **8 060 B** | **466 B** | **94 %** |

The realistic case also matters operationally: 8 060 B exceeds PostgreSQL's 8 kB
NOTIFY payload and is **chunked into several messages**, while 466 B fits in one.
Complete snapshots are still sent on the first frame, every
`MOVEMENT_FULL_INTERVAL_TICKS` (12) ticks, and on every structural change
(elimination, freeze/unfreeze, status), so recovery is always bounded.

**Classic matches never receive a movement frame.** Their byte stream is
unchanged from before this step.

## Diagnostics

`Movement diagnostics` (below the controls) now reports, at 1 Hz and only while
open:

* the active strategy, from the **locked match** (`presentation_strategy`), and
  whether the client confirmed it from a frame or only from the match summary;
* prediction vs confirmed tick, lead, pending sequences, reconciliations,
  corrections, largest correction;
* measured RTT (input round trip) with its spread, plus a propagation estimate;
* remote playback delay (measured) vs target (estimated), arrival jitter
  (estimated), buffered ticks, playhead, underruns, missing ticks, gaps, resyncs,
  stale discards, compact-vs-full frame counts, wrap frames, and playback canvas
  cost;
* Classic renders `Prediction: off …` / `Remote playback: off …` rather than
  zeroes that could be mistaken for measurements.

## Tests

* `rails/test/simulation/movement_protocol_test.rb` — compact frame shape and
  lossless body reconstruction against the real engine.
* `rails/test/channels/movement_broadcast_test.rb` — Classic sends snapshots
  only; Responsive sends movement frames between periodic snapshots; structural
  changes force a snapshot; oversized movement frames fall back; `resync`
  transmits one complete frame; two participants steer only their own snakes.
* `rails/test/controllers/api/brawl_presentation_strategy_test.rb` — a Responsive
  match starts and the strategy is reported truthfully on the start response, the
  frozen room configuration, the match row, the world and both frame types.
* `tests/remote-playback.test.mjs` — ordering, bounded buffer, playhead lag,
  path-faithful interpolation, turns, horizontal and vertical wrap, underruns,
  missing ticks, adaptive delay bounds and gradualness, compact reconstruction,
  freeze/elimination, two independent clients, Classic inert.
* `tests/grid-renderer.test.mjs` — renderer integration: which snake is painted
  from which source, refusal + resync, throttling, reconnect/destroy cleanup, and
  a Classic-vs-Responsive diagnostics comparison.

## What is NOT verifiable in a CI sandbox — please check on your server

1. **Real Cloudflare Tunnel latency/jitter.** Tuning targets come from the brief
   and from arrival-spread measurements in tests, not from a physical profile.
   Watch `Remote playback: delay … measured (target …)` on a real link.
2. **Physical mobile devices.** Canvas cost is measured, but scanout, touch
   latency and thermal throttling need a device.
3. **The 60 fps feel.** `requestAnimationFrame` cadence in tests is simulated.
4. **PostgreSQL NOTIFY under real fan-out.** The chunking change is reasoned about
   and unit-tested, not load-tested across many Puma workers.
5. **Two real browser tabs fighting for one identity.** The sequence mirror is
   tested server-side (`last_input_seq`) and in the client buffer, but not with
   two physical sessions on your tunnel.
