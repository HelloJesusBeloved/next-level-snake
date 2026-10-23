# Multiplayer frontend

`GET /multiplayer` (and `/multiplayer/:code`) renders
`rails/app/views/snake/multiplayer.html.erb` through `SnakeController#multiplayer`
and the existing Rails application layout.

- `page.js` is the page's native ES-module entry point; it enables the Terminal
  rain and mounts the lobby. No bundler is required.
- `lobby.js` is the lobby itself: create / join / ready / leave / start
  eligibility / disband, the roster with its host crown, and the shared
  sign-in dialog. It talks to `/api/rooms/*` with `fetch` and never touches the
  single-player engine or `app.js`.
- `lobby.css` is loaded through the view's `content_for :head` block, so the
  single-player stylesheet stays untouched. It only uses the shared theme
  tokens from `styles.css`, which is why all seven themes work for free.
- `#multiplayer-root` is the page mount point. It carries
  `data-room-code` (from an invitation URL) and `data-poll-interval`.

## How identity works here

The page never sees, stores or sends an identity. The server resolves every
request from the Rails session cookie (signed-in players) or from the httpOnly
guest cookie it issued (`snake_guest`, encrypted, SameSite=Lax). So:

- a plain refresh restores the room by asking `GET /api/rooms/current`;
- an invitation link only names a *room*, never a player;
- posting somebody else's `member_id` does nothing — the server ignores
  identity hints in the body.

`localStorage` holds exactly one thing: the display name last typed on this
device (`snake.multiplayer.name.v1`), purely as a convenience default.

## Synchronization

Step 4 added Action Cable: `lobby.js` opens one socket per room
(`RoomChannel`, vendored client in `actioncable.esm.js`) and the page updates
instantly when anyone else joins, readies up, inherits the crown or disbands.
Rules the client keeps (server details: `rails/docs/multiplayer-transport.md`):

* every event is `{ code, event, v }` where `v` is the room's monotonic
  version — `v <= version` is a stale replay and is dropped, `v > version`
  triggers a snapshot refetch (coalesced);
* after every (re)connect the **authoritative snapshot is fetched first**;
  events that arrived meanwhile stay buffered until it lands;
* the connection chip (Live / Reconnecting…(n) / Offline) reflects
  `ConnectionMonitor`, which reconnects with exponential backoff + jitter;
* while the socket is down the old `MULTIPLAYER_POLL_INTERVAL` HTTP poll runs
  as the fallback (and presence heartbeat); while live it drops to a slow
  safety net and the socket heartbeats every 25 s instead.

Rendering and actions were already pure functions of room state, so the
transport swap stayed inside `refresh()`/`connectCable()`.

## Sharing & the QR scanner (step 5)

The in-room sharing panel shows the invitation code, the direct join URL and
three actions: **Share Room** (`navigator.share`, hidden where unsupported),
**Copy Link** (always available; both the Clipboard API and a selection
fallback, with visible success *and* failure feedback in the panel), and
**Show QR** — a canvas QR drawn in-page from `window.qrcode`.

**Scan QR Code** (landing card and sharing panel) opens `<dialog id="mp-scan">`:
`getUserMedia` → `<video>` → decode with native `BarcodeDetector` if the browser
has it, otherwise the vendored `jsQR` — both run locally. Accepted payloads must
be `http(s)` on the page's origin or the server's configured public origin
(`config.origin` payload) **and** match `/multiplayer` or `/multiplayer/<code>`;
everything else is rejected with a message and scanning continues. A valid scan
navigates with `location.assign` — the SAME tab, never `window.open`. Every
exit path (success, decode failure, Cancel, Escape via the dialog's `close`
event) funnels through `stopScanner()`, which stops every `MediaStreamTrack`
and detaches the video. Unsupported `mediaDevices`, denied permission, missing
cameras and non-secure contexts are reported in `#mp-scan-status` with the
code-entry fallback.

## Colors and board policy (step 6)

`configuration.js` renders server-owned color reservations and the host's
pre-Brawl board controls. It reports viewport/screen dimensions, touch,
pointer and hover capabilities per tab on entry and every 25 seconds, including
after resize/orientation/visibility changes. Missing/stale/unknown or mobile
reports require 24×18 — the actual canonical single-player default. No UA-only
classification or client-owned grid is used. Color selection and board changes
use the room API and existing versioned room events; live palettes are shared
by every tab. Spectators are named/colored but cannot change a running match.
See `rails/docs/multiplayer-step-06-colors-and-boards.md` for details and tests.

## Simulation is not in the browser (step 7)

Multiplayer movement, food, growth, collisions and scoring are decided by the
Rails-side engine in `rails/app/lib/simulation/`. The browser will only send
`dir` inputs and render authoritative snapshots; it never computes a position,
score or winner. `game.js` remains the single-player renderer and is not used
as a multiplayer authority. See
`rails/docs/multiplayer-step-07-server-engine.md`.

## Playable Brawls (step 8)

`game-renderer.js` is a canvas-only renderer for the server's versioned
snapshots; it never advances a snake. `lobby.js` subscribes to `MatchChannel`
once the caller is a frozen participant, paints snapshots/standings, and sends
only direction intents (`{v,type,match,tick,seq,dir}`) from the keyboard
(arrows/WASD), a canvas swipe, or the mobile steering pad. The simulator runs in
the Puma master (`config/puma.rb`) under the step-7 database lease; set
`MULTIPLAYER_SIMULATOR=false` to run `bundle exec rails multiplayer:simulate`
separately instead. See `rails/docs/multiplayer-step-08-brawl-gameplay.md`.

## Files

- `page.js` — entry point (Terminal rain + mounts the lobby)
- `configuration.js` — identity palette, host board controls and per-tab capability reports
- `lobby.js` — roster, actions, polling fallback, Action Cable client,
  sharing panel, QR drawing and the camera scanner
- `actioncable.esm.js` — official Action Cable client, vendored from the gem
  (no asset pipeline; upgrade it with the gem)
- `vendor/qrcode.min.js` — qrcode-generator v1.4.4 (drawing; license file
  alongside) and `vendor/jsqr.min.js` — jsQR v1.4.0 (Apache-2.0, fallback
  decoder), both vendored from npm and fully offline
- `game-renderer.js` — canvas renderer for authoritative snapshots (never predicts)
- `lobby.css` — lobby styling: connection chip, sharing panel, QR, scanner, arena

## Not built yet

Duels, advanced death animations, spectator UI, persistent room leaderboards and rankings archives. The Start
control asks the server whether a Brawl *could* start and says so; it never
pretends to run a match.

The container's existing `COPY public/` and bare-metal `rails/bin/sync-assets`
both include this directory. Edit the root `public/` sources, never their
copied `rails/public/` counterparts.

To check both desktop and mobile behaviour against a running **Rails** app:

```sh
bash rails/bin/sync-assets
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3000 npx playwright test tests/browser/multiplayer.spec.mjs
```

The tests use real page routes and the real room API without mocking. They
create guest rooms (which expire on their own) and never create accounts or
submit scores. The repository's `src/` preview is not the target.
