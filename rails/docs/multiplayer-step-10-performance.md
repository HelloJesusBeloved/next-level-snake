# Step 10 performance — multiplayer responsiveness

Second commit of step 10. It changes **no rules, no protocol, no tables**; it
removes work from the hot paths that made a Brawl feel laggy while keeping every
step-10 authority guarantee (the server still owns movement, freeze, grace,
scores and results).

## What was actually slow

Measured by reading the SQL each path emitted per second, with one live Brawl:

| Path | Before | After |
| --- | --- | --- |
| Connection sync (per simulator pass, 20×/s) | `FOR UPDATE` on the match + participants query + **one `reload` per player** | one indexed `pluck`, no lock, **zero writes** when clean (150 ms cadence) |
| Snapshot publish (10×/s) | `Match.find_by` + **jsonb `UPDATE`** + **full row `reload`** every 100 ms | in-memory broadcast at ~15 Hz; durable write every 2 s, no reload |
| Direction command (per keypress) | **match row lock**, participant lock, count, insert, update, plus 2 presence UPDATEs | no row locks, atomic sequence reservation, throttled presence (1 write / 10 s) |
| Input drain (per movement tick) | transaction + match row lock **even with an empty queue** | one indexed read; returns immediately when idle |
| Lobby read (`GET /api/rooms/current`) | **room row lock**, unconditional member `mark_seen!` write, global room sweep | lock-free payload, throttled presence, read-only sweep fast path |
| Snapshot cadence | fixed 10 Hz, unrelated to the tick rate (duplicate frames at slow speeds, dropped ones at fast) | **exactly one frame per movement tick** + a 1 s keepalive |
| Renderer paint | `getComputedStyle` + `getBoundingClientRect` **every frame**, grid re-stroked, scoreboard `replaceChildren` at 60 fps while frozen | theme/geometry cached, grid blitted from an offscreen layer, in-place scoreboard diffs, 20 fps label-only animation |
| Standings/results tables | full `<table>` rebuilt at 10 Hz, even when hidden | signature diff, skipped while hidden |
| Roster | `innerHTML` rebuild on every poll/event | repaint only when visible state changes |

Two further latency reductions:

* waiting direction intents are applied to the in-memory queue on **every
  scheduler pass**, not only immediately before a movement tick, removing up to
  one full tick (165 ms at Chill) of steering delay;
* a reconnecting socket is seeded from the **in-memory world owned by this
  process** when available, so the first frame after a resume is current to the
  tick rather than up to 2 s old; the 2 s durable frame remains the fallback
  for another process/after a crash.

## Rendering model: discrete and grid-locked (no tweening)

Snake is a grid game. A snake occupies whole cells and jumps exactly one cell
per logical tick, so the renderer draws **precisely what the newest
authoritative frame says, snapped to the grid, the moment it arrives**. There
is deliberately:

* **no interpolation / easing** between ticks,
* **no client-side prediction**,
* **no reconciliation smoothing**.

Tweening between two ticks is actively harmful here: it holds every frame back
by up to a full tick, and whenever a frame is late or a server value differs
from the tween's destination the snake visibly slides and then snaps —
rubberbanding. Crisp cell-to-cell movement is simultaneously the correct
classic look and the lowest-latency one.

The server side of the same contract is that broadcasts are **tick-aligned**:
`publish_snapshots` emits a frame when `world.tick` (or the status) actually
changed, plus a 1 s keepalive for an idle board. The client's visual cadence is
therefore identical to the simulation's — no duplicate frames to discard, no
missing ticks to paper over, and the least possible traffic. A regression test
pins this: 40 scheduler passes over 800 ms of simulated time produce exactly
one frame per advanced tick (8 frames for 8 ticks), in order, with no repeats.

Cell rectangles and 1 px grid lines are drawn on whole/half pixel boundaries so
the board stays sharp instead of blurred by sub-pixel placement.

The only continuously animated element is the red loading ring on a
disconnected player's head (20 fps, only while somebody is frozen, disabled
under `prefers-reduced-motion`). Snakes themselves never animate between ticks.

Every direction intent is sent: the server de-duplicates its own direction
queue and the input path no longer takes a lock, so dropping a keypress
client-side could only ever lose a real turn.

## Mobile: why it still lagged after the desktop pass

Three phone-specific causes, all fixed:

* **Swipes only turned the snake on finger lift.** A `pointerup`-only handler is
  subject to the browser's gesture/scroll recognition, so a fast flick could be
  delayed by a few hundred milliseconds or lost to a `pointercancel`. A drag now
  turns the snake the moment it crosses 20 px, once per direction per gesture,
  and the lift is only a fallback for a short flick.
* **The steering pad used `click`.** On touch that pays tap-delay and
  double-tap-zoom heuristics. It now fires on `pointerdown` (with
  `preventDefault`), while `click` with `detail === 0` still serves keyboard
  activation, so accessibility is unchanged.
* **The URL bar caused a re-rasterise storm.** Showing/hiding the mobile browser
  chrome fires `ResizeObserver` repeatedly, and each event rebuilt the grid
  layer and resized the backing store. Measurements are now coalesced into one
  per frame and sub-2 px changes are ignored. The canvas backing store stays
  capped at dpr 2, so a 3× phone does not paint nine times the pixels.

`touchmove` is additionally guarded with a non-passive `preventDefault` on the
arena only, for browsers without `touch-action` support, so a swipe can never
scroll the page instead of steering.

Rendering cost was reduced further: the scoreboard and standings signatures are
built by concatenation instead of `JSON.stringify` (they run every tick), and a
hidden scoreboard skips DOM work entirely.

## Never dependent on a single player (and never ending early)

Tabbing away used to be able to end the round for everybody. Two independent
causes:

1. **A socket worker could block on the simulator.** The reconnect seed encoded
   a frame while holding the runner mutex. The simulator holds that same mutex
   across database work, and the pool was only `threads + 4`, so a worker could
   wait on the mutex while holding a connection the simulator needed. Blocked
   cable workers stop heartbeats for *everyone*, every snake freezes at once,
   and the board looks dead.
   Fix: the owner caches the frame it just broadcast; a subscribing socket reads
   that hash with **no lock, no database and no encoding**, and falls back to the
   durable frame when another process owns the match. There is no longer any
   client-to-simulator lock coupling.
2. **The round clock ran while nobody could move.** The 180 s duration limit was
   measured against the raw tick counter, so an all-frozen board counted down to
   a finished match. `World` now tracks `active_ticks`, which advances only when
   at least one alive snake could actually move: an idle or fully frozen lobby
   **pauses** instead of timing out, and no result is produced for a game nobody
   could play.

Two structural changes remove the remaining client dependencies:

* **Lobby maintenance runs on the server clock.** Presence expiry, host
  succession and idle expiry previously happened only inside client requests, so
  the room's bookkeeping waited on some player's browser still polling. The
  simulator loop now sweeps every 15 s.
* **A room can no longer be stranded in_match.** A match with no recoverable
  checkpoint used to be `abandoned`, which left the room in `in_match` with no
  live match: the exact stuck state players described as "it froze and ended".
  It is now `interrupted` (no standings, no winner) and `Room.heal_stranded_matches!`
  returns any room whose match died to the lobby, reseats players and clears
  spectator flags — driven by the server, with no request required.

The lease was also widened from 6 s to 20 s with a 4 s renewal interval, so a
single slow database round trip can no longer make a healthy owner lose a live
match.

No match-ending decision is keyed to a specific player: the host role gates
starting, rematching, board changes and disband only — all explicit actions.



| Constant | Default | Why |
| --- | --- | --- |
| `MatchRunner::SNAPSHOT_KEEPALIVE_INTERVAL_MS` | 1_000 | re-sync frame for an idle/paused board (frames are otherwise tick-driven) |
| `MatchRunner::SNAPSHOT_PERSIST_INTERVAL_MS` | 2_000 | durable seed for reconnects/crash recovery |
| `MatchRunner::CONNECTION_SYNC_INTERVAL_MS` | 150 | freeze/resume imperceptible, cheap |
| `MatchRunner::INPUT_POLL_INTERVAL_MS` | 30 | steering latency floor |
| `MatchChannel::PRESENCE_WRITE_INTERVAL_SECONDS` | 10 | presence window is 90 s |
| `RoomMembership#mark_seen_throttled!(interval:)` | 15 s | polls no longer write every time |
| Puma `RAILS_MAX_THREADS` default | 8 | sockets + polls + channel actions |
| simulator idle/live sleep | 250 ms / 20 ms | ticks land on time when it matters |

## Regression guards

`test/models/multiplayer_performance_test.rb` asserts the SQL **shape**:

* an idle simulator pass contains no `FOR UPDATE`, no per-participant reload and
  no `UPDATE matches … live_snapshot`, within a bounded query count;
* `sync_connection_states!` performs no writes and exactly one participants
  read when everybody is connected;
* `accept_direction!` performs no `FOR UPDATE` and a bounded number of queries;
* broadcasts stay ≤1 durable write across 15 passes, and frames map **1:1 to
  movement ticks** (no duplicates, correct order, never scheduler-paced);
* five presence heartbeats produce at most one `UPDATE`.

`test/controllers/api/lobby_read_performance_test.rb` asserts a real
`GET /api/rooms/current` takes no row lock and remains bounded, and that a
write immediately afterwards still works.

Full suite for this commit: **311 runs / 1642 assertions / 0 failures**, plus
the standalone engine suites (37, 14 / 9 and 9 runs; the duration-pause
guarantees are covered in `test/simulation/reconnection_test.rb` and the
independence guarantees in `test/models/match_independence_test.rb`). Nothing
sleeps on a wall clock: the "40 simulated seconds of total silence must not end
a round" test drives `MatchRunner.tick_once` with injected monotonic and wall
clocks.

### Mobile follow-up: profile, not another "smoothness" guess

The user could still feel lag on a phone after the preceding CSS/input changes.
A real two-phone, 4x-CPU Pixel 7 profile pinned `drawScoreboard` as the largest
JS hotspot; the canvas was not the authoritative problem. The fix is a
1 Hz presentation budget, not a slower simulation or a client-owned movement
loop. Each tick still paints its authoritative snapshot, and the server
still owns input, survival, freeze, grace, scores and results. The body is
one filled path; the status and HUD are only patched when their displayed
value changes. The browser is no longer forced to lay out the full page while
a steady snake is still on the wire.

`play-budget.js` is a small dependency-free task sampler with an injected
clock. It is a **DOM budget**, not a scheduler; direction inputs bypass it.
`MultiplayerGameRenderer` uses that sampler for the secondary HUD and a
separate stateful visibility flag instead of reading `offsetParent` during a
paint. On a coarse pointer the board paints over an opaque panel, with CSS
containment to keep unrelated layout away from the input path.

A server-side guard forces the queue drain before EVERY tick boundary: the
ordinary 30ms inter-tick poll is still throttled, but a fresh direction just
before a tick can never be acknowledged and then wait a whole extra tick.

See `multiplayer-step-10-mobile.md` for the measured CPU trace, the exact
behaviour, the test commands and the limits of the phone/network benchmark.
