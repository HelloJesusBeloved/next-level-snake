# Step 10 — mobile performance follow-up 3

Base: **pushed HEAD `c5ed785`**. Apply `step-10-performance-mobile-3.patch`
with `git am`. This is one add-on commit. No schema change, Duel implementation,
client movement/prediction, or new preview game.

## What we measured, rather than assumed

The existing `scripts/profile-brawl-cadence.mjs` was run against the real Rails
server, PostgreSQL Action Cable adapter, separate guest browser contexts and a
Pixel 7 viewport at **4× CPU throttle**. Clean, ordered FIFO network jitter,
pacing-disabled, and nine concurrent 42 ms matches were measured before edits.
The same cases (and a WebKit/iPhone-emulated run) were repeated after edits.
These numbers are local virtualized-browser observations, **not physical phone
scanout or a Cloudflare RTT guarantee**.

| Case | pushed HEAD `c5ed785` | this add-on, observed |
| --- | ---: | ---: |
| Clean, Normal: receive → draw p95 | 33.8 ms | 0.5 ms |
| FIFO jitter, Normal: receive → draw p95 | 60.8 ms | 0.8 ms |
| FIFO jitter: visible spacing p95 | 133 ms | 167 ms |
| Nine rooms, Ludicrous: server tick p95 | 69 ms | 52 ms |
| Nine-room server probe: claim queries / 100 passes | 101 | 11 |
| Nine-room server probe: presence queries / 100 passes | 72 | 6 |
| Nine-room server probe: pass p95 | 42.7 ms | 31.3 ms |
| WebKit-emulated: receive → draw p95 | not isolated in baseline | 1 ms |

The 100-pass probes cover different elapsed durations and step counts; their
per-pass/query observations are not a production throughput benchmark. Jitter
spacing can be **less even** when latency is removed. The existing checkbox
still provides opt-in smoothing for players who prefer that tradeoff. No client
can produce frames that have not arrived or erase real network stalls without
prediction, which this project explicitly does not use.

## Root cause 1: avoidable presentation hold

`GridCadence` was enabled by default for every coarse pointer. Even on a clean
link its phase/nominal deadline can hold an ordinary received frame until the
next tick (bounded to 50 ms/half a tick), plus a display callback. Its
`FrameGate` raced that callback with a 32 ms watchdog. These are real
receive-to-draw delays, not faster movement. The opt-out measurements showed
about 15 ms p95 under jitter; direct display of received *whole* frames reduces
that to below 1 ms of CPU draw in these local tests.

Mobile now defaults to **lowest-latency mode**: after every complete server
snapshot arrives, the renderer immediately presents exactly its integer grid
cells. No tweening, interpolation, prediction, speculative turns, or browser
freeze timer. A player may opt into smoothing via Movement diagnostics; its
label now says explicitly that it can add delay. Desktop's ordinary display
path and all server-owned gameplay transitions remain unchanged. New tests
check immediate default, opt-in hold, terminal frames, and stale-frame rejection.

## Root cause 2: PostgreSQL silently stopped broadcasting long snakes

The production adapter publishes each frame through `NOTIFY`. PostgreSQL's
[documentation](https://www.postgresql.org/docs/current/sql-notify.html) specifies
a hard **<8,000 byte payload**; the
[Rails Action Cable guide](https://guides.rubyonrails.org/action_cable_overview.html#postgresql-adapter)
notes the same limit. This was reproduced on the actual adapter: eight Brawl
snakes with 250 cells each produced an **8,946-byte snapshot** and raised
`PG::InvalidParameterValue: ERROR: payload string too long`. The simulator kept
moving and the client got no new board frames, which feels like mobile lag or
a frozen game. The previous patches did not fix this case.

Small snapshots keep the exact existing wire format. Oversized snapshots are
serialized with ASCII-safe JSON (so a UTF-8 name cannot be split mid-codepoint),
sliced into 3 KB fragments and sent as ordered `snapshot_chunk` messages. Each
fragment's actual Rails JSON-encoded notification stays below 8 KB. The
browser bounds memory/part counts, validates match/tick/order, and passes only
a **fully assembled authoritative snapshot** to the existing renderer and
controls. Lost/out-of-order chunks are discarded, not partly displayed or
replayed on reconnect/rematch. The same large broadcast succeeded over the
real PostgreSQL adapter after the fix. A manual cross-process browser test
published a server-side >8KB frame to a connected Pixel 7-emulated page: three
wire chunks arrived and the page displayed the full eight-player frame.

This is a guard against the adapter limit, not a claim that broadcasting huge
frames at 24 Hz scales indefinitely. The Rails docs and the
[MDN canvas optimization guide](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas)
warn that canvas optimization cannot repair missing network data; neither
compression nor a new pub/sub service is introduced in this step.

## Root cause 3: unnecessary server work before ticks

The runner queried *every* live match for free claims on every 1–30 ms wake,
polled inputs between ticks **and** force-drained them immediately before a
tick, and scanned all connected participants every 500 ms even if no socket
was stale. The nine-room probe identified these as periodic pass-time spikes.

* Free-claim scans are capped to one every 250 ms; the first claim remains
  immediate. Match ownership and fenced writes are unchanged.
* Only the forced pre-tick input drain remains in the hot path. Every accepted
  turn still reaches the **same next authoritative tick**; there is no client
  timer, and the server still owns the queue. Opportunistic duplicate reads
  no longer compete with movement.
* Frequent presence reconciliation targets rooms with stale socket rows.
  A 5 s full server-controlled backstop still catches sockets whose database
  row vanished with no unsubscribe callback. The ordinary disconnect callback
  remains immediate and still accounts for multiple tabs.
* Orphan recovery and idle-room sweeping run **after** movement and broadcast,
  so housekeeping cannot postpone an already due authoritative frame. Host
  grace, 30 s freeze, crash recovery, preserved results and rematch behavior
  are unchanged.

## Verification

* `bundle exec rails test`: **326 runs / 1,704 assertions**, no failures.
* `node --test tests/{grid-cadence,grid-renderer,mobile-performance,snapshot-chunks,shared-game,container-config}.test.mjs`:
  all green. The JS snapshot fixture was generated by the Rails serializer,
  including a Unicode player name. Tests cover missing/out-of-order parts,
  stale matches, corrupt data, memory bounds and recovery on the next frame.
* Real Rails browser tests: **17 desktop/mobile Brawl passes**, 1 intentional
  desktop-only skip. The shared-clock assertion now compares per-snapshot
  `data-tick`, not the deliberately sampled 1 Hz display label.
* Real PostgreSQL pub/sub: before **8,946 bytes → `payload string too long`**;
  after **>8 KB → 3 bounded chunks → full eight-player frame**.

All automated freeze/clock tests use injected clocks; none sleep for 30 real
seconds. The browser profiling runs use real wall time solely to measure the
actual browser/server path.
