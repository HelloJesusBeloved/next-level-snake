# Responsive Brawl (step 11): one confirmed tick, plus a one-cell input lead

Responsive Brawl is a **presentation strategy**, not a game mode and not a rule
set. A room's `mode` (`brawl`/`duel`) still decides the authoritative rules, and
both presentation strategies are served by the same `Simulation::World`.

| | Classic Brawl (default) | Responsive Brawl |
| --- | --- | --- |
| Own snake | the confirmed snapshot | the same confirmed tick, plus at most one not-yet-applied turn |
| Other snakes | the confirmed snapshot | that same confirmed tick, one tick behind the newest frame |
| Pellets, score, length | the confirmed snapshot | that same tick. The client does not keep its own pellet |
| Wire | one complete snapshot per published frame | one complete snapshot per simulated tick, with `tick_ms`, `tm`, food generation `g` and eaten events `fe` |
| Authority | server | server — unchanged. The input envelope is still `{v,type,match,tick,seq,dir}` |

A full snapshot of a normal board is about a kilobyte (two length-8 snakes on
24×18). At 105 ms that is about 10 KB/s. Compact movement frames were smaller
and could not say which pellet generation was eaten, and a catch-up of several
`step!` calls used to publish only the last tick. Responsive matches therefore
send the complete frame for every tick. Classic's snapshot bytes are unchanged.

## Where the code lives

| Concern | File |
| --- | --- |
| Strategy as a room/match setting | `rails/app/models/room.rb`, `.../concerns/room_configuration.rb`, `rails/app/models/match.rb` |
| Food generation and eaten events | `rails/app/lib/simulation/food.rb`, `world.rb`, `protocol.rb` |
| One frame per simulated tick | `rails/app/models/match_runner.rb` (`capture_responsive_frame`, `publish_frame`) |
| One-cell input lead | `public/multiplayer/prediction.js` |
| Render delay of one tick | `public/multiplayer/playback.js` |
| Canvas | `public/multiplayer/game-renderer.js` |

## What the client draws

Every snake, pellet, length and score on the canvas comes from one confirmed
tick: `newest - 1`. The playhead slews toward that tick and keeps leftover
time, so a burst does not become a permanent offset. It never glides and never
invents a cell for a hole.

The only thing predicted locally is a turn the server has not applied yet, drawn
one cell ahead of that confirmed body. On the frame for that tick the predicted
head is compared with the server head. If the difference is the pending turn,
the turn stays. Any other difference snaps to the server body. Food is never
predicted.

## Remote playback model

A snapshot is a complete authoritative frame. The browser keeps those frames
keyed by tick and renders `playhead = newest confirmed tick - 1`.

Interpolation is not used. Segment positions are whole cells from the frame
being rendered. A missing tick is skipped to the next stored snapshot. The
render delay is one tick, not an adaptive 90–600 ms cushion.

## Input

Clients still send only `{ v, type, match, tick, seq, dir }`.
`FORBIDDEN_INPUT_KEYS` is unchanged. The server still applies a queued turn on
the following `step!`.


### Recovery

| Situation | Behaviour |
| --- | --- |
| tick gap ≤ `resyncGapTicks` (12) | hold the confirmed body; the next full snapshot heals it |
| tick gap > 12 | discard and request a full frame (`MatchChannel#resync`) |
| compact frame with no usable predecessor, or an impossible length | refuse it, request a full frame |
| reconnect / rematch | prediction **and** playback buffers are reset; the seed snapshot rebuilds both |

## Wire format

Responsive matches broadcast `Protocol.encode` — a complete snapshot — for every
simulated tick, including each step of a catch-up burst. The additive fields are
`tick_ms`, `tm` (tick × tick_ms), food generation `g`, and `fe` (eaten events:
owner, generation, tick, cell). Classic snapshots do not include those keys, and
Classic food stays `{c, o}`.

`encode_movement` still exists and the Rails reconstruction test still proves a
contiguous compact chain is lossless. Responsive does not put that chain on the
wire. A compact frame cannot name which pellet generation was eaten, and a
catch-up that published only the last tick forced the browser to invent the
ones in between. A full snapshot of two length-8 snakes on 24×18 is about 1.1 KB,
about 10 KB/s at 105 ms.

**Classic matches never receive a movement frame and never receive the
Responsive fields.** Their byte stream is unchanged.

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

* `rails/test/simulation/responsive_food_identity_test.rb` — generation increments
  once per eat, a catch-up keeps every tick, Classic snapshots gain no new keys.
* `rails/test/channels/movement_broadcast_test.rb` — Classic sends snapshots
  only; Responsive sends one complete snapshot per tick with `tick_ms`, `tm`,
  `fe` and food `g`.
* `tests/responsive-authority.test.mjs` — two clients, loss and jitter, one
  pellet per owner at the server cell, render offset does not grow.
* `rails/test/controllers/api/brawl_presentation_strategy_test.rb` — a Responsive
  match starts and the strategy is reported truthfully on the start response, the
  frozen room configuration, the match row, the world and both frame types.
* `tests/remote-playback.test.mjs` — ordering, bounded buffer, playhead held
  at newest tick minus one, surplus time kept, a hole is not filled with an
  invented body, compact reconstruction refused, freeze/elimination, two
  independent clients, Classic inert.
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
