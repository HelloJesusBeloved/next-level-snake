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

Step 3 is plain HTTP. `lobby.js` polls `/api/rooms/current` every
`MULTIPLAYER_POLL_INTERVAL` seconds (pausing while the tab is hidden), which
doubles as the presence heartbeat that keeps a seat and the host crown alive.
Real-time event synchronization replaces the polling loop in the next step;
rendering and actions are already written as pure functions of room state so
that swap stays local to `refresh()`/`poll()`.

## Not built yet

Snake gameplay, Duels, rankings, permanent archives and QR scanning. The Start
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
