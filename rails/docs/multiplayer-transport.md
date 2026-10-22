# Multiplayer transport (step 4): Action Cable over PostgreSQL

How lobby state reaches every open tab, what the server will and will not
accept, and what later steps should build on. The HTTP API from step 3 stays
the only write path; WebSocket events are the read/notify path.

```
Browser tab(s)                     Rails                                 PostgreSQL
──────────────                     ─────                                 ─────────
lobby.js ── ws://…/cable ────▶ ApplicationCable::Connection
             subscribe         RoomChannel#subscribed ── authorization ─▶ rooms/room_memberships
             {channel, code}   RoomChannel#heartbeat  (presence)  ─────▶ last_seen_at
                               RoomChannel.emit ◀── Room#notify_events! ─ rooms.version bump
                                       │              (after commit)      on every visible change
                                       └── LISTEN/NOTIFY ───────────────▶ broadcast to every socket
lobby.js v rule ── GET /api/rooms/:code ──▶ authoritative snapshot (version N)
```

## Why Action Cable (and this adapter)

* **It ships with Rails.** No new gem, no new daemon: `require
  "action_cable/engine"` mounts the server at `/cable` and the app keeps its
  single Puma process model.
* **Adapter: PostgreSQL LISTEN/NOTIFY** (`config/cable.yml`, adapter
  `postgresql`, the one bundled with Rails). The deployment is
  `compose.yaml = app + postgres` — there is no Redis to depend on, and the
  alternative `async` adapter broadcasts **only inside one process**, which
  would silently lose events the moment `WEB_CONCURRENCY > 1` or a second
  container joins. LISTEN/NOTIFY reaches every process sharing the database.
  Each process owns one dedicated LISTEN connection; broadcasts take a
  pooled connection for the duration of one NOTIFY.
* **Payload cap:** PostgreSQL NOTIFY carries at most 8000 bytes. Room events
  are therefore *event + version + a few ids* — never a roster. Clients that
  need detail refetch the snapshot (below).
* `test` uses the `test` adapter: broadcasts are recorded *and* delivered
  in-process, so `test/cables/room_broadcast_test.rb` can prove fan-out.

## Authentication and authorization

**Connection (handshake).** `ApplicationCable::Connection` identifies exactly
one principal — `session[:user_id]` (existing login) **or** the httpOnly,
encrypted `snake_guest` cookie (step 2's token) — and rejects a browser with
neither (`reject_unauthorized_connection`). Cookies/session are read from the
handshake request; nothing identity-bearing is ever in a URL or the query
string.

**Subscription.** `RoomChannel#subscribed` re-resolves everything: the code
must name a real room, the room is swept (it may have expired), a closed room
is refused, and the *connection's* identity must hold an **active membership
in that room** — otherwise `reject_with(reason, message)` transmits a
plain-language error and drops the subscription. Seated elsewhere means you
cannot watch another room: identities hold one active seat (step 2 invariant).

**Actions.** Every channel action (`heartbeat`) re-checks membership against
fresh database state (`current_membership`), so a socket whose owner was
kicked gets `resync` instead of answers. HTTP writes keep their own
authorization from step 3 (host-only actions, own-seat-only actions).

**Multi-tab.** Tabs of one browser share one guest cookie (accounts share one
session), so N sockets == 1 identity == 1 membership row. Re-joining from a
second tab is idempotent and broadcasts nothing
(`room_broadcast_test.rb`).

## Versioning protocol

`rooms.version` is a monotonic bigint (migration
`20260109000000_add_version_to_rooms`). `Room#notify_events!` bumps it **once
per logical change, after the row lock commits**, and every event of that
change carries the same `v` (e.g. a host leaving emits `member_left` +
`host_changed` under one version).

Client rules (`public/multiplayer/lobby.js`):

| Situation | Client behaviour |
| --- | --- |
| snapshot applied | adopt `room.version` as its version |
| event `v ≤ version` | **stale replay — dropped**, DOM untouched |
| event `v > version`, synced | fetch snapshot (coalesced: one request per burst) |
| between (re)connect and first snapshot | **buffer** events; apply none |
| reconnect | fetch authoritative snapshot first, then drain buffer (older events now drop by version) |

Stale updates can therefore never overwrite newer state: the snapshot is the
source of truth and versions gate every delta.

## Reconnection and connection state

The page shows a live chip in the room header: **Live / Reconnecting…(n) /
Connecting… / Disconnected**.

Reconnects are automatic — Action Cable's `ConnectionMonitor` reopens a stale
socket with exponential backoff and jitter
(`staleThreshold * (1 + rate)^attempts` seconds, plus a random 0..rate
multiplier), tuned in `lobby.js` to first-retry ≈4 s, ≈1.35× growth, up to
~50 % extra jitter. Each reconnect re-subscribes and, before any buffered
event is trusted, re-fetches the snapshot (above). A rejected subscription is
*not* retried; the page asks the HTTP API why, shows the reason (`404`
unknown code, `410` disbanded/expired, seat gone) and leaves the room view.

While the socket is down the page falls back to the step-3 HTTP poll (every
`MULTIPLAYER_POLL_INTERVAL` seconds) — correct UI without a refresh, and it
doubles as the presence heartbeat. While live, polling drops to a one-minute
safety net and the socket sends `heartbeat` every 25 s to keep `last_seen_at`
moving (seat + crown stability).

## Proxies, HTTPS and future channels

* The client dials the **relative** `/cable`, so behind nginx or a Cloudflare
  Tunnel the browser derives `wss://` from the page origin itself — no config,
  no mixed content. Rails' origin check allows same-origin by default
  (`allow_same_origin_as_host`).
* `ACTION_CABLE_URL` sets an absolute `wss://` URL when the socket lives on
  another host/port; `ACTION_CABLE_ALLOWED_ORIGINS` lists extra origins for
  proxies that rewrite `Host`; `ACTION_CABLE_WORKER_POOL` sizes channel
  worker threads (pair `RAILS_DB_POOL` ≥ Puma threads + those workers).
* `RoomChannel` is the lobby. Later steps add **independent** channels —
  e.g. `BrawlChannel`/`DuelChannel` streaming `matches:<id>` — with their own
  authorization (participant of that match) instead of overloading this one;
  the connection identity and the version/snapshot rules carry over unchanged.

## Tests

```bash
cd rails && bundle exec rails test
# test/cables/connection_test.rb     who may open a socket (accepted/rejected)
# test/channels/room_channel_test.rb subscription + action authorization, reasons
# test/cables/room_broadcast_test.rb two independent clients, identical events,
#                                    monotonic versions, rejoin stays silent
```

Browser-level proof (real WebSockets, needs a browser environment):
`tests/browser/multiplayer.spec.mjs` — two separate browser contexts see each
other's joins/ready votes live, and a second tab of the same player never
appears as a third member.
