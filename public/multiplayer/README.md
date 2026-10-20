# Multiplayer frontend

`GET /multiplayer` renders `rails/app/views/snake/multiplayer.html.erb` through
`SnakeController#multiplayer` and the existing Rails application layout.

- `page.js` is the page's native ES-module entry point. Add future frontend
  modules alongside it and import them here; no bundler is required.
- `#multiplayer-root` is the dedicated page mount point.
- The shared layout restores the saved theme from `snake.settings.v1` before
  paint. The page reuses `styles.css` and `rain.js`; its only JavaScript behavior
  currently enables the existing Terminal background.
- The `content_for :scripts` block deliberately replaces the layout's default
  `game.js` / `app.js` scripts. Do not initialize the single-player engine here.
- No rooms, networking, multiplayer API, game loop, or pretend controls exist yet.
  Account management remains on the existing game and profile pages.

The container's existing `COPY public/` and bare-metal `rails/bin/sync-assets`
both include this directory. Edit the root `public/` sources, never their
copied `rails/public/` counterparts.

To check both desktop and mobile navigation against a running **Rails** app:

```sh
bash rails/bin/sync-assets
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3000 npx playwright test tests/browser/multiplayer.spec.mjs
```

The tests use real page routes without mocking the API. They do not create
accounts or submit scores. The repository's `src/` preview is not the target.
