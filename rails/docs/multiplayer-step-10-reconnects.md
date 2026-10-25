# Step 10 — Robust Brawl disconnection and reconnection

Base: `7996241` (step 9 review). No Duel reconnect code, no client-side
authority, no replacement of the step 7–9 simulation/transport architecture.

## Contract

A Brawl never depends on a browser to decide what happens after a connection
loss. The database stores the connection classification and the freeze
deadline; the leased simulator owner (`MatchRunner`) applies and enforces both
on **server time**. A disconnected tab's timers, commands and screen state are
irrelevant.

### Timeline

1. **Detect.** Every open `MatchChannel` socket writes one `match_presences`
   row (one per tab). A socket close calls `MatchChannel#unsubscribed` /
   `#disconnected`, which deletes exactly that row. The player is disconnected
   only when **no fresh row remains** — two tabs are two rows, so closing one
   never freezes anybody. A throttled owner sweep removes rows whose heartbeat
   went silent (Cloudflare Tunnel / dead worker) as a backstop; Action Cable's
   own ping timeout normally closes the socket first.
2. **Freeze immediately.** `Match#release_presence!` records
   `connection_state = disconnected`, `frozen_at`, `freeze_deadline_at =
   now + 30 s`, clears queued inputs and broadcasts a `connection` event. The
   owner then calls `World#freeze_player!` before the next movement tick.
   Body, length, direction, points, food, queue and survival counters are
   untouched; the frozen snake stays on the broadcast board and a red classic
   loading ring is painted on its head by `game-renderer.js`.
3. **Grace (30 s, server-owned).** `Match.freeze_grace_seconds` (env
   `MULTIPLAYER_BRAWL_FREEZE_GRACE`) is compared against the database deadline
   in `Match#sync_connection_states!`, called by the owner every pass. No
   JavaScript timer can shorten or extend it.
4. **Reconnect within grace.** Any tab subscribing calls
   `Match#register_presence!`, which marks the participant connected, clears the
   deadline and drops commands queued for the lost connection. The owner
   unfreezes the snake (`World#resume_player!`) and control returns. The
   channel first transmits a complete authoritative snapshot (body, points,
   direction, food, frozen/deadline fields, standings) and then a `connection`
   status frame. The browser resets its input sequence mirror; replayed
   envelopes remain rejected by `last_input_seq`.
5. **Grace expires.** `World#expire_freezes!` unfreezes the snake and records
   `connection_state = unattended`. It continues in its **last valid
   direction** and can only die through the ordinary collision/tick-limit
   rules. It is never eliminated for failing to reconnect.
6. **Late reconnect.** While alive: same path as (4), no new freeze required.
   After a natural death: `participant.spectator?` is true (status
   `eliminated`), the client renders the finale/spectator state, and input is
   refused (`:eliminated`). Reconnecting after completion seeds the final
   authoritative snapshot; results are never recomputed.

### Anti-abuse

`freeze_windows_used` / `last_freeze_started_at` on `match_participants` enforce
at most `MULTIPLAYER_BRAWL_FREEZE_WINDOWS` (default 2) grace windows per match,
each separated by `MULTIPLAYER_BRAWL_FREEZE_COOLDOWN` (default 60 s). Further
drops mark the snake `unattended` (moving) instead of granting another freeze.
`survived_ticks` still only counts **movement** ticks (frozen ticks land in the
separate `freeze_ticks` audit column), so freezes can never inflate the
survival tiebreaker.

## Lobby, completion and crashes

* Lobby presence remains cookie-based. A dropped socket, one closed tab or a
  transient tunnel does **not** disband the room: seats and crowns survive
  `MULTIPLAYER_HOST_GRACE`; after that the crown migrates (never the room).
  `Room#touch_member_presence!` emits `member_resumed` when a quiet member
  returns.
* Match completion is not a special teardown: subscriptions still receive the
  final frame, and late/reconnecting players are spectators with the preserved
  standings.
* Finished rooms start the next Brawl directly (`Room#start_match!` accepts
  `finished`, resets seats and freezes a new match in one lock). The previous
  "Play again" flow required a separate lobby round trip and the canvas
  renderer refused the new match id, which is why a browser refresh was needed.
  `MultiplayerGameRenderer#reset` plus the lobby's match-id reset remove that
  requirement.
* Server crashes: a live match with an authoritative checkpoint is recoverable
  by lease takeover and is left alone. A live match with no checkpoint, no
  lease and no progress past `MULTIPLAYER_ORPHAN_MATCH_GRACE` is marked
  `interrupted` (a new terminal status): no standings, no winner, room returned
  to results. Completed matches are never touched, so recorded winners and
  results survive a crash.

## Protocol additions (v1, backwards compatible keys)

* per player: `fr` (frozen), `gu` (absolute server deadline, epoch ms), `cy`
  (`connected`/`disconnected`/`unattended`), `fz` (frozen ticks, audit only);
* snapshot: `ts` (server epoch ms, used only to render a countdown).
* channel events: `{type:"connection", participant, state, grace_deadline_at,
  freezes_used, spectator}` and `{type:"interrupted"}`; seed snapshots also
  carry `spectator`, `spectator_reason`, `grace_seconds`.

Inputs are unchanged and remain `{v,type,match,tick,seq,dir}`; no position,
score or winner may be sent. A participant whose `connection_state` is not
`connected` is refused with `:disconnected`/`:frozen` even if a stale socket
manages to post.

## Tests (no wall-clock sleeps)

* `test/simulation/reconnection_test.rb` — freeze preserves position, length,
  direction, points and food; frozen ticks are not survival; exact 30 s
  deadline boundary; unfreeze continues in the last direction; late reconnect;
  reconnect after natural death; stale input refused; checkpoint round trip.
* `test/models/brawl_reconnection_test.rb` — last-tab rule, two tabs, reconnect
  within grace, timeout, repeated-drop budget/cooldowns, stale-socket sweep,
  command discard/replay, completed-result preservation, interrupted matches
  without fabricated standings, one-action rematch, host grace.
* `test/channels/match_channel_test.rb` — per-tab presence release and the
  connection status frame.
* `scheduler_protocol_test.rb` — new snapshot keys never expose identity.

Run: `cd rails && DATABASE_USER=… RAILS_ENV=test bundle exec rails test`
(294 runs, 1559 assertions, 0 failures during this step), plus the standalone
engine suites with `ruby -Itest test/simulation/reconnection_test.rb`.
