# Step 8 — Functional synchronized Brawl gameplay

Base: `841e2242ad1e5f3ddee2be719472b59d35b1c6f1` (step 7 review).
This step connects the authoritative engine to the real multiplayer page and
makes a Brawl playable between separate browsers. It does not add Duels,
death animations, a spectator UI, or persistent room leaderboards.

## What is now playable

1. The host presses **Start Brawl** (`POST /api/rooms/:code/start`). Ready votes
   stay advisory. The room model re-checks host + eligibility inside the room
   row lock and freezes board dimensions, participants and their solid colors
   into a durable `Match` + `match_participants` rows.
2. Every eligible player gets an independent server-authoritative snake in
   their assigned color, and **their own food object** rendered in that color.
   Eating it: +1 point, +growth segments, and a replacement food spawns on a
   free cell (never on a snake; never loops forever — `pick_free_cell` returns
   nil on a full board).
3. Brawl opponents are **non-solid**: passing through another snake has no
   effect. Touching or overlapping another player's food has no effect and never
   consumes it. Only self-collision eliminates a snake. Wrapping, movement
   speed presets, growth and direction-queue rules match the verified
   single-player engine (`public/game.js`).
4. The room's board rules from step 6 still apply: mobile/unverified
   participation forces the 24×18 single-player default; the frozen dimensions
   are immutable for the running match; late joiners spectate and never enter
   the simulation.
5. When one or zero snakes remain, the round finalizes immediately — no
   unlimited point farming. Standings are **final points first**, survival
   ticks second, longest snake third, participant id as the explicit stable
   tiebreak. The last survivor is NOT automatically first (pinned by tests:
   an eliminated 9-point snake beats a 2-point survivor).

## Synchronization architecture

```
Browser A/B ──cable──▶ MatchChannel (auth: frozen participant rows)
                 │            │ input(data) → Protocol.parse_input (dir only)
                 │            ▼
                 │     Match#accept_direction! → match_inputs row (durable queue)
                 │            │
Puma master ────▶ MatchRunner.tick_once (50 ms loop, monotonic clock)
                 │     claim lease → build/restore world → Supervisor.tick!
                 │     before each logical tick: owner drains match_inputs
                 │     world.step! (discrete ticks, capped catch-up)
                 │     checkpoint every 20 ticks (atomic input acknowledgement)
                 │     publish live_snapshot + broadcast at 10 Hz
                 ▼
Browser A/B ◀─cable── full versioned snapshots {v,m,s,t,b,p,f,w,q}
```

Key properties:

* **One authoritative owner per match.** The PostgreSQL lease from step 7
  arbitrates; the supervisor renews it on a 2 s interval and stops simulating
  the moment a fenced write is refused.
* **Inputs never drive timing.** Direction commands are small durable rows
  consumed by the owner immediately before each logical tick. A slow or
  hostile client cannot speed up, slow down, or corrupt the shared simulation.
  Replayed/stale sequences are rejected; `seq` is consumed by any valid
  envelope, even an ignored turn, so one sequence cannot be replayed with a
  different direction.
* **Snapshots are decoupled from ticks.** `matches.live_snapshot` is persisted
  and broadcast at 10 Hz (independently of the 40–1000 ms movement tick), so a
  reconnecting `MatchChannel` bootstraps from one complete authoritative frame
  instead of replaying deltas. The browser renderer only draws what it receives
  and never predicts or advances state.
* **No per-tick database writes.** PostgreSQL sees input commands, the 10 Hz
  snapshot, the throttled lease renewal, and checkpoints every 20 ticks.
* **The simulator runs once per Puma instance** from `after_booted` in the
  master process (never per request/worker). Multiple Puma instances are safe
  because the lease arbitrates. Set `MULTIPLAYER_SIMULATOR=false` if an operator
  runs `bundle exec rails multiplayer:simulate` as a separate supervised
  process instead. `after_stopped` releases leases for immediate takeover.

## Client

* `public/multiplayer/game-renderer.js` — a dedicated canvas renderer. It
  validates the snapshot envelope (protocol version, integer tick, board
  bounds, cell indexes), drops stale/reordered frames by tick, draws each
  snake in its server-assigned color, draws food in the owner's color, and
  outlines the player's own head in white + theme accent. It follows theme
  changes and devicePixelRatio, and redraws on resize.
* `public/multiplayer/lobby.js` — subscribes to `MatchChannel` once the caller
  is a frozen participant, renders snapshots + standings, and sends only
  `{v,type,match,tick,seq,dir}` on key (arrows/WASD), swipe, or the on-screen
  steering pad (mobile). The key handler ignores form fields, buttons and
  dialogs so it never hijacks username inputs or other controls.
* Standings show placement, color, name and points (names always supplement
  color for accessibility).

## Protocol (version 1, extended)

Snapshots now include `w` (winner participant id) and `q` (standings array:
participant id, placement, score, survived ticks, longest length). Inputs remain
strictly `{v,type,match,tick,seq,dir}`; positions, bodies, scores, lengths,
winners and player ids are rejected as `forbidden_field`.

## Tests actually executed

* **Rails (253 runs / 1,300 assertions, 0 failures)** on Rails 8 + PostgreSQL,
  including a fresh `db:schema:load`:
  * Brawl rules (pure engine, no Rails): per-player colored snakes + owned
    food; eating scores/grows/respawns; pass-through no-effect; foreign food
    never consumed or scored; self-collision elimination; point-first ranking
    with eliminated winner; no post-completion farming; fair non-overlapping
    spawns across seeds; no infinite spawn loop on a full board.
  * Host start: creates durable match, freezes board/colors, host-only,
    second start refused, lone host refused.
  * Input queue: monotonic sequences, replay rejection, cross-room rejection,
    authority-field rejection, owner-only drain, checkpoint acknowledgement.
  * Runner: 10 Hz snapshot persistence with tick/colors/food/standings,
    completion finalizes standings + room results, garbage/refresh isolation.
  * `MatchChannel`: participant-only subscription (stranger/late-joiner/
    unknown match rejected), direction ack, replay/invalid/forbidden refusal.
* **Standalone engine suites without Rails:** world 37, scheduler/protocol 10,
  supervisor 9, brawl rules 9 — all green.
* **Real browser (Playwright + Chromium against production Rails with the
  live simulator):** new `tests/browser/brawl-gameplay.spec.mjs` — two separate
  browser contexts play one Brawl: canvas + standings sync, tick clocks match,
  keyboard + swipe + D-pad steering, mid-match refresh reconnects, no page
  errors. Desktop 2 passed / 1 intentionally skipped (mobile-only D-pad test),
  mobile 3 passed.
* **Existing suites:** multiplayer + configuration browser suites 35 desktop
  and 38 mobile passed; single-player `game.spec.mjs` 14 passed / 6 skipped /
  0 failures (unchanged baseline); `shared-game` + `container-config` Node
  checks 20/20.
* Production checks: `zeitwerk:check`, eager load, fresh schema load, and a
  live two-client smoke over real WebSockets.

## Limitations / for later steps

* Death animations, spectator UI, persistent room leaderboards and Duels are
  intentionally not in this step.
* Input acknowledgements are checkpointed every 20 ticks: a process crash can
  replay up to 20 ticks of acknowledged directions from the previous
  checkpoint (at-least-once steering, never a lost command).
* `MULTIPLAYER_SIMULATOR=false` is available if you run the simulator as a
  separate supervised process; both paths are lease-safe.
* Real-device feel (input latency, 60 fps smoothness) should be verified on
  actual phones/desktops; broadcast cadence (10 Hz) can be tuned later without
  touching the simulation.
