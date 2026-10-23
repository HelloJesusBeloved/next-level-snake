# Step 7 — Server-authoritative Snake simulation engine

Base: `ec3d3cae56c6161e18128557f361bc43ec88e9ab` (step 6).
This step adds a **rules engine**, not frontend gameplay. Single player is
untouched: `public/game.js` is still the only renderer and is never an
authority for a multiplayer match.

## Layers (strict separation)

| Layer | Files | Knows about |
| --- | --- | --- |
| Rules engine | `app/lib/simulation/*` | only plain Ruby |
| Protocol | `app/lib/simulation/protocol.rb` | wire/checkpoint shapes |
| Scheduling | `app/lib/simulation/scheduler.rb`, `supervisor.rb` | monotonic time, injected ownership |
| Persistence + ownership | `app/models/match.rb`, `match_participant.rb`, `match_runner.rb` | ActiveRecord, leases |
| Room lifecycle | `app/models/room.rb` | creates/finishes matches |
| Transport | **not in this step** | step 8 will submit directions + broadcast snapshots |

The engine can be executed with no Rails, no database, no browser and no
WebSocket:

```sh
cd rails
ruby -Itest test/simulation/world_test.rb
ruby -Itest test/simulation/scheduler_protocol_test.rb
ruby -Itest test/simulation/supervisor_test.rb
```

## Rules mirrored from the verified single-player engine

`public/game.js` was inspected directly; the server preserves:

* **one logical grid step per tick**, wrapping with modulo on both axes;
* **direction queue** of at most two turns, ignoring duplicates and 180°
  reversals (also re-checked when the queued turn is consumed);
* **tail semantics**: the tail cell is free when moving, but blocks while the
  snake is growing;
* **food = +1 point** and `growthEff()` segments, consumed one per tick;
* **speed presets** Chill 165 ms, Easy 130, Normal 105, Fast 80, Insane 60,
  Ludicrous 42. Server custom speeds are clamped to a **40 ms floor** because
  one process can host many matches. A Rails test pins the preset table to
  `public/game.js`, and board bounds to `RoomBoard`/the game default 24 × 18.

## Mode readiness (provisional balance)

| | Brawl | Duel |
| --- | --- | --- |
| Opponents | **non-solid** (only self-collision) | **solid** (body and head-on collisions) |
| Food | one **owned** item per player, in their color, respawns | **shared supply that only shrinks** (consumption removes; periodic shrink to a minimum of one) |

The engine models both; the Duel numbers are an explicit starting point for
later balancing. Nothing in the loop branches on mode outside `Rules`.

## Ranking — final points decide the winner

`Simulation::Ranking` sorts by, in order:

1. **final points** (food eaten),
2. survival time (completed ticks),
3. longest snake (cells),
4. participant id (stable deterministic fallback).

An **eliminated player can win**. Example pinned by tests: 9 points and
eliminated at tick 3 beats a survivor with 4 points at tick 90. Removing a
player (`remove_player!`) freezes their points but does not remove them from the
standings.

## Discrete ticks, not network timing

`Simulation::Scheduler` accumulates **monotonic** elapsed milliseconds
(`CLOCK_MONOTONIC`, never wall clock) and emits whole ticks for a fixed
`tick_ms`. Inputs never advance movement; they only enter the queue.

Catch-up is bounded: at most `max_catchup_ticks` (5) steps per pass, and a long
stall is **dropped and reported** (`dropped_ticks`) instead of being replayed
for minutes. Broadcast cadence will be chosen independently in step 8.

## One authoritative owner per match

Ownership is a **database lease**, which works with the existing single-image
Podman/Compose deployment and also across multiple Puma workers/hosts sharing
PostgreSQL:

* `matches.owner_token` + `matches.lease_expires_at`.
* `Match#claim_lease!` is a **conditional UPDATE** (unowned, expired, or own
  token). Exactly one contender wins — proved by an eight-thread test.
* The owner renews the lease **on an interval** (default 2 s, well inside the
  6 s TTL) — not on every tick, so PostgreSQL stays out of the hot path. Only a
  successful renewal advances the renewal clock; otherwise the interval could
  never elapse and the lease would silently expire while this process kept
  simulating (a bug fixed during the focused review, see below).
* Every checkpoint and completion is **fenced on the token**
  (`WHERE owner_token = ?`). A process that lost its lease cannot overwrite
  newer state or publish results. A refused write is treated as "ownership
  lost": the match is detached, never simulated on borrowed time.
* Results are written **only after a fenced completion succeeds**; a failed
  completion is reported as `lost`, not `completed`.
* `Simulation::Supervisor` keeps the in-memory worlds, renews on the interval,
  and survives per-match errors: an exception while ticking/checkpointing one
  match detaches that match (fail closed) and the remaining matches continue.
* `MatchRunner` claims free matches and is the only place that builds/restores
  worlds. It finalizes a checkpoint whose world already finished instead of
  attaching a completed world forever, and `shutdown!` **releases its leases**
  so a takeover is immediate rather than expiry-based.
* Two Puma workers cannot both claim a match; a real eight-thread,
  non-transactional database test proves exactly one winner.
* Lease timestamps are application wall-clock values. Hosts sharing a database
  should be NTP-synchronised (the supported Compose deployment is one app
  container plus PostgreSQL); the fencing above still prevents a stale owner
  from writing even if a hand-over happens earlier than expected.

**Crash/takeover policy.** State is checkpointed every 20 ticks (not each
tick). A new owner may resume an expired lease **from the last checkpoint**;
queued inputs since that checkpoint are lost, which is documented rather than
hidden. If a match was running but has no checkpoint, it is abandoned
(`owner_lost`) instead of silently restarting the round. `rails multiplayer:reap`
abandons checkpointless orphans; participants are still ranked from any
checkpoint on abandonment.

**No invented results.** A match that never checkpointed (never started, or
crashed before its first checkpoint) is marked abandoned with *no* placements
and *no* scores. Only real checkpointed progress is ranked, so a fabricated
"everyone scored 0 / placements 1..n" row can never influence later standings.
Match creation also refuses to start if a frozen participant's membership has
vanished, rather than silently beginning with a smaller roster.

Deployment:

```sh
# any one process may run this; the lease makes duplicates safe
cd rails && bundle exec rails multiplayer:simulate
bundle exec rails multiplayer:tick     # one pass, for cron/tests
bundle exec rails multiplayer:status   # live matches + owners
```

No background thread is started by an initializer in this step, so booting the
web app cannot begin gameplay by accident. The engine and its rake tasks ship in
the production image because the Dockerfile copies `rails/` wholesale; **the
simulator is a separate process from Puma** and is not started by
`bin/docker-entrypoint`. Until step 8 wires it in, an operator runs it
explicitly (for example `bundle exec rails multiplayer:simulate` in a second
Compose service or systemd unit sharing the same `DATABASE_URL`). Running two
of them is safe: the lease arbitrates, and each match still has exactly one
simulator.

## How Action Cable will use this (step 8)

* **Inputs:** `RoomChannel` (or a match channel) will `perform`-forward a
  direction message, resolve the participant from the connection identity, and
  call `world.apply_input` through the owner. The transport never passes
  `player_id` or game state, and it never steps the simulation.
* **Snapshots:** the owner publishes `Simulation::Protocol.encode(world)` at a
  broadcast cadence chosen independently of `tick_ms` (for example 5–10 Hz
  while simulating at 60–105 ms per tick). Broadcasting is a read of the
  in-memory world, so network jitter cannot change movement.
* **No simulation in the channel:** a non-owner Puma process answers reads and
  forwards inputs only. If it ever holds the lease it can simulate, but only one
  process at a time may advance a given match.
* **Reconnect/resume:** clients receive the current tick in every snapshot and
  can discard out-of-order frames; they never compute positions or scores.

## Protocol (version 1)

Snapshots are compact and versioned; cells are `y * columns + x` indexes.

```json
{
  "v": 1, "m": 42, "s": "running", "t": 137, "r": "brawl",
  "b": { "c": 24, "r": 18 }, "e": null,
  "p": [{ "i": 7, "n": "Ada", "c": "#F66B71", "sc": 3, "l": 6, "a": true,
          "d": "right", "b": [131, 130, 129], "sv": 137, "lg": 6,
          "el": null, "er": null }],
  "f": [{ "c": 205, "o": 7 }]
}
```

Inputs are strictly parsed:

```json
{ "v": 1, "type": "input", "match": 42, "tick": 137, "seq": 9, "dir": "up" }
```

* `dir` must be one of `up/down/left/right`; the engine rejects duplicates,
  reversals, full queues, replayed `seq`, stale ticks (>2 behind) and future
  ticks.
* **Identity is never accepted from the payload.** `player_id`, positions,
  bodies, scores, lengths and winners are rejected as `forbidden_field`; the
  future controller/channel must derive the participant from the session/guest
  cookie exactly as the lobby API does.
* `seq` is per participant and monotonic. Any **valid envelope** consumes its
  sequence number, even when the turn itself is ignored (duplicate, reversal,
  full queue); otherwise the same sequence could be replayed later with a
  different direction. Ticks more than two behind, or beyond the next tick, are
  rejected without consuming it.

## Lifecycle

`pending → running → paused → running → completed` (with an idempotent
`finish!`). The world refuses to step when paused or completed, and refuses
input unless running. `Match` adds `abandoned` for room-finished/disbanded or
lost owners.

`Room#start_match!` (still model-only; the HTTP Start endpoint remains an
eligibility check with `started: false`) now creates the durable `matches` row
from the **frozen** step-6 configuration and participant colors. Finishing,
disbanding or archiving the room abandons its live match. Late joiners are
already spectators per step 6 and never enter the simulation.

## Database write profile

| Event | Writes |
| --- | --- |
| every tick | none |
| lease renewal | one fenced UPDATE every ~2 s per owned match |
| every 20 ticks | one checkpoint (`matches.checkpoint`) |
| completion / abandonment | one fenced result write + participant placements |

## Focused review corrections (follow-up to the original step commit)

A review of the step-7 diff against its requirements found and fixed:

1. **Lease never renewed (critical).** The supervisor advanced
   `last_renewed_at_ms` on every pass, so the 2 s interval never elapsed; the
   6 s lease expired while this process kept simulating, and its checkpoints
   were silently refused by the fencing. Renewal now advances the clock only
   after a successful renewal, with a regression test that runs well past the
   TTL. The previous test was too weak (`<= 6` renewals allowed zero).
2. **Invented results on abandonment.** `abandon!` built a fresh world when no
   checkpoint existed and persisted zero-point placements. Now only
   checkpointed progress is ranked, and a test asserts no placements/scores are
   written for a match that never ran.
3. **Replayable input sequence.** A rejected turn did not consume its `seq`, so
   the same sequence could later be replayed with a different direction. Valid
   envelopes now consume `seq`; covered by a test.
4. **No error isolation.** An exception in one match's checkpoint/renewal (or a
   database error) could abort the whole tick pass, and a failed completion was
   still reported as completed. Each match is now isolated, a failed fenced
   write detaches it, and only persisted completions are reported.
5. **Completed checkpoints attached forever.** A crash after the final tick
   could leave a completed world attached to a live row. Claiming now finalizes
   it from the checkpoint.
6. **No orderly lease release.** `release!` was dead code; `shutdown!` now
   releases leases so a restart takes over immediately.
7. **Silent roster truncation.** Match creation dropped frozen participants
   whose membership had vanished. It now fails loudly and persists nothing, and
   uses one query instead of one per player while holding the room lock.
8. **Operator visibility.** The simulator task now survives transient
   exceptions (instead of exiting and abandoning every match) and prints
   errors/lost/completed events; `reap` says explicitly that no standings were
   invented.
9. Removed dead mode metadata (`initial_food`, unused `solid_opponents` reader)
   and simplified the spawn-adjacency predicate.

## Tests actually executed

* Pure engine (no Rails): movement in four directions, all four wrap edges,
  body following, food/growth amount, zero growth, owned food isolation,
  respawn, per-player scores, self-collision, growing-tail collision, brawl
  pass-through, duel body/head-on collisions, queue ordering, reversal
  rejection, duplicate/replay/stale/future input rejection, unknown/eliminated
  players, pre-start/post-finish input, pause/resume/finish, tick limit,
  last standing, player removal, rankings (points first), duel shared shrinking
  food, match isolation, same-seed determinism, checkpoint restore,
  catch-up caps and protocol rejections.
* Supervisor: attach/step on monotonic time, throttled renewal, periodic
  checkpoints, completion once, lost-lease detachment, multiple matches.
* Rails: room→match creation and frozen colors, one live match per room,
  lease exclusivity (including an **eight-thread race**), fenced checkpoint and
  completion writes, completion standings (eliminated player wins), abandonment
  with and without a checkpoint (no invented results), orderly lease release,
  finalizing an already-completed checkpoint, isolation of a corrupt match,
  missing frozen participant refusal, room finish/disband integration,
  engine/board config pinned to `public/game.js`, maximum roster spawn without
  overlap, runner claim/step/checkpoint/complete/orphan behaviour.
* Totals at review time: **227 Rails runs / 1,001 assertions**, and **56 pure
  engine tests / 268 assertions** runnable with
  `ruby -Itest test/simulation/world_test.rb` (etc.).

## Limitations / still to test on the real server

* No HTTP/Cable input endpoint and no snapshot broadcast yet (step 8). The
  transport can only submit `dir` messages and must broadcast
  `Simulation::Protocol.encode(world)` at its own cadence.
* Duel food-shrink numbers and Brawl duration (180 s → tick limit) are
  provisional balance values.
* Lease takeover loses inputs queued since the last checkpoint (≤20 ticks).
  Seamless failover would need a shared in-memory store (not present in this
  deployment) or per-tick persistence (explicitly avoided). A process that dies
  between checkpoints therefore rolls back to the last snapshot by design.
* The simulator is an operator-run process (see above); until step 8 wires it
  into the deployment, starting a room in production does not start ticking by
  itself.
* Device/clock skew cannot affect simulation (monotonic clock), but real
  network latency and broadcast cadence still need measurement with the
  frontend in step 8.
* Long-running memory/CPU with many simultaneous matches should be load-tested
  on the target host; the scheduler caps per-pass work but a single process
  still owns every match it leases.
