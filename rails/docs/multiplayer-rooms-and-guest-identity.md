# Multiplayer foundation: rooms, memberships, guest identity (Step 2)

Backend data foundation only. No routes, controllers, WebSockets, cookies or
UI are added by this step, and `/multiplayer` still honestly says
"not available yet". Later steps (lobby endpoints, Action Cable, the game
loop, Brawl/Duel match records) build on these three tables without
reworking identity.

## Tables

```
users ──────────────┬──< room_memberships >── rooms
(existing, untouched)│        │  FK user_id ─OR─ FK guest_session_id (CHECK: exactly one)
guest_sessions ──────┘        │  display_name (room-local), role, state,
(new: guest credential)       │  joined_at / left_at / last_seen_at
                              └── FK claimed_by: guest_sessions.claimed_by_user_id → users
```

* **`rooms`** — `invitation_code` (unique, unpredictable), optional `name`,
  `mode` (`brawl`|`duel`), `state`, `max_members`, allow-listed `settings`
  (jsonb), lifecycle timestamps (`started_at`, `finished_at`,
  `disbanded_at`, `archived_at`) plus `created_at`/`updated_at`.
* **`room_memberships`** — one row per player per room, kept after leaving.
  Owned by **exactly one** principal: `user_id` XOR `guest_session_id`.
  `display_name` is room-specific (defaults to a *copy* of the username for
  signed-in players; editing it never writes to `users.username`).
  `role` is `host`|`player`; the host is a membership role, not a user row,
  so a guest can host and hosting can transfer when the host leaves.
* **`guest_sessions`** — a guest *browser's credential*, independent of any
  display name and of `users`. Stores `token_digest` (SHA-256 only),
  a safe-to-show random `public_id`, expiry/revocation stamps, and the
  one-way claim audit (`claimed_by_user_id`, `claimed_at`).

Migration `20260106000000_create_multiplayer_rooms` is purely additive and
reversible; `users`, `scores` and all single-player data are untouched
(verified: migrate-up and migrate-redo over a pre-Step-2 database holding
a user + score).

## Identity & guest-session security

Two different secrets exist in multiplayer; keeping them apart is the core
of the design:

| Secret | What it proves | Where it lives | In URLs? |
|---|---|---|---|
| **Invitation code** (12 chars, `SecureRandom`, no-look-alike alphabet) | "You may *join* this room as a new player while it is in the lobby." | Plain column (it is a shared locator, like a meeting link) | Yes — it is meant to be shared |
| **Guest session token** (256-bit `SecureRandom.urlsafe_base64(32)`) | "This browser *is* the guest who already holds that seat." | Raw value only in the browser cookie; DB keeps SHA-256 digest | **Never** |

Guest refresh persistence (implemented in `GuestSession`, wired to a real
cookie by the future join endpoints):

1. `session, raw = GuestSession.issue` — the raw token is returned exactly
   once. Store it in an `httpOnly`, `SameSite=Lax` cookie (`Secure` in
   production, `Path=/`, 30-day expiry matching `expires_at` and the
   existing signed-cookie session lifetime). JS must never read it.
2. On each later request the endpoint calls `GuestSession.authenticate(raw)`
   → session or `nil` (unknown/expired/revoked/claimed are indistinguishable).
   `active_membership` then resumes the seat — a refresh is a no-op
   (`Room#join!` is idempotent for seated players).
3. `rotate_token!` replaces the credential (old cookie dies instantly);
   `revoke!` is guest sign-out. SHA-256 (not bcrypt) is correct here: the
   token has 256 bits of entropy, so there is no dictionary to slow down —
   the same reason Rails digests other high-entropy bearer tokens. The
   digest is also excluded from all serialisation (`serializable_hash`).
4. A display name, invitation code or `public_id` can never authenticate as
   a guest (tested). A leaked database yields no replayable guest cookies.

Signed-in players use the existing username/password system unchanged
(`session[:user_id]`); `Room#join!(user: current_user, …)` is the seam.

### Claiming a guest seat after sign-in

`guest_session.claim_by!(user)` (`RoomMembership#claim_by!`):

* Only reachable with the guest's verified raw token (`authenticate` first),
  so knowing a name/code/`public_id` cannot steal a seat or its history.
* Only a **current** (active) seat can be claimed — not yesterday's left seat.
* Seat keeps display name, role (a guest host stays host) and `joined_at`;
  only the owner changes guest→user.
* The guest token is revoked and `claimed_by` stamped **in the same
  transaction**, so the cookie can never be replayed or claimed twice.
* Refuses (leaving everything untouched) if the account already holds a live
  seat anywhere — two simultaneously seated players are never merged.

## Lifecycles

Room: `lobby → in_match → finished → lobby (rematch)`,
any unarchived state `→ disbanded`, `finished|disbanded → archived`.
Only `lobby` accepts joins. Guarded methods: `start_match!`, `finish_match!`,
`return_to_lobby!`, `disband!`, `archive!` (illegal jumps raise
`Room::InvalidTransition`). Disbanding/archiving releases all seats
(`left`), freeing those identities for other rooms. Rooms are never
hard-deleted in normal play, so future match/result rows keep their parent.

Membership: `joined ⇄ ready → playing → joined`, plus `→ left` (voluntary,
may rejoin — same row reactivates) and `→ removed` (kicked; terminal for
that room). If the host departs, the longest-seated member inherits; an
emptied room disbands itself instead of becoming a host-less zombie.

Modes: `brawl` (2–16 seats, default 8) and `duel` (exactly 2). New modes
extend `MODES` + the CHECK when their step lands.

## Invariants (database-enforced, models mirror them as friendly errors)

1. Invitation codes globally unique.
2. One membership row per `(room, user)` and per `(room, guest_session)` —
   forever; rejoin reactivates, never forks.
3. **One active seat per identity across all rooms** (partial unique index
   over `joined|ready|playing`): a membership therefore cannot control
   several simultaneous matches; leave one room before joining another.
   (Deliberately strict for a real-time snake game — relax later by
   narrowing the index predicate to `playing` only, if multi-lobby
   browsing is ever wanted.)
4. At most one active host per room (partial unique index).
5. Active display names unique per room, case-insensitive; freed on leave.
6. `user_id` XOR `guest_session_id` (CHECK); mode/state/role/capacity
   CHECKs; `left_at` set exactly when inactive; FKs cascade so deleting an
   account removes its seats (like its scores), never the room.

Capacity and host succession run under a room-row lock (`with_lock`), so
simultaneous joins cannot both take the last seat.

## Known seams for later steps

* **Before match-result rows reference memberships**, revisit one line in
  `claim_by!`: it deletes the claimant's *stale inactive* seat in the same
  room (needed for the `(room, user)` unique index). Harmless while nothing
  references memberships; once results exist, re-point those rows instead.
* User deletion cascades memberships (`dependent: :delete_all` + FK), so a
  deleted host leaves a host-less room until a later step adds presence/
  succession-on-disconnect handling (Action Cable presence will own that).
* Abandoned-lobby sweeping: `rooms.state + created_at` index and
  `GuestSession.expired` scope exist for a future cleanup job; none runs yet.
* `settings` currently allow-lists `speed_level`/`growth` (Score presets)
  via `Room.sanitize_settings`; extend the allow-list per mode later.

## Tests

First Rails tests in the repo (`rails/test/`), 51 runs / 184 assertions:

```bash
cd rails
bundle exec rails db:prepare RAILS_ENV=test   # or set DATABASE_URL
bundle exec rails test
```

Covered: code generation/lookup/rotation, lifecycle guards, capacity,
settings sanitising, XOR identity, one-active-seat + one-host +
display-name uniqueness (including DB-level violations via
`save(validate: false)`/`update_columns`), digest-only storage,
authentication expiry/revocation/rotation, the full claim matrix
(happy path, other person's token, double-claim, merge refusal, expired
session, stale same-room seat), host succession, and a regression assert
that existing users/scores are untouched.
