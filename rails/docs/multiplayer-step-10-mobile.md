# Step 10 mobile follow-up — phone latency without grid interpolation

## Root cause found, not another tuning guess

A **real two-phone Brawl** was profiled in Chromium with a **Pixel 7 viewport**,
a **3x device pixel ratio** and **4x CPU throttling**. The canonical Rails
server and its Action Cable/PG adapter were real; there was no mocked game
engine in this test.

The original phone trace had one big, consistent hotspot: `drawScoreboard`.
It ran with the received frame tick, immediately invalidated the scoreboard
and repeatedly re-announced the same values. The server continued to broadcast
10 frames/sec at Normal; the phone spent *all* of that work re-laying out a
semantic table whose visible survival time changes only once a second.

The resulting UI was not a server movement problem. It was main-thread work
attached to a stable value. Performance traces are included in the test
notes but timings depend on the host, browser, GPU and network; they are **not**
a promise of a particular phone or network's latency.

## Measured changes (4x-CPU Pixel 7 session)

| Check | Before | After |
|---|---:|---:|
| `drawScoreboard` CPU-profile hits | 65 | 3 |
| Layout passes in the same instrumented window | 104 | 33 |
| Repeated style recalculations | 210 | 206 (but fewer writes/old DOM creations) |
| Steady-state DOM mutations in measured interval | 2856 (whole page/run) | 167 (warmup excluded) |
| Long tasks during steady-state run | 2 (initialisation) | 0 |
| Authoritative frames painted | 71 | 74 |
| Real native touch taps | 12 | 12 |
| Touch-to-server-ack (localhost, CPU-throttled) | n/a | 12–58ms (12/12 accepted) |

The steady-state counter is **not** a percentage of visual frames. The DOM
initialisation and the first paint were explicitly excluded in the later run;
the original 2856 mutations included page mount. The CPU samples are samples,
not wall-clock performance measurements. The important regression guards are
structural: the mobile renderer's HUD changes at most once/sec, and a movement
tick never has to wait on a DOM change.

## What changed

### Presentation budget, never game authority

`public/multiplayer/play-budget.js` is a testable, clock-controlled **presentation
scheduler**. It batches the secondary HUD (scores, survival, tick readout) to
1 Hz. The canvas still paints every authoritative snapshot in exactly the
order the server sent it. No interpolation, prediction, easing, body tampering
or client-owned tick counter was reintroduced.

The `MultiplayerGameRenderer` holds the render budget, has a stateful visibility
flag and never reads `offsetParent` in the tick path — that read used to force
a layout when the page's DOM was dirty. Each row is patched in place, and
unchanged text/class/style are not reassigned. The `play-budget` text guard
also avoids repeating the identical ARIA status in a screen-reader queue.

* A completed round or a significant connection/spectator transition flushes
  the relevant HUD immediately, so a one-second budget never postpones an
  ending or a recovery notice.
* A hidden tab stops the HUD clock and resumes from a fresh authoritative
  snapshot on visibility. This is not a freeze timer — the server still owns
  grace, points, movement and results.

### Body paint is grid-locked and one shape

A snake's body is batched into ONE filled canvas path instead of one drawing
command per body cell. The double white + accent head ring is separate, so
following one's own snake does not add extra body work.

### Mobile containment and effects

* `.mp-game` has `contain: layout paint style` on coarse pointers.
* The game pane gets an opaque `var(--panel)` background so translucent glass
  no longer recomposites the page behind it on every frame.
* Backdrop-filter is removed for the phone's live panel/cards, and the
  Matrix rain background is suspended for a live match (the selected theme is
  not changed).
* The scoreboard and status/tick readouts only update once/sec. `aria-live` on
  `mp-game-tick` is off; connection/spectator/status still use real state.
* Touch controls keep their normal appearance while they get >=48px hit
  targets; `pointerdown` / the 20px swipe threshold are still immediate.

### Turns cannot skip a tick just because the input poll was recent

At an ordinary pass, `MatchRunner#deliver_inputs` still uses a 30 ms throttle so
multiple clients cannot turn into a query storm. At a **movement-tick
boundary**, it is now forced: `deliver_inputs(world, force: true)` drains the
pending queue before `World#step!` every time. A tap acknowledged close to the
boundary cannot be left for the *next* logical tick (105 ms at Normal and
165 ms at Chill).

This change is server-owned, not predictive. There are two Rails regression
tests, one for the tick-boundary turn and one for the independent inter-tick
throttle. The pure engine / world / collision / freeze / recovery rules are
unchanged.

## Tests

* `tests/mobile-performance.test.mjs`: six clock-controlled budget tests, plus
  the real renderer with a fake clock/DOM: twenty authoritative frames all
  paint; no DOM writes until the scheduled HUD pass; one second of survival
  changes only one set of labels; hidden tabs do no HUD work; terminal results
  and important connection changes can flush immediately. No test sleeps.
* `TickBoundaryInputTest` in
  `rails/test/models/multiplayer_performance_test.rb`: near-boundary command
  is consumed in the *same* tick even when the opportunistic poll just ran.
* Existing standalone engine/reconnect suites all remain green, including
  frozen-time survival ties, self-collision and spectator recovery.
* The canonical full Rails suite remains green: 313 runs / 1650 assertions /
  0 failures, and 22 shared JavaScript + mobile tests.

## Manual verification on a phone

From the canonical `rails/` directory, run the real server and simulator. Use
separate browser contexts (same browser tabs would be *one identity*), start a
Brawl and profile a 10 s steady-state session at 4x CPU. Start the trace after
the room settles and each participant has its own initial snapshot.

Measure the movement tick `data-tick` and the **input_ack sequence** with
`Network.webSocketFrameSent/Received`, not a page's `Date.now` before the
connection handshake. A phone's private network and a far-away Cloudflare
Tunnel can add real RTT; a UI-only change cannot erase that. If measured latency
remains on the wire, report that separately rather than treating it as a
movement or rendering fault.
