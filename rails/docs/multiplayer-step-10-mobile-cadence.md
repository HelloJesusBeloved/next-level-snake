# Step 10 mobile follow-up 2: diagnose arrival cadence, not just draw cost

**Apply after `step-10-performance-mobile.patch`.** This is a separate add-on
commit, not an amended replacement of either installed performance patch.
No schema, game-rule, ranking, protocol-version, transport or Duel changes.

## What the previous measurements did not establish

The earlier patch claimed that a 5ms polling sleep guaranteed ±2ms tick timing,
and that replacing a grid texture made its draw take a universal 0.01ms. Those
claims were not supported. Sleeping happens *after* database work; browser
canvas API calls also do not measure physical scanout or handset GPU cost.
The synchronous `requestAnimationFrame` mock in the old unit test could not
expose frames that arrive together and are never individually visible.

The installed mobile patch was reconstructed on pushed HEAD `374d190`, then
profiled before changing rendering. On Chromium with a Pixel 7 viewport/DPR
and 4× CPU throttling, draw cost was already about **0.7ms p95**. No steady-state
long tasks explained the remaining motion hitches. With a 105ms server tick,
ordered snapshot arrival gaps ranged from **3.5ms to 331ms** under injected
Wi-Fi-style jitter. Repainting those frames synchronously cannot make them
arrive evenly and wastes work on frames that share a display opportunity.

A second failure was reproduced in WebKit: server packets continued to arrive
but its headless animation callbacks sometimes stalled for 90–169ms. This is a
browser-engine observation, **not certification of a physical iPhone**.
Finally, multiple active matches exposed the cost of querying on a fixed 5ms
poll. A test runner had also leaked 18 matches; that contamination was found,
removed, and replaced with an explicit, reproducible multi-room load scenario.

## Research used

- [MDN: WebSocket](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket):
  ordered messages have no receive-side backpressure; browser queue work can
  grow. A latest-frame queue is not a replacement for network backpressure.
- [MDN: canvas optimization](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas):
  opaque contexts, batching, and separating receive from rendering. Neither
  "always drawImage" nor "never drawImage" is universally faster.
- [Chrome: low-latency desynchronized canvas](https://developer.chrome.com/blog/desynchronized):
  the hint can tear/flicker and does not promise latency. This patch uses an
  opaque context but deliberately does **not** force desynchronized rendering.
- [Gaffer: network jitter](https://gafferongames.com/post/state_synchronization/#jitter-buffer):
  regular sends do not imply regular receives. Only the whole-packet spacing
  concept is used here, NOT client simulation, extrapolation or interpolation.
- [MDN: iterator map compatibility](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Iterator/map):
  `Map.values().map()` is newer than the rest of this app. It was replaced by
  `Array.from` and tested with iterator helpers removed.

## Deployment/cache issue also found

The live origin sent `Last-Modified` but **no Cache-Control** for multiplayer JS.
The entry point still requested `page.js?v=step6`, which imported
`lobby.js?v=step6` and `game-renderer.js?v=step8` across every performance patch.
Cloudflare [documents](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/)
that static assets can be cached for two hours without explicit origin TTL;
its [standard cache key](https://developers.cloudflare.com/cache/how-to/set-caching-levels/)
includes query strings. A cached old module can therefore survive a deployment.
That is a verified cache-invalidation defect, **not proof of a cache hit on the
user's particular phone**.

The HTML CSS/script URLs and complete custom import chain now carry
`step10-cadence2`; diagnostics prints the actual renderer release. The profiler
also discovers the loaded resource URL instead of importing an old-versioned
copy of the renderer and accidentally instrumenting the wrong class. If an
operator explicitly configured Cloudflare to ignore query strings, purge those
assets or use the standard cache key. No CDN account or credentials are needed
for this patch. Never cache the authenticated room API or `/cable`.

## What changes

### 1. Whole server frames, never fractional snake positions

`GridCadence` is a bounded presentation queue (three frames maximum). On coarse
pointers it learns short-term arrival variation over at most 48 samples. Clean
links have no intentional hold. If variation exceeds ordinary sub-frame noise,
it can hold a received frame **at most min(50ms, half the tick interval)**,
then submit it on a display opportunity. The phase changes by at most 4ms per
received tick rather than jumping the display clock on every packet.

This is an explicit trade-off: ordinary straight movement can gain up to that
small hold plus one display refresh. It is not free latency reduction. A
**confirmed own turn, score change, freeze/unfreeze, elimination, reconnect or
result** bypasses it and is submitted immediately. Local input also releases
any held frame, but the requested direction is never displayed until the
server confirms it. Inputs always read the newest **received** snapshot,
not the delayed visual frame. Desktop defaults to immediate mode.

No future position is generated. Every displayed body is the original complete
server frame. No lerp, easing, prediction, body correction or fractional cells.
After long stalls, missing ticks, TCP bursts, disconnect, hidden-tab suspension
or rematch, stale queued history is discarded rather than played back as a
rubberbanding catch-up animation.

### 2. One ordinary canvas submission per refresh; delayed-rAF escape hatch

Ordinary packets update receipt state immediately and coalesce their paint at
the next refresh. A `FrameGate` races that callback against a **32ms display-only
watchdog**, so delayed animation callbacks cannot retain an already-received
frame indefinitely. Whichever runs first cancels the other; teardown and tab
hide cancel both. Operating-system event-loop stalls can still delay both.

The watchdog does not advance the world, decide death/freeze/grace, reconnect
a socket, or fabricate data. Actual scanout remains under browser/OS control.
Confirmed critical updates bypass this gate too. Context creation happens once
with `alpha:false`; no desynchronized/flicker-prone path is requested.

### 3. Server waits for a deadline, not five milliseconds after work

Puma and the standalone simulator use the same `MatchRunner.next_wake_ms`.
It chooses the earliest movement/input-poll deadline and subtracts elapsed
work from it. Between ticks the input poll remains bounded at 30ms; directly
before movement the existing forced input drain remains in place. Idle servers
wait 250ms, and a 1ms floor prevents an overdue loop from busy-spinning.

This reduces gratuitous claim queries and load-induced timing variance. It
cannot guarantee exact timing under arbitrary CPU/DB overload. No player's
browser, host role, or heartbeat drives the scheduler.

### 4. Local Movement diagnostics instead of invisible assumptions

Open **Movement diagnostics** below the controls to see:

- server tick intervals vs snapshot arrival gaps;
- delivery variation vs canvas draw cost;
- last received/displayed tick, last packet age, received-to-draw time;
- queued/coalesced frames, server tick gaps and delayed display callbacks;
- the actual context attributes the browser accepted.

The checkbox disables pacing for direct comparison. It is not a gameplay
setting and sends no network request or telemetry. The collapsed panel does no
continuous diagnostic DOM work; an open panel samples locally at 1Hz, including
when transport stalls. Cross-machine clock offsets cancel in interval
comparisons, but these numbers are **not one-way network latency**.

## Reproducible results

Run the committed `scripts/profile-brawl-cadence.mjs` against **production
Rails**, not the preview starter. It creates distinct guest identities, uses the
real simulator and PostgreSQL Cable adapter, and cleans up its rooms even on
failure. It supports native touch, Chromium CPU throttling, WebKit, nine
simultaneous rooms and an eight-player party. `JITTER=1` delays the actual
messages without reordering: all later messages, ACKs included, wait behind an
earlier held message. No gameplay packet is invented by this harness.

```
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3100 CPU_RATE=4 SPEED=3 JITTER=1 \
  OUTPUT=/tmp/paced.json node scripts/profile-brawl-cadence.mjs
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3100 CPU_RATE=4 SPEED=3 JITTER=1 PACING_OFF=1 \
  OUTPUT=/tmp/immediate.json node scripts/profile-brawl-cadence.mjs
BROWSER=webkit PLAYWRIGHT_BASE_URL=http://127.0.0.1:3100 \
  node scripts/profile-brawl-cadence.mjs
EXTRA_ROOMS=8 SPEED=6 node scripts/profile-brawl-cadence.mjs
PLAYERS=8 CPU_RATE=6 SPEED=6 node scripts/profile-brawl-cadence.mjs
```

Selected observed results (local virtualized sandbox, not a handset guarantee):

| Case | Installed patch / pacing off | This follow-up |
|---|---:|---:|
| Full-FIFO jitter, mean visible spacing error at 105ms | 37.3ms (off) | 18.1ms (on) |
| One room, server tick p95 | 109ms | 106ms |
| Nine rooms at 42ms, server tick p95 | 57ms | 48ms |
| Nine rooms at 42ms, max observed display gap | 100ms | 66.7ms |
| WebKit, max observed display gap | 275ms | 188ms |
| Confirmed turn receipt→canvas submission | not isolated before | 0–1ms in the final samples |
| Eight-player party, 6× CPU, draw p95 | not isolated before | 0.8ms |

Whole-frame pacing added up to about 63ms receive-to-draw at p95 in the jitter
runs (50ms hold plus display opportunity). That trade-off is intentionally
visible and switchable. A 220ms injected transport stall still produced a long
pause: there is no honest way to show the missing authoritative state without
prediction or waiting. The solution does not claim to remove mobile network
latency, make a 105ms grid game move at 60 steps/sec, or control physical screen
scanout. Quantization to 60Hz itself yields 100/116.7ms display intervals.

Compact raw summaries live in `measurements/step-10-mobile-cadence.json`.
Captured arrival-only traces (no names, tokens or game bodies) are replayed at
simulated 30/60/120/144Hz in the deterministic regression tests.

## Validation

- **319 Rails tests / 1,657 assertions**, 0 failures. Six new deadline cases
  cover idle, already-spent work, overdue clock, input polling and multiple
  worlds without any client leader.
- **50 JavaScript tests**, 0 failures. Includes asynchronous renderer testing,
  captured-trace replay, bounded queue/hold, no future cells, turn/death/freeze
  bypass, same-tick corrections, hidden tab, rematch, older mobile iterator
  compatibility, and no duplicate watchdog paint. No 30-second test sleeps.
- Existing Brawl browser suites: **17 passed, one desktop-inapplicable test
  skipped**, both mobile and desktop projects.
- Production Rails probes: Chromium clean/jitter/fast/eight players/nine rooms
  and WebKit, with no page JavaScript errors. WebKit here is a Linux software
  browser engine; physical mobile hardware still needs on-device confirmation.
