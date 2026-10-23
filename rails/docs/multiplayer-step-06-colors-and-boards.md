# Step 6 — Multiplayer colors and board-size configuration

Base: `b9e7126659c47d969c85cddd607eca8150771813` (step 5).
Only canonical Rails code and shared production assets are changed. No game
simulation, match-start HTTP endpoint, Duel UI or replacement preview is added.

## Identity colors

* Each new guest/account membership is assigned a `color_slot` immediately.
  The same persisted slot resolves to one solid hex color for every future
  mode's snake, own food and player indicator. Claiming a guest seat preserves it.
* Allocation and selection hold the room row lock through saving the seat.
  The partial unique index on `(room_id, color_slot)` for active memberships is
  a second, database-level race guard. Clients select a slot offered by the
  server, never arbitrary CSS or another membership's id.
* `RoomPalette` generates 96 gamut-mapped OKLCH options: 24 hues ordered to
  spread early players around the hue wheel, then dark/light/deep bands. It
  lowers chroma into sRGB instead of clipping channels. Hex output also works
  on browsers without CSS OKLCH support.
* The visible palette grows in blocks of 12 and retains **at least six free
  choices**. Normal rooms still expand up to the existing 64-active-seat limit.
  Frozen participant colors remain reserved even after departure. If those
  plus spectator colors consume the finite budget, new joins get an explicit
  color-capacity error rather than duplicates (wait for the round to finish).
* Departed lobby colors become reusable; rejoining keeps the old slot only if
  it is still available. Colors are locked for the duration of a running match.
* Names remain readable theme text beside solid color markers, with dual
  black/white marker edges. Accessible swatch labels also name the owner/hex;
  color is never the only identifier. Many players/color vision differences
  cannot be distinguished by hue alone — the finite palette is not a promise
  of perfect perceptual separation at large counts.

## Authoritative board policy

**The canonical single-player default is 24 columns × 18 rows**
(`public/game.js`, used without an override by `public/app.js`). The new source
regression test pins this fact. Single-player files are not modified.

The host can choose presets or whole-number custom dimensions (24–96 columns,
18–72 rows) only in a Brawl lobby where every currently eligible participant
has a fresh desktop report. Recommendations are Classic 24×18 (1–4 players),
Roomy 40×30 (5–8), Large 48×36 (9–16), Arena 64×48 (17+).

Eligibility is active + online + not spectating; ready votes remain advisory.
Missing or stale telemetry, small viewports/screens, touch capability, coarse
pointers, absent fine pointer/hover, or an affirmative mobile hint force 24×18.
The server classifies bounded raw capability signals; a user-agent string or a
client `desktop: true` flag is never enough. Hardware telemetry necessarily is
self-reported — it is not a security boundary or tamper-proof device attestation.
Server authorization and the frozen grid do not depend on trusting that claim.

`configuration.js` reports each page's UUID + capabilities on entry, every 25
seconds, on visibility return, and after debounced resize/orientation changes.
Reports expire after 90 seconds. Any mobile tab belonging to a player overrides
that player's desktop tabs. Storage is bounded to 12 clients plus a fail-closed
unknown overflow sentinel: opening a 13th tab cannot grant desktop eligibility.
A disappeared tab's restriction lasts until its server-timed report expires.

Preferences are retained while mobile participation forces the default; when
all eligible participants are verified desktop again, the saved preference can
be used again. The UI clearly explains the effective grid and why controls are
locked. Non-hosts see settings read-only.

## Frozen preparation hook, not gameplay

The existing model-only `Room#start_match!` now rechecks eligibility, device
policy and colors **inside the same lock** used by joins/configuration writes.
It persists `match_configuration` with dimensions, participant ids/colors and
a timestamp, then marks only those participants as playing. A PostgreSQL trigger
and model validation prevent changes to that snapshot during `in_match`.

Resizing, new telemetry, departure and late joins cannot change the grid or
participant-color snapshot. Late joins hold a colored spectator seat and cannot
ready up; they are eligible for the next Brawl after finishing/returning to the
lobby. Every subsequent start derives a NEW snapshot from current participants
and device reports. No match/result tables or permanent archives are added.

`POST /api/rooms/:code/start` still checks eligibility and returns
`started: false, engine_ready: false`. It does **not** call this hook or claim
a nonexistent simulation is playing.

## API and live events

All writes are JSON and resolve the caller through the existing cookie/session
identity. Posted `member_id`, `host` or account ids cannot impersonate others.

| Action | POST body | Access |
| --- | --- | --- |
| `/api/rooms/:code/color` | `{ color_slot: integer }` | own active membership; conflicts 409, invalid slot 422 |
| `/api/rooms/:code/capabilities` | `{ client_id, capabilities: { width, height, screen_width, screen_height, coarse, fine, hover, touch_points, mobile_hint? } }` | own seat; malformed telemetry is unknown, bad tab id 422 |
| `/api/rooms/:code/board` | `{ columns: integer, rows: integer }` | host only; restricted/locked 409, invalid bounds 422 |

Member snapshots add `color`, `device`, `spectator`; room snapshots add
`colors`, `board`, `match_configuration`. Configuration writes and their
version bumps commit together, with `member_color`/`board_changed` (and prepared
`room_state`) events broadcast **after commit** through the existing room
stream. Clients refetch the complete authoritative state, and ignore older HTTP
snapshots just as they reject stale cable events.

## Migration and fresh installs

`20260110000000_add_multiplayer_colors_and_board_settings` is additive. Active
legacy seats are backfilled first in a stable order, preserving all user,
score and membership rows. Existing model-prepared running rooms freeze at the
default grid. The migration also reconciles a pre-existing schema-dump mismatch:
the old dump imposed a 16-seat CHECK even though the step-3 migration/model
specified 64; the constraint is now consistently 64.

Rails' Ruby schema dumper omits PostgreSQL triggers. `lib/tasks/multiplayer_schema.rake`
retains the SQL guard from `db/room_board_freeze.sql` in `db/schema.rb` on dump,
so `db:schema:load` has the same protection as migration upgrades. Rolling back
the step removes its columns, indexes and trigger, without touching users/scores.

## Validation and focused review

Run against PostgreSQL from `rails/`:

```sh
bundle exec rails db:prepare RAILS_ENV=test
bundle exec rails test
bundle exec rails zeitwerk:check RAILS_ENV=production
```

Browser tests use the real production Rails server and Action Cable, not the
repository's unrelated `src/` preview:

```sh
bash rails/bin/sync-assets
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3000 npx playwright test tests/browser/multiplayer-configuration.spec.mjs
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3000 npx playwright test tests/browser/multiplayer.spec.mjs
node --test tests/shared-game.test.mjs tests/container-config.test.mjs
```

The step-only review checked authorization and race guards, palette assignment
and exhaustion, multi-tab/stale/overflow device reports, mobile restrictions,
frozen settings, late-join spectators, existing records and real asset delivery.
Corrections found by tests: the exact 24×18 source default, stale association
reads, the inherited duplicate unready method suppressing its cable event,
the stale 16-seat schema constraint, and trigger retention for fresh installs.
Deployment still merits testing on real touch/mouse hardware, target Safari/
Firefox versions and the installation's HTTPS/WSS reverse proxy. No gameplay is
claimed or implemented in this step.
