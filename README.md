# Next Level Snake

A classic snake game written as a **Ruby on Rails 8** application: one
controller, one canvas, PostgreSQL for accounts and the record ledger. Black
playfield, one long green body with no seams between its blocks, a red box of
food, and walls that **wrap instead of killing you**. Ships as a single
container run directly with **Podman Compose** (Docker Compose also works), with a
one-command setup, plus a bare-metal installer for Fedora/Ubuntu.

> **Disclaimer.** This comes with no warranty. There is a possibility I may
> accidentally delete your user data while trying to add a feature 😅 — keep a
> `pg_dump` of your database handy before you upgrade.
>
> Made almost entirely with [arena.ai](https://arena.ai) ❤️.

---

## Features

| Requirement | Where it lives |
| --- | --- |
| Native Podman or Docker Compose; no helper script | `Dockerfile`, `compose.yaml`, `rails/bin/docker-entrypoint` |
| Username + password login (no email) | Rails: `User` + `has_secure_password`<br>Preview: `users`/`sessions` tables + scrypt |
| Persuasive password warning with Proton Pass recommendation | `#form-create` → `.auth-warning` — shown when creating an account |
| **Profile page**: your name, high scores, charts, a GitHub-style activity heatmap, favorite mode and theme, and a log of every game with its **ending snake position** (removable) | `/profile`, `public/profile.js`, `GET /api/profile` |
| Death screen: **Quit** button (replaces "Change modifiers"); returns to the start screen | `#btn-quit-over` |
| Public leaderboard: **Standard** and **Custom** board buttons with exact modifier filters | `GET /api/leaderboard` |
| **Custom** speed & growth, 0–100 each | "Custom" option on both settings + range sliders |
| **Filters** on both boards: exact speed and growth, including exact custom values | `speed=` / `growth=` query params, "Match my settings" and "Reset filters" |
| No modifier changes mid-game | settings card locks while a run is in play ("In play — locked") |
| Quit option on the pause menu + current modifiers shown | `#panel-pause` → Quit run + Speed/Growth readout |
| Pause button becomes **Unpause** while paused — **shown on touch screens only** (desktop uses P / Esc) | `#pause-btn`, `@media (pointer: coarse), (max-width: 720px)` |
| Themes in settings | `public/styles.css` `[data-theme=…]` + `public/app.js` `THEMES` |
| Classic theme — squares meet edge to edge (straight run = one long rectangle) | `THEMES.classic` → `blocks: true, blockGap: 0` |
| Vintage theme — square discrete tiles, **non-blinking** food | `THEMES.vintage` → `blockGap: 0.12, blink: false` |
| Terminal theme — subtle Matrix rain (8 rows/sec, larger 20px glyphs), page background only, **suspended while a run is active** | `#matrix-rain`, time-based loop |
| Blinking Terminal `>` cursor, **only in the inactive/paused game box** | `.terminal-cursor`, hidden while the run is moving |
| **Royal Sunset** theme | deep crimson page gradients, red cabinet, orange food and yellow snake |
| Arcade theme — cartoony **animated arcade machine** around the playfield | `.cabinet` marquee/deck/joystick; playfield size unchanged |
| Violet theme — **stationary blurred swirl** like food colouring dropped in water | `img/violet-swirl.jpg` behind a CSS blur, never animated |
| Game performance first | no `shadowBlur`, dirty-frame rendering, cached visibility, decoration suspended during play |
| Outlined **Leaderboard** and **Self Host** navigation buttons | header links; pause safely before navigating during play |
| One-click container self-hosting, Podman first (masthead "Self Host" button, in-page band, copy buttons) | `#manual` band + `compose.yaml` + `.env.example` |
| Black playfield, grey rounded bezel, slightly-rounded screen corners | `public/game.css` (`.snake-frame` / `.snake-field`) |
| Green snake drawn as **one continuous rectangle** — no borders between blocks | Arcade theme rendering in `public/game.js` |
| Red box of food | `public/game.js` |
| Walls wrap to the other side | modular head step + phosphor flash on the exit edge |
| Starts at 3 blocks long | `startLength: 3` |
| WASD **and** arrow keys | `public/game.js` — `KEYMAP` |
| Scoreboard: current score + all-time best | `public/app.js` + scores API |
| One point per food box | `public/game.js` |
| Mobile swipes steer the snake, never scroll the page mid-run | non-passive `touchmove` + `body.is-playing` lock |
| Score always visible: a **live score HUD** above the box, plus a **small current-score panel** in the top-left of the window for the whole run | `#hud`, `#hud-float`, `revealPlayfield()` |
| Compact scoreboard with this mode's best/average/last and your **recent runs** | `#scoreboard`, history kept on this device; Controls stays directly below it |
| **30% bigger game box**: sized by the window height so the whole playfield always fits; the rail moves under the game below 1700px wide | `--screen-max` in `public/styles.css` |
| Violet **glass panels** behind text so it stays readable over the swirl | `.card`/`.lb`/`.hud`/`.dialog` frosted glass in `public/styles.css` |
| Leaderboard **flashes and highlights your row** after you save, so the save is unmistakable | `tr.just-saved` in `public/app.js` |
| Prominent signed-in indicator (pulsing dot + name) | `.chip__dot` in `public/styles.css` |
| Speed setting | 6 presets (Chill 165 ms → Ludicrous 42 ms) **or custom 0–100 ms/step** |
| Growth multiplier | ×1 → ×5 blocks per food **or custom 0–100** |
| Modifiers shown on the final score screen | `#panel-over` → Speed / Growth / Best here |
| Score isolated per modifier combination | `scores.combo` = `speed_level-growth` |

## Repository layout

```
.
├── compose.yaml            #    app + postgres:16-alpine, one volume (Podman or Docker compose)
├── Dockerfile              #    the canonical app as a container (Rails); both engines build it
├── .env.example            #    copy to .env; set SECRET_KEY_BASE
├── install.sh              # bare-metal alternative (Fedora/Ubuntu, mise + systemd)
├── README.md
├── public/                 # ← single source of truth for the shared game assets
│   ├── game.js             #    canvas engine (no dependencies)
│   ├── app.js              #    scoreboard / settings / auth / leaderboard wiring (game page)
│   ├── profile.js          #    the profile page: stats, charts, heatmap, game log
│   ├── game.css            #    the cabinet: grey bezel + black screen
│   ├── styles.css          #    page chrome + themes
│   ├── multiplayer/        #    lobby page module + stylesheet (isolated from app.js)
│   ├── violet-mist.svg     #    source-text Violet fallback; always included
│   └── img/                #    optional photos: metal.jpg and violet-swirl.jpg
├── src/, package.json …    # preview app (see "The preview in this sandbox")
└── rails/                  # ← the canonical Ruby on Rails application
    ├── app/controllers/    #    SnakeController, ProfileController, Api::{Scores,Auth,Leaderboard,Profile,Games,Rooms}Controller
    ├── app/models/         #    Score, User, Room, RoomMembership, GuestSession
    ├── app/views/snake/    #    the game page (ERB)
    ├── app/views/profile/  #    the profile page shell (ERB)
    ├── bin/                #    rails, setup, sync-assets, docker-entrypoint
    └── .mise.toml          #    pins Ruby 3.3.6 for mise (bare-metal only)
```

The game engine, stylesheet and page CSS are written **once**, in `public/`.
`rails/bin/sync-assets` copies them into `rails/public/` for bare-metal installs;
the container image copies them at build time. The Rails app and the preview
can never drift apart.

---

## Run it in a container — native Podman Compose

**One container. Two commands. Yours.** No project helper script. Use the native
command from the repository root (the folder containing `compose.yaml`,
`Dockerfile`, `rails/`, and `public/`):

```bash
podman compose up --build -d
```

The command includes **`up`**. `podman compose --build -d` alone is incomplete.
Docker remains compatible: use `docker compose up --build -d` with the same
files. The command, not an `.env` variable, selects the engine.

### Install prerequisites

```bash
# Fedora (rootless containers, SELinux stays enforcing)
sudo dnf install podman podman-compose container-selinux openssl

# Ubuntu / Debian
sudo apt update
sudo apt install podman podman-compose openssl
```

Use a current Podman release with `podman compose` support (Podman 5.x is
recommended). Run Podman as your regular user, not with `sudo`: rootful and
rootless Podman keep separate images, volumes, and containers.

### First startup

From your extracted or cloned repository:

```bash
git clone https://github.com/HelloJesusBeloved/next-level-snake
cd ./next-level-snake
cp .env.example .env
# Fill in a private session-signing key; never use a published example key.
sed -i "s/^SECRET_KEY_BASE=.*/SECRET_KEY_BASE=$(openssl rand -hex 64)/" .env
# Set DATABASE_PASSWORD in .env before the FIRST start if going public.
podman compose up --build -d
```

Open <http://localhost:3000>. Compose starts Rails/Puma and PostgreSQL 16. The
entrypoint waits for PostgreSQL and applies migrations before starting Puma.
The database uses persistent volume `pgdata`; it is not exposed on a host port.

### Operate it directly

```bash
podman compose ps
podman compose logs -f app
podman compose exec app bin/rails console
podman compose exec -T db pg_dump -U snake snake_production > snake.sql
podman compose down                     # keeps your database
podman compose up --build -d             # rebuild after an update
podman compose up -d --force-recreate    # apply changed .env settings
```

Back up before upgrading. `podman compose down -v` **deletes the database**;
it is not a fix for a build or permission problem.

### Fedora / SELinux

This setup is designed to work with **SELinux enforcing**, without privileged
mode, broad permissions, or `label=disable`:

* Application files are **copied into the image**, not bind-mounted from your
  home directory. The image runs as a non-root `rails` user.
* The database uses `pgdata:/var/lib/postgresql/data:Z`. Podman gives it a
  **private SELinux label** readable by that database container. Named volumes
  avoid home-directory labels and rootless host-directory ownership problems.
* If you deliberately replace the named volume with a host directory, use a
  dedicated directory and `./postgres-data:/var/lib/postgresql/data:Z`. Never
  relabel your entire home directory or system directories. Ownership still
  needs to match PostgreSQL's container UID; keeping the named volume is safer.
* `:z` is for a directory intentionally shared between multiple containers;
  the default database is private, so it uses uppercase `:Z`.
* If you serve the app directly and Fedora's firewall blocks external traffic:
  `sudo firewall-cmd --permanent --add-port=3000/tcp` then
  `sudo firewall-cmd --reload`. Do this only if you intend to expose that port.
* If an SELinux-confined nginx is your reverse proxy, it may need
  `sudo setsebool -P httpd_can_network_connect on` to reach Puma. This is a
  reverse-proxy permission, not a reason to disable SELinux for containers.

The `:Z` suffix is also accepted by Docker Compose; on non-SELinux hosts it has
no labeling effect, so a separate Docker configuration is unnecessary.

### Which Compose provider is running?

`podman compose` uses an external provider. A message mentioning
`/usr/libexec/docker/cli-plugins/docker-compose` is **normal**: that provider is
communicating with Podman. It does not mean this project switched to Docker.

If you explicitly prefer the Python provider:

```bash
PODMAN_COMPOSE_PROVIDER=podman-compose podman compose up --build -d
```

When your chosen provider requires Podman's API socket, enable it with
`systemctl --user enable --now podman.socket`. For a headless Fedora server,
`sudo loginctl enable-linger "$USER"` allows user services to remain active
after logout; configure a user service/Quadlet if you need managed reboot startup.

### Fixing the reported missing-image build error

The earlier Dockerfile required `COPY public/img/ ...`. Source archives can omit
binary assets, leaving that directory absent; the build then fails before Rails
starts. That is a **missing build-context source**, not an SELinux denial.

The Dockerfile now uses **`COPY public/ /app/public/`**. The required scripts and
styles are source files in `public/`; photos are optional. `violet-mist.svg` is a
committed source-text fallback, so the Violet theme still works without photos.
The bare-metal asset sync also tolerates a missing `public/img/`.

After getting these updated files, build from the repository root:

```bash
podman compose build --no-cache app
podman compose up -d
```

If the log still shows `COPY public/img/`, it is building the **old Dockerfile**.
Verify the checkout and `build.context: .` in `compose.yaml`. Do not delete your
database volume or disable SELinux to fix a missing source file.

### Image details

* Fully qualified Ruby/PostgreSQL image names avoid Podman's short-name prompts.
* Ruby is pinned in the image; mise still manages the bare-metal setup.
* A slim Ruby base and separate gem-build stage keep compilers and development
  gems out of the production image. There is no Node runtime or asset pipeline
  in the Rails image; game and profile assets are served from `public/`.
* `.dockerignore` includes only Rails and shared public files, excluding secrets,
  build caches and preview dependencies; it explicitly includes optional photos.
* The entrypoint's `pg_isready` loop is the startup gate even on older Compose
  providers that do not fully enforce `condition: service_healthy`.

## Bare metal (Fedora / Ubuntu) — wouldn't personally recommend

```bash
chmod +x install.sh
sudo ./install.sh        # detects dnf vs apt automatically
```

`install.sh` installs system packages (compiler, libpq headers, PostgreSQL
server), starts and provisions the database, installs
**[mise](https://github.com/jdx/mise)** and the Ruby pinned in
`rails/.mise.toml`, installs gems, syncs the shared assets, writes
`rails/.env` with a generated `SECRET_KEY_BASE`, runs `db:prepare`, and
installs + starts the `snake.service` systemd unit.

Options: `--port N`, `--no-start`, `--yes`, `--help`.

### Manual (any machine with mise)

```bash
curl https://mise.run | sh          # install mise
cd rails
mise install                        # Ruby 3.3.6 from .mise.toml
mise exec -- gem install bundler
mise exec -- bundle install
bin/sync-assets
cp .env.example .env                # then edit it
mise exec -- bin/rails secret       # paste into SECRET_KEY_BASE
mise exec -- bin/rails db:prepare
mise exec -- bin/rails server       # http://localhost:3000
```

## Configuration

The container stack reads `.env` at the repository root (see `.env.example`);
bare-metal reads `rails/.env` (see `rails/.env.example`).

| Variable | Default | Meaning |
| --- | --- | --- |
| `RAILS_ENV` | `production` | Rails environment |
| `BIND_ADDRESS` / `PORT` | `0.0.0.0` / `3000` | Published host address/port; use `127.0.0.1` behind a local proxy |
| `SECRET_KEY_BASE` | *(generated)* | **required** in production — signs sessions |
| `DATABASE_HOST` / `DATABASE_PORT` | `localhost` / `5432` | PostgreSQL location (`db` inside compose) |
| `DATABASE_USER` / `DATABASE_PASSWORD` | `snake` | PostgreSQL credentials |
| `DATABASE_NAME` | `snake_production` | PostgreSQL database |
| `DATABASE_URL` | — | if set, wins over the discrete settings above |
| `RAILS_FORCE_SSL` | `false` | `true` when TLS terminates in front of Puma |
| `RAILS_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `RAILS_MAX_THREADS` / `WEB_CONCURRENCY` | `5` / `0` | Puma threads / worker processes |
| `MULTIPLAYER_PRESENCE_TIMEOUT` | `90` | seconds before a quiet lobby member shows as *away* |
| `MULTIPLAYER_HOST_GRACE` | `120` | seconds a silent host keeps the crown before it passes on |
| `MULTIPLAYER_MEMBER_DROP` | `600` | seconds before a silent member's seat is released (identity kept) |
| `MULTIPLAYER_ROOM_IDLE` | `1800` | seconds an empty room survives before it expires |
| `MULTIPLAYER_MAX_ROOM_SIZE` | `64` | hard ceiling a room can expand into (rooms start at 8 and grow on their own) |
| `MULTIPLAYER_POLL_INTERVAL` | `5` | lobby poll interval handed to the page (fallback while the socket is down) |
| `ACTION_CABLE_URL` | — | absolute `wss://` URL for the socket when it is not same-origin |
| `ACTION_CABLE_ALLOWED_ORIGINS` | same-origin | extra origins allowed to open a socket (proxies / tunnels) |
| `ACTION_CABLE_WORKER_POOL` | `4` | Action Cable channel worker threads per process |
| `RAILS_DB_POOL` | threads+4 | AR pool, sized for Puma threads **plus** cable workers |
| `MULTIPLAYER_PUBLIC_ORIGIN` | request origin | canonical origin for share links & QR codes (e.g. `https://play.example.com`) — set it on real deployments |

## Accounts & the leaderboard

* Accounts are **username + password only — no email**, which means there is
  no password reset flow. The sign-up dialog carries the full warning (store it
  safely, we recommend a password manager — and [Proton Pass]
  (https://proton.me/pass) specifically). Passwords are stored as bcrypt
  digests (Rails) / scrypt hashes (preview) — never in plaintext.
* Sessions: Rails signed cookie (30 days) on bare metal / in the container; a
  `sessions` table + httpOnly cookie in the preview.
* **Only signed-in runs are saved.** Completed games appear on the public
  **Standard** (presets) and **Custom** (any custom slider) boards, ranked by
  score. A player appears once per board per modifier combination.
* Quits at **10 points or less** are discarded. Quits **above 10** appear in
  Recent runs and the profile game log and count toward **Total Games**, but
  never award XP or affect records, averages, rankings, or the leaderboards.
* **Guests can play, but nothing is stored.** The server refuses guest writes
  (`401`), and the game-over screen says so. A guest's finished run is held
  and saved the moment they sign in, as long as they sign in before starting
  another run. Signing out, or starting a new run, discards it.
* The scoreboard's **Best** is the signed-in player's own best per
  combination; for guests it is the best on this device. **Recent runs** are
  kept on this device only (never sent anywhere unless you are signed in).
* **Sessions work inside embedded frames.** Browsers refuse to keep a cookie
  for a page framed by another site (hosted previews, dashboards, strict
  privacy modes), so every request looks anonymous. The preview therefore also
  returns the session token and the page sends it as `Authorization: Bearer`.
  The server accepts either, header first. The token is also kept in memory,
  so sign-in and saving work for the whole session even when the browser blocks
  **both** cookies and `localStorage` (verified in a Safari-like engine inside a
  cross-site frame). The save note only says "Saved" after the server confirms;
  if the session is not recognised it says so and keeps the run until you sign
  in again. After a save, the leaderboard reloads and your row flashes and
  stays highlighted without moving the page.
* Writes must be `application/json` (`415` otherwise), which also blocks
  cross-site form posts.
* The anonymous per-combination bench has been removed. Migration
  `20260104000000_remove_anonymous_scores` deletes leftover guest rows once and
  makes every run require an owner. Deleting an account deletes its runs.
* After a run ends, the next one cannot start for **one second**. Keys pressed
  in that window are ignored, and "Play again" is disabled for the same time.
* Usernames: 2–20 chars, letters/digits/`_`/`-`, unique case-insensitively.
  Passwords: 6–128 chars.
* While a run is in play the whole modifier card (themes, speed, growth)
  is locked; the pause menu shows the run's modifiers and a **Quit
  run** button, and the on-screen button reads **Unpause** while paused.

## Themes

Seven cabinet skins, pickable in settings (persisted in localStorage, applied
before first paint):

| Skin | Look |
| --- | --- |
| **Arcade** | the default — a **cartoony animated arcade machine** (blue marquee with blinking bulbs, cherry-red cabinet, blue control deck, red joystick and buttons) on a **blue and red page**: navy background with blue and red glows, red accents, blue secondary accents. The snake stays green. The screen inside is the playfield, the same grid in every theme |
| **Classic** | pure black field, one **smooth, square-ended green body** — cells are merged into pixel-aligned row spans and filled once, with no seams, per-cell glow, grain, or scanlines |
| **Vintage** | Nokia 3310: pale LCD field, **square discrete tiles**, steady (non-blinking) food, squared-off bezel |
| **Terminal** | phosphor green, **subtle Matrix code rain behind the page** (8 rows/second in larger 20px glyphs); a blinking `>` inside the game box only before/after play or while paused |
| **Paper** | light editorial theme — cream page, ink-dark snake, crimson food |
| **Violet** | deep violet night over a **stationary, blurred, swirling backdrop** — a photograph of violet, magenta and cyan food colouring curling through water, blurred with CSS and painted once (never animated). Text sits on **glassy, filmy, rounded frosted panels** (blur + translucent fill + bright top edge) so it stays readable over the swirl; cyan-glow snake, pink food |
| **Royal Sunset** | deep-red page gradients and crimson panels/cabinet, orange accents and food, bright yellow snake |

Themes affect the page chrome, bezel colour and corner radii, and the canvas
palette/rendering. Matrix rain never appears inside the game box. Rain and
cursor animations respect the browser's reduced-motion preference.

Cabinet art is positioned **outside** the frame's padding box (a border is
offset by an equal padding reduction), so the playfield has identical
dimensions in every theme — the arcade machine changes the furniture, never
the gameplay.

## Performance

The snake's frame budget comes before decoration, everywhere:

* **No `ctx.shadowBlur`.** It is the most expensive thing a 2D canvas can do.
  Glows are a wide translucent second stroke pass, and the halo colours are
  computed once per theme change instead of per frame.
* **Dirty-frame rendering.** The canvas repaints only when the board actually
  changed (a step, new food, wrap flash, resize, theme switch). An idle or
  paused board issues **zero** paints — asserted in the test suite.
* **No forced layout on input.** Whether the cabinet is on screen is cached by
  an `IntersectionObserver`, so a keypress never triggers
  `getBoundingClientRect()` and its synchronous layout.
* **Zero per-frame allocation** in Classic's row-span pass (scratch array
  reused), and no `slice()`/`sort()` garbage per step.
* **Decoration yields to play.** The Terminal rain loop is suspended while a run
  is active and resumes on pause or quit. Violet's mist is a static painted
  layer. `prefers-reduced-motion` disables every decorative animation.
* **Fixed timestep** decoupled from refresh rate, at most six catch-up steps per
  frame; a custom speed under 16 ms steps exactly once per frame.
* **Input path:** a two-entry direction queue applied at step boundaries. All
  touch listeners are passive except the single `touchmove` that must cancel
  page scrolling, and only `preventDefault`s while actively playing.

## Game layout and result screen

* **Controls sits directly beneath Recent runs**, in the same natural-height
  column. The recent-run card displays the saved device history (up to 30 runs),
  grows as entries are added, and pushes Controls down instead of scrolling inside
  a fixed-height card. Settings is the neighboring column on larger layouts.
* **Game Over fits inside the playfield with no scrollbar.** Title/score share a
  row, all three modifier readouts remain visible, and sign-in/save status plus
  Play again/Quit remain reachable. For an exceptionally short box, event-driven
  panel fitting is the fallback; it never runs per game frame or direction key.
* Saving does not automatically scroll away to the leaderboard.
* The small score panel appears at the **top-left** while running or paused.
  It is click-through, and start/resume leaves clearance above the playfield so
  it does not cover the snake. Best and mode remain in the larger HUD/scoreboard.

## Mobile controls and pause

* During active play, **swipe anywhere on the site** to steer — not just inside
  the game box. Document-level touch listeners and a fixed-body scroll lock
  prevent the page from moving, including iOS overscroll.
* **Pause unlocks scrolling** and restores your page position. Swipes while
  paused scroll normally and never queue snake turns. **Resume locks the page
  again** and returns gesture control to the snake.
* Taps are never cancelled, so pause/unpause, navigation, and account buttons
  remain usable. The pause button (touch screens only) floats within reach
  throughout a run, including while paused and scrolled down to the leaderboard.
  Desktop pauses with <kbd>P</kbd> or <kbd>Esc</kbd>.
* The game box is **30% bigger** than before. It is sized by the **window
  height** — the playfield plus its frame must fit under a 52px strip at the top
  — so you always see all of it. Measured against the previous size: **+30%** on a
  1365×960 laptop (869→1133px wide), **+27%** at 1920×950, **+23%** at 1920×1080
  (taller/wider screens gain less because the whole box must stay on screen),
  and about **+7%** on phones, which are already limited by their width. The grid
  is still 24×18, so gameplay is unchanged; only the drawing is scaled.
* To make room, the scoreboard + Controls stack and settings sit **under** the game below
  1700px wide (beside it on larger monitors). The cabinet art (marquee, control
  deck) is decoration and may extend past the window.
* Starting or resuming scrolls the page by the least amount that puts the **whole
  playfield** in view, then locks it there. The score never needs page space: a
  small **current-score panel** is pinned to the top-left of the window for
  the whole run. If everything already fits, the page does not move. Pausing always
  unlocks the page, so the header buttons are reachable then.
* The outlined **Leaderboard** and **Self Host** buttons pause before navigating.
  Opening an account dialog also pauses; typing WASD or P into form fields
  cannot steer, start, or unpause the game.
* Modifiers remain locked even when the game is paused; quit or finish the run
  before changing them.

## Browser regression checks

With the preview or Rails container already running:

```bash
npm install
npx playwright install --with-deps chromium
npx playwright test
# Optional: test the same shared assets on another running deployment:
PLAYWRIGHT_BASE_URL=http://localhost:3000 npx playwright test
```

The suite covers desktop and mobile navigation/taps, **native touchscreen
swipes and scrolling**, pause/resume locks, account input isolation, Terminal
cursor visibility and rain speed, and pixel-level checks for Classic seams.
Layout-only checks mock the API. Account/profile/leaderboard checks use temporary accounts in the real database and remove their own data afterward.

## Custom modifiers

Both "Snake speed" and "Growth per food" offer a **Custom** option on a 0–100
slider:

* **Speed (ms per step):** `0` is as fast as the display goes (one step per
  frame), `100` is a lazy 100 ms crawl.
* **Growth (blocks per food):** `0` (never grows — pure survival) to `100`.

A run is in **custom mode** when at least one modifier is custom. Custom runs
are isolated like any other combination (combo keys look like `c42-c7`) and are
ranked in their **own leaderboard** — the Custom mode hall — so a 0 ms snake
never shadows a Normal one. Modifiers are locked for the duration of a run.

## Profile page

Open **Profile** in the header (or `/profile`). It needs an account — guests get a
sign-in prompt. Everything is drawn client-side by `public/profile.js` from one
request to `GET /api/profile`:

* **Hero** — your username, member-since date, games logged, favorite theme.
* **Stat tiles** — games played (and the last 30 days), best score (and its mode),
  average score (and your last 10), food eaten, active days, and your day streak.
* **Progress chart** — hand-built SVG: a dot per game, a 5-game rolling average, and
  a dashed "best so far" line, with a mode selector and a plain-English trend
  ("your last 10 games average 12.3 — up 4.1 from the 10 before").
* **Activity heatmap** — like a Git profile: one cell per day for the last year,
  columns are weeks, five intensity levels, hover for the exact count.
* **Favorite mode** — your most-played speed × growth combination, with bars for
  your top modes. **High scores** — your best run in every mode.
* **Favorite theme** — pick one of the seven skins. It is saved to your account and
  shown on your profile; **Play in this theme** also makes the game open in it.
* **Game log** — every game with its score, mode, time, whether it ended in a crash
  or a quit, snake length, and a **mini board of where the snake ended up** (head,
  body, the food, and an ✕ on the cell it crashed into). Filter by mode; remove any
  game with a confirm step.

**Removing a game removes it from the leaderboard too.** The log and the boards are
the same data (the leaderboard is each player's best run per mode, computed from
it), so there is one source of truth and nothing can drift out of step.

**How the ending position is stored.** When a run ends the engine reports the grid
size, the snake's cells (head first), the food and the crash cell as `y*cols+x`
indexes — about 1.7 KB for a 432-cell snake instead of ~5 KB as pairs, which matters
because the whole log loads at once. The server rebuilds it from validated pieces
and drops it if it is malformed (out-of-range cells, repeats, absurd sizes); a bad
snapshot never stops the score itself from saving. Games from before this feature
show "no snapshot". Data model: `scores.end_state` (jsonb) and `users.favorite_theme`.

## HTTP API

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| `GET` | `/api/scores` | — | `{ best }` — the caller's own best per combination (empty for guests) |
| `GET` | `/api/leaderboard` | `?board=standard\|custom&speed=…&growth=…` | `{ board, total, rows[] }`, top 25, ranked; `400` on a bad filter |
| `POST` | `/api/scores` | `{ score, speed_level? \| speed_custom?, growth? \| growth_custom?, end_state? }` | `201 { ok, best }`; `401` for guests; `415` unless JSON |
| `POST` | `/api/auth/signup` | `{ username, password }` | `201 { user: { username }, token }` + session cookie (`token` is preview-only) |
| `POST` | `/api/auth/login` | `{ username, password }` | `200` as above |
| `POST` | `/api/auth/logout` | — | `{ ok: true }`, clears cookie |
| `GET` | `/api/auth/me` | — | `{ user: { username } \| null }` |
| `GET` | `/api/profile` | — | `{ user: { username, favorite_theme, created_at }, games[] }` — your full game log (newest first, up to 1000); `401` for guests |
| `PATCH` | `/api/profile` | `{ favorite_theme: "violet" \| null }` | `{ user }`; `400` for an unknown theme; `401`; `415` unless JSON |
| `DELETE` | `/api/games/:id` | `{}` | `{ ok: true }`; `404` for a missing game **or another player's**; `401`; `415` unless JSON |
| `POST` | `/api/rooms` | `{ display_name?, leave_current? }` | `201` room state, caller is host; `409 in_other_room`; `422` when a guest sends no name |
| `GET` | `/api/rooms/current` | — | the caller's room state, or `{ room: null }` — this is what a page refresh uses |
| `GET` | `/api/rooms/:code` | — | member → full state; anyone else → a join preview; `404` unknown code; `410` disbanded/expired |
| `POST` | `/api/rooms/:code/join` | `{ display_name?, leave_current? }` | room state; `409 room_full` / `in_other_room`; `403` if removed; `410` closed |
| `POST` | `/api/rooms/:code/ready` | `{ ready: true\|false }` | room state with updated ready counts (advisory vote) |
| `POST` | `/api/rooms/:code/leave` | `{}` | `{ room: null, left: CODE }` — the guest identity is kept for reconnecting |
| `POST` | `/api/rooms/:code/start` | `{}` | **host only.** `200 { start: { eligible … }, started: false }`; `422 not_eligible`; `403` otherwise |
| `POST` | `/api/rooms/:code/disband` | `{}` | **host only.** `{ room: null, disbanded: CODE }`; `403` otherwise |
| `POST` | `/api/rooms/:code/host` | `{ member_id }` | **host only.** hands the crown to another member; `403`/`404` |
| `POST` | `/api/rooms/claim` | `{}` | links this browser's guest seat to the signed-in account; `401`/`404`/`409` |

`score` is an integer `0..1000000`. For speed you provide **exactly one** of
`speed_level` (`1..6`) or `speed_custom` (`0..100`); for growth, exactly one
of `growth` (`1..5`) or `growth_custom` (`0..100`). `best["4-3"]` is the
all-time best at Fast ×3 and `best["c42-c7"]` is the best at a 42 ms custom
speed with ×7 custom growth — no two combinations ever compare.
The leaderboard returns each signed-in user's best run per combination, ranked
globally. Filter values are `all`, a preset number (speed `1`–`6`, growth `1`–`5`),
`c` (any custom value) or `cNN` (exactly that custom value, `0`–`100`). Standard
only ever contains preset runs; Custom contains runs with at least one custom
slider.

## Multiplayer rooms

`/multiplayer` is a working lobby; the Brawl match engine is not built yet.

* **Create a room** and you are its host, marked with a crown (👑) in the
  roster. You get a 12-character invitation code and an invite link
  (`/multiplayer/CODE`) that opens the page straight onto that room. There is
  no size to pick: rooms start at 8 seats and **expand by themselves** as
  players pile in, up to `MULTIPLAYER_MAX_ROOM_SIZE`.
* **Guests never need an account.** Enter a display name and join. The server
  issues an httpOnly guest cookie, so a plain refresh — or a closed laptop
  reopened minutes later — restores the same seat. Sign In / Create Account
  sit beside it, and signing in while seated *links* that seat to the account
  (the room display name stays room-local; your username never changes).
* **Ready votes are advisory.** The roster shows who is ready and who is away;
  the host alone decides when a Brawl begins, and a Brawl needs at least two
  connected players. Today `POST /api/rooms/:code/start` answers the
  eligibility question and deliberately starts nothing.
* **Leaving, succession and expiry.** Leaving keeps your identity so you can
  come back to the same seat. If the host leaves, the crown passes immediately
  to the longest-seated member; if the host simply goes silent, it passes after
  `MULTIPLAYER_HOST_GRACE`. An emptied room keeps working for anyone who
  rejoins, then expires after `MULTIPLAYER_ROOM_IDLE`. Hosts can disband a room
  outright; invalid, disbanded and expired codes each say so (`404` / `410`).
* **Switching rooms is deliberate**: the server refuses with `409 in_other_room`
  and the page asks before leaving the room you are already in.
* **Invitations & QR (step 5).** The lobby's sharing panel shows the code and
  the direct join URL, with **Share Room** (native Web Share API when the
  browser has it), **Copy Link** (always present, with visible success/failure
  feedback) and a **QR code drawn locally** from vendored open-source tooling
  (`qrcode-generator` for drawing, `jsQR` as the decoder fallback — no frame
  ever leaves the device). **Scan QR Code** opens the built-in camera scanner
  (entry card or sharing panel): it requests camera access, decodes in-page
  via native `BarcodeDetector` when available, validates the payload against
  this application's own room routes and the configured public origin before
  navigating **in the same tab**, and releases the camera on success, failure,
  cancel or Escape. Denied permissions, missing cameras, insecure (non-https)
  contexts and unsupported browsers each get a plain-language message and the
  paste-the-code fallback. Invitation URLs use `MULTIPLAYER_PUBLIC_ORIGIN`
  when set, never a hardcoded host.

**Real-time (Action Cable).** Lobbies synchronize over a WebSocket at
`/cable` (`RoomChannel`, stream `rooms:<code>`): joins, leaves, ready votes,
host succession, disbanding and expiry arrive in every open tab immediately —
no refresh. The socket authenticates with the *same* credentials as the API
(the session cookie, or the encrypted guest cookie), subscription and channel
actions are re-authorized server-side, and every event carries the room's
monotonic `version` so clients drop stale updates and refetch the
authoritative snapshot whenever they (re)connect or detect a gap. The
broadcast backend is **PostgreSQL LISTEN/NOTIFY** (adapter `postgresql` in
`config/cable.yml`) so multiple Puma workers or containers all share events —
never process-local broadcasting. See
`rails/docs/multiplayer-transport.md`. When the socket is down the page falls
back to `MULTIPLAYER_POLL_INTERVAL` HTTP polling, which doubles as the
presence heartbeat. Duels, rankings, archives and QR invitations are not
implemented yet.

### Database access

Browser tests that check accounts and the leaderboard write to the real database, then
delete the accounts they create. They read `DATABASE_URL` (default
`postgresql://postgres:postgres@127.0.0.1:5432/app_db`). Set it when testing a
deployed server.

## Production notes (HTTPS)

Run behind nginx/Caddy/Traefik terminating TLS, set `RAILS_FORCE_SSL=true` in
the environment, and restart. Example nginx server block is in the
`--help`-adjacent docs of `install.sh` output and below:

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name snake.example.com;
    ssl_certificate     /etc/letsencrypt/live/snake.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/snake.example.com/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## The preview in this sandbox

The page you are looking at is served by the Next.js app at the repository root
so it can run in a hosted development browser. It is **not** a second
implementation: it loads the exact same `public/game.js`, `public/game.css`,
`public/styles.css` and `public/app.js` that the Rails app serves, and its API
routes mirror the Rails controllers byte for byte in shape (PostgreSQL via
Drizzle ORM: same tables, same leaderboard query, scrypt instead of bcrypt).
Ship the Rails container; the preview exists so you can play immediately.

The preview's `GameRuntime` client component loads the engine and then the UI
**after hydration**, so React cannot replace the game canvas or detach its
button handlers during startup. Rails loads those same scripts normally.

## Uninstall

```bash
podman compose down -v            # containers + database volume; DELETES stored games
# or, for a bare-metal install:
sudo systemctl disable --now snake
sudo rm -f /etc/systemd/system/snake.service
sudo systemctl daemon-reload
sudo -u postgres dropdb snake_production
sudo -u postgres psql -c "drop role snake"
```

## Licence

MIT.
its API
routes mirror the Rails controllers byte for byte in shape (PostgreSQL via
Drizzle ORM: same tables, same leaderboard query, scrypt instead of bcrypt).
Ship the Rails container; the preview exists so you can play immediately.

The preview's `GameRuntime` client component loads the engine and then the UI
**after hydration**, so React cannot replace the game canvas or detach its
button handlers during startup. Rails loads those same scripts normally.

## Uninstall

```bash
podman compose down -v            # containers + database volume; DELETES stored games
# or, for a bare-metal install:
sudo systemctl disable --now snake
sudo rm -f /etc/systemd/system/snake.service
sudo systemctl daemon-reload
sudo -u postgres dropdb snake_production
sudo -u postgres psql -c "drop role snake"
```

## Licence

MIT.
