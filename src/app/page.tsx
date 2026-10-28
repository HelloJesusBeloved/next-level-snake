import { LEVELS } from "@/lib/levels";
import GameRuntime from "@/components/game-runtime";

export default function Home() {
  return (
    <>
      <div className="page-texture" aria-hidden="true" />
      <div className="page-scrim" aria-hidden="true" />
      <canvas id="matrix-rain" className="matrix-rain" aria-hidden="true" />

      <div className="spine" aria-hidden="true">
        <span>
          Next Level Snake <b>/</b> Wall-Wrap Arcade <b>/</b> Rails 8
        </span>
      </div>

      <header className="masthead">
        <div className="masthead__brand-group">
          <div className="masthead__brand">
            <span className="mark" aria-hidden="true" />
            <span className="brand__text">
              <span className="brand__eyebrow">Next Level</span>
              <span className="wordmark">Snake</span>
            </span>
          </div>
          <span className="brand__credit">
            Made almost entirely with{" "}
            <a href="https://arena.ai" target="_blank" rel="noreferrer">arena.ai</a>{" "}
            ❤️
          </span>
        </div>
        <nav className="masthead__meta" aria-label="Main navigation">
          <a className="btn btn--small btn--nav" href="#leaderboard">
            <svg className="nav-icon" viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M6 2h12v2h4v4a5 5 0 0 1-5 5h-.5A6 6 0 0 1 13 15.9V18h3v4H8v-4h3v-2.1A6 6 0 0 1 7.5 13H7a5 5 0 0 1-5-5V4h4V2Zm-2 4v1a3 3 0 0 0 3 3V6H4Zm16 0h-3v4a3 3 0 0 0 3-3V6Z" /></svg>
            Leaderboard
          </a>
          <a className="btn btn--small btn--nav" href="#manual">
            <svg className="nav-icon" viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M4 3h16a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm1 3h2V5H5v1Zm0 2h2V7H5v1Zm12-3h-2v1h2V5Zm0 3h-2V7h2v1ZM4 12h16a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1Zm1 3h2v-1H5v1Zm0 2h2v-1H5v1Zm12-3h-2v1h2v-1Zm0 3h-2v-1h2v1Z" /></svg>
            Self Host
          </a>
          <a className="btn btn--small btn--nav" href="/profile">
            <svg className="nav-icon" viewBox="0 0 24 24" width="15" height="15" fill="currentColor" shapeRendering="crispEdges" aria-hidden="true"><path d="M2 8h20v3H2Zm1 3h6v5H3v-5Zm13 0h6v5h-6v-5Z" /></svg>
            Profile
          </a>
          <a
            className="btn btn--small btn--nav"
            href="https://github.com/HelloJesusBeloved/next-level-snake"
            target="_blank"
            rel="noreferrer"
          >
            <svg className="nav-icon" viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.28-.01-1.04-.02-2.04-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.33-1.76-1.33-1.76-1.09-.74.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.49.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.61-2.81 5.62-5.48 5.92.43.37.81 1.1.81 2.22 0 1.6-.01 2.9-.01 3.29 0 .32.22.69.83.57A12.01 12.01 0 0 0 24 12c0-6.63-5.37-12-12-12Z" /></svg>
            Open Source
          </a>
          <span className="auth-area" id="auth-out">
            <button className="btn btn--small" id="btn-open-login" type="button">Sign in</button>
            <button className="btn btn--small btn--primary" id="btn-open-create" type="button">Create account</button>
          </span>
          <span className="auth-area" id="auth-in" hidden>
            <span className="chip" id="auth-user" />
            <button className="btn btn--small btn--signout" id="btn-logout" type="button">Sign out</button>
          </span>
        </nav>
      </header>

      <main className="shell">
        <section className="stage">
          <div className="stage__head">
            <p className="stage__eyebrow">01 — The game</p>
            <h1 className="stage__title">
              Beautiful.
              <br />
              Modern.
              <br />
              <em>Snake.</em>
            </h1>
            <p className="stage__sub">
              One long green body, a red box of food, and walls that wrap instead
              of ending the run. Preset or fully custom speed and growth, seven
              themes, per-combination records — and signed-in players
              fighting over the hall.
            </p>
          </div>

          <div className="hud" id="hud" aria-label="Current run">
            <div className="hud__cell">
              <span className="hud__label">Score</span>
              <span className="hud__value hud__value--score" data-live-score>0</span>
            </div>
            <div className="hud__cell">
              <span className="hud__label">Best</span>
              <span className="hud__value" data-live-best>—</span>
            </div>
            <div className="hud__cell hud__cell--mode">
              <span className="hud__label">Mode</span>
              <span className="hud__mode" data-live-mode>Normal · ×1</span>
            </div>
          </div>

          <div className="hud-float" id="hud-float" aria-label="Current game score">
            <span className="hud-float__label">Score</span>
            <b data-live-score>0</b>
          </div>

          <div className="screen">
            <div id="snake-root" />

            <button
              className="btn-peek"
              id="btn-peek"
              type="button"
              aria-pressed="false"
              aria-label="Show where the snake ended up"
              title="Show / hide the game-over screen"
              hidden
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button>

            <div className="overlay is-visible" id="overlay">
              <div className="panel is-visible" id="panel-start">
                <p className="panel__eyebrow">Ready</p>
                <h2 className="panel__title">Press a direction to start</h2>
                <p className="panel__body">
                  <kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> or the arrow
                  keys on desktop — swipe anywhere on the page while playing.
                  Drive through a wall and you come out the other side.
                </p>
                <div className="panel__actions">
                  <button className="btn btn--primary" id="btn-start" type="button">
                    Start game
                  </button>
                </div>
              </div>

              <div className="panel" id="panel-pause">
                <p className="panel__eyebrow">Held</p>
                <h2 className="panel__title">Paused</h2>
                <dl className="mods" style={{ marginBottom: 16 }}>
                  <div>
                    <dt>Speed</dt>
                    <dd id="pause-speed">Normal · 105 ms / step</dd>
                  </div>
                  <div>
                    <dt>Growth</dt>
                    <dd id="pause-growth">×1 blocks per food</dd>
                  </div>
                </dl>
                <p className="panel__body">
                  You can scroll while paused. Modifiers stay locked for this
                  run. <kbd>Enter</kbd>, <kbd>P</kbd> or any steering key resumes; <kbd>Esc</kbd> quits.
                </p>
                <p className="panel__hint">After you resume, pausing again is locked for 5 seconds.</p>
                <div className="panel__actions">
                  <button className="btn btn--primary" id="btn-resume" type="button">
                    Resume
                  </button>
                  <button className="btn" id="btn-quit" type="button">
                    Quit run
                  </button>
                </div>
              </div>

              <div className="panel" id="panel-pause-confirm">
                <p className="panel__eyebrow">Hold up</p>
                <h2 className="panel__title">You for sure want to quit the run man?</h2>
                <p className="panel__body">
                  <kbd>Esc</kbd> again quits for real. <kbd>Enter</kbd> or any steering key takes you back to the game.
                </p>
                <div className="panel__actions">
                  <button className="btn btn--primary" id="btn-pause-confirm-no" type="button">
                    No, keep playing
                  </button>
                  <button className="btn btn--danger" id="btn-pause-confirm-yes" type="button">
                    Yes, quit
                  </button>
                </div>
              </div>

              <div className="panel result-panel" id="panel-over">
                <div className="result-heading">
                  <div>
                    <p className="panel__eyebrow">Run complete</p>
                    <h2 className="panel__title">Game over</h2>
                  </div>
                  <p className="final">
                    <span className="final__label">Final score</span>
                    <span className="final__value" id="final-score">0</span>
                  </p>
                </div>
                <dl className="mods result-mods">
                  <div>
                    <dt>Speed</dt>
                    <dd id="final-speed">Normal · 105 ms / step</dd>
                  </div>
                  <div>
                    <dt>Growth</dt>
                    <dd id="final-growth">×1 blocks per food</dd>
                  </div>
                  <div>
                    <dt>Best here</dt>
                    <dd id="final-best">—</dd>
                  </div>
                </dl>
                <p className="flag" id="final-flag" hidden>
                  New best for this mode
                </p>
                <div className="save-note" id="final-save" hidden>
                  <button className="save-note__close" id="btn-final-save-close" type="button" aria-label="Dismiss, and don't show this again" title="Don't show this again" hidden>✕</button>
                  <p id="final-save-text" />
                  <div className="panel__actions" id="final-save-actions">
                    <button className="btn btn--small btn--primary" id="btn-final-signin" type="button">
                      Sign in
                    </button>
                    <button className="btn btn--small" id="btn-final-create" type="button">
                      Create account
                    </button>
                  </div>
                </div>
                <div className="panel__actions">
                  <button className="btn btn--primary" id="btn-again" type="button">
                    Play again
                  </button>
                  <button className="btn" id="btn-quit-over" type="button">Quit</button>
                </div>
              </div>
            </div>
          </div>

          <div className="pausebar">
            <button className="btn" id="pause-btn" type="button">
              Pause
            </button>
          </div>
        </section>

        <aside className="rail">
          <div className="card card--score" id="scoreboard">
            <div className="card__head">
              <h2 className="card__title">Scoreboard</h2>
              <span className="mode-chip" data-live-mode>Normal · ×1</span>
            </div>
            <div className="stat-tiles">
              <div className="stat">
                <span className="stat__label">Score</span>
                <span className="stat__value stat__value--live" id="current-score" data-live-score>0</span>
              </div>
              <div className="stat">
                <span className="stat__label">Best</span>
                <span className="stat__value" id="best-score" data-live-best>—</span>
              </div>
            </div>
            <p className="stat-line" id="mode-stats">No runs in this mode yet</p>
            <div className="xp-meter" id="xp-meter">
              <div className="xp-meter__top">
                <span className="xp-meter__level" id="xp-level">Level —</span>
                <div className="xp-meter__info-wrap">
                  <span className="xp-meter__xp" id="xp-text" hidden>0 / 100 XP</span>
                  <button className="xp-meter__signin" id="xp-signin" type="button">Sign in to earn XP</button>
                  <button type="button" className="xp-info-btn" aria-label="How XP is calculated" tabIndex={0}>
                    <span className="xp-info-icon" aria-hidden="true">i</span>
                    <span className="xp-popover" role="tooltip">
                      <strong>How XP is calculated</strong>
                      <p>XP is earned from completed runs on preset speeds:</p>
                      <ul className="xp-popover__list">
                        <li><span>Chill (165ms)</span><b>×0.6</b></li>
                        <li><span>Easy (130ms)</span><b>×0.8</b></li>
                        <li><span>Normal (105ms)</span><b>×1.0</b></li>
                        <li><span>Fast (80ms)</span><b>×1.3</b></li>
                        <li><span>Insane (60ms)</span><b>×1.6</b></li>
                        <li><span>Ludicrous (42ms)</span><b>×2.0</b></li>
                      </ul>
                      <p className="xp-popover__note">XP = Score × Speed multiplier. Quits and custom sliders earn 0 XP. Level L requires 100 × (L−1)² cumulative XP.</p>
                    </span>
                  </button>
                </div>
              </div>
              <div
                className="xp-meter__bar"
                id="xp-bar"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={0}
                aria-label="Progress to the next level"
              >
                <i id="xp-fill" />
              </div>
              <span className="xp-meter__next" id="xp-next" />
            </div>
            <h3 className="mini-title">Recent runs <span>this device</span></h3>
            <ol className="runs" id="recent-runs" aria-label="Recent runs">
              <li className="runs__empty">Play a run and it shows up here.</li>
            </ol>
          </div>

          <div className="card" id="settings-card">
            <div className="card__head">
              <h2 className="card__title">Modifiers</h2>
              <span className="lock-badge" id="settings-lock" hidden>
                In play — locked
              </span>
            </div>

            <div className="setting">
              <div className="setting__head">
                <h3>Theme</h3>
                <span className="setting__value" id="theme-value">Classic</span>
              </div>
              <div className="segmented" id="settings-theme" role="group" aria-label="Theme">
                <button type="button" data-theme="classic" aria-pressed="true">
                  <span className="swatch" data-swatch="classic"><i aria-hidden="true" />Classic</span>
                </button>
                <button type="button" data-theme="arcade" aria-pressed="false">
                  <span className="swatch" data-swatch="arcade"><i aria-hidden="true" />Arcade</span>
                </button>
                <button type="button" data-theme="vintage" aria-pressed="false">
                  <span className="swatch" data-swatch="vintage"><i aria-hidden="true" />Vintage</span>
                </button>
                <button type="button" data-theme="terminal" aria-pressed="false">
                  <span className="swatch" data-swatch="terminal"><i aria-hidden="true" />Terminal</span>
                </button>
                <button type="button" data-theme="paper" aria-pressed="false">
                  <span className="swatch" data-swatch="paper"><i aria-hidden="true" />Paper</span>
                </button>
                <button type="button" data-theme="violet" aria-pressed="false">
                  <span className="swatch" data-swatch="violet"><i aria-hidden="true" />Midnight Violet</span>
                </button>
                <button type="button" data-theme="sunsetfire" aria-pressed="false">
                  <span className="swatch" data-swatch="sunsetfire"><i aria-hidden="true" />Royal Sunset</span>
                </button>
              </div>
              <p className="setting__hint">
                Arcade wraps the screen in an animated cabinet. Classic and
                Vintage use square blocks — Classic&apos;s merge into one smooth
                body. Midnight Violet sits on still mist; Terminal rains code behind the
                page, never inside the box.
              </p>
            </div>

            <div className="setting">
              <div className="setting__head">
                <h3>Snake speed</h3>
                <span className="setting__value" id="speed-value">Normal · 105 ms</span>
              </div>
              <div className="segmented" id="settings-speed" role="group" aria-label="Snake speed">
                {LEVELS.map((level) => (
                  <button
                    key={level.id}
                    type="button"
                    data-speed={level.id}
                    aria-pressed={level.id === 3}
                  >
                    {level.label}
                  </button>
                ))}
                <button type="button" data-speed="custom" aria-pressed="false">
                  Custom
                </button>
              </div>
              <div className="custom-row" id="custom-speed-row" hidden>
                <label className="range">
                  <input
                    type="range"
                    id="custom-speed"
                    min={0}
                    max={100}
                    step={1}
                    defaultValue={42}
                    aria-label="Custom snake speed in milliseconds per step"
                  />
                  <span className="range-val" id="custom-speed-val">42 ms/step</span>
                </label>
              </div>
            </div>

            <div className="setting">
              <div className="setting__head">
                <h3>Growth per food</h3>
                <span className="setting__value" id="growth-value">×1 per food</span>
              </div>
              <div className="segmented" id="settings-growth" role="group" aria-label="Growth per food">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    data-growth={n}
                    aria-pressed={n === 1}
                  >
                    ×{n}
                  </button>
                ))}
                <button type="button" data-growth="custom" aria-pressed="false">
                  Custom
                </button>
              </div>
              <div className="custom-row" id="custom-growth-row" hidden>
                <label className="range">
                  <input
                    type="range"
                    id="custom-growth"
                    min={0}
                    max={100}
                    step={1}
                    defaultValue={2}
                    aria-label="Custom growth in blocks per food"
                  />
                  <span className="range-val" id="custom-growth-val">×2 per food</span>
                </label>
              </div>
            </div>

          </div>

          <div className="card" id="controls-card">
            <div className="card__head">
              <h2 className="card__title">Controls</h2>
            </div>
            <div className="keys">
              <div className="keys__row">
                <span>Steer</span>
                <span>
                  <kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> · <kbd>↑</kbd>
                  <kbd>↓</kbd> <kbd>←</kbd> <kbd>→</kbd>
                </span>
              </div>
              <div className="keys__row">
                <span>Start</span>
                <span>
                  <kbd>Space</kbd> <kbd>Enter</kbd>
                </span>
              </div>
              <div className="keys__row">
                <span>Pause</span>
                <span>
                  <kbd>P</kbd> <kbd>Esc</kbd>
                </span>
              </div>
              <div className="keys__row">
                <span>Touch</span>
                <span>Swipe</span>
              </div>
            </div>
          </div>
        </aside>
      </main>

      <section className="band" id="leaderboard">
        <p className="band__eyebrow">02 — The leaderboard</p>
        <h2 className="band__title">One game. Two boards. Everyone watching.</h2>
        <p className="band__lede">
          Signed-in players only. Standard ranks preset modifiers; Custom ranks
          any run that used a custom slider. Each player appears once per
          modifier combination with their best run, so use the filters to see
          exactly the speed and growth you care about. Guests can play, but
          their runs are not saved unless they sign in.
        </p>

        <div className="lb" id="lb">
          <div className="lb__tabs" role="tablist" aria-label="Leaderboard">
            <button className="lb__tab is-active" id="lb-tab-standard" role="tab" aria-selected="true" data-board="standard" type="button">
              <span className="lb__tab-name">Standard</span>
              <span className="lb__tab-sub">Preset modifiers</span>
            </button>
            <button className="lb__tab" id="lb-tab-custom" role="tab" aria-selected="false" data-board="custom" type="button">
              <span className="lb__tab-name">Custom</span>
              <span className="lb__tab-sub">Your own sliders</span>
            </button>
          </div>

          <div className="lb__filters" id="lb-filters">
            <div className="lb-filter">
              <span className="lb-filter__label">Speed</span>
              <div className="lb-filter__chips" id="filter-speed" />
            </div>
            <div className="lb-filter">
              <span className="lb-filter__label">Growth</span>
              <div className="lb-filter__chips" id="filter-growth" />
            </div>
            <div className="lb__actions">
              <button className="btn btn--small" id="filter-mine" type="button">Match my settings</button>
              <button className="btn btn--small" id="filter-reset" type="button">Reset filters</button>
            </div>
          </div>

          <p className="lb__status" id="lb-status" aria-live="polite">Loading the board…</p>

          <div className="lb__scroll">
            <table className="records lb__table">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Player</th>
                  <th scope="col">Speed</th>
                  <th scope="col">Growth</th>
                  <th scope="col">Score</th>
                  <th scope="col">Set</th>
                </tr>
              </thead>
              <tbody id="board-body">
                <tr className="empty"><td colSpan={6}>Loading the board…</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="band band--manual" id="manual">
        <p className="band__eyebrow">03 — Self-hosting · Podman first</p>
        <h2 className="band__title">One container. Two commands. Yours.</h2>
        <p className="band__kicker">Host this website <em>yourself!</em></p>
        <p className="band__lede">
          Run the Rails app and PostgreSQL directly with <code>podman compose up --build -d</code>
          {" "}from the repository root. No helper script. Prefer Docker? Use
          {" "}<code>docker compose up --build -d</code> with the same file.
          Fedora keeps SELinux enforcing: database storage has a private
          {" "}<code>:Z</code> label, and application files are built into the image.
        </p>

        <div className="manual-grid">
          <ol className="steps">
            <li>
              <div>
                <h3>
                  Bring it up{" "}
                  <span className="req">
                    Requires{" "}
                    <a href="https://podman.io/docs/installation" target="_blank" rel="noreferrer">Podman</a>{" "}
                    or{" "}
                    <a href="https://docs.docker.com/engine/install/" target="_blank" rel="noreferrer">Docker</a>
                  </span>
                </h3>
                <p>Builds the image and starts PostgreSQL with persistent, SELinux-labeled storage.</p>
                <pre className="code"><code>{`git clone https://github.com/HelloJesusBeloved/next-level-snake
cd ./next-level-snake
cp .env.example .env
# Set SECRET_KEY_BASE in .env to this generated value:
sed -i "s/^SECRET_KEY_BASE=.*/SECRET_KEY_BASE=$(openssl rand -hex 64)/" .env
podman compose up --build -d`}</code></pre>
              </div>
            </li>
            <li>
              <div>
                <h3>Configure it</h3>
                <p>
                  The whole surface is <code>.env</code> at the repo root —
                  port, secret, database credentials. Restart after editing:{" "}
                  <code>podman compose up -d --force-recreate</code>.
                </p>
                <pre className="code"><code>{`# .env
SECRET_KEY_BASE=<openssl rand -hex 64>
PORT=3000
DATABASE_USER=snake
DATABASE_PASSWORD=snake
DATABASE_NAME=snake_production
RAILS_LOG_LEVEL=info`}</code></pre>
              </div>
            </li>
            <li>
              <div>
                <h3>Open the firewall port</h3>
                <p>
                  If the server firewall is on, open the game port so the box is
                  reachable. Fedora/SELinux uses firewalld; Ubuntu uses ufw.
                </p>
                <pre className="code"><code>{`# Fedora / SELinux (firewalld)
sudo firewall-cmd --permanent --add-port=3000/tcp
sudo firewall-cmd --reload
sudo firewall-cmd --list-ports

# Ubuntu / Debian (ufw)
sudo ufw allow 3000/tcp
sudo ufw reload`}</code></pre>
              </div>
            </li>
            <li>
              <div>
                <h3>Operate it</h3>
                <p>Logs, a console, backups — all one line each, engine-agnostic.</p>
                <pre className="code"><code>{`podman compose logs -f app
podman compose exec app bin/rails console
podman compose exec db pg_dump -U snake snake_production > snake.sql`}</code></pre>
              </div>
            </li>
            <li>
              <div>
                <h3>No containers? Bare metal <span className="step-sub">(I Wouldn’t personally recommend)</span></h3>
                <p>
                  On Fedora or Ubuntu, <code>install.sh</code> detects the distro,
                  installs mise, compiles the pinned Ruby and wires up systemd.
                </p>
                <pre className="code"><code>{`chmod +x install.sh
sudo ./install.sh
systemctl status snake`}</code></pre>
              </div>
            </li>
          </ol>

          <div>
            <div className="callout">
              <h3>The compose surface</h3>
              <ul>
                <li>
                  <code>app</code> — builds the Rails image, publishes{" "}
                  <code>$BIND_ADDRESS:$PORT</code> (default{" "}
                  <code>0.0.0.0:3000</code>) to the container’s 3000, and
                  healthchecks <code>/up</code> with curl every 30s.
                </li>
                <li>
                  <code>db</code> — <code>postgres:16-alpine</code>, role and
                  database created from your <code>.env</code> values,
                  healthchecked with <code>pg_isready</code> before{" "}
                  <code>app</code> starts.
                </li>
                <li>
                  <code>pgdata</code> — named volume; <code>podman compose down</code>{" "}
                  keeps it, <code>down -v</code> wipes it.
                </li>
                <li>
                  Both services use <code>restart: unless-stopped</code> on the{" "}
                  <code>snakenet</code> network, and the entrypoint waits for
                  Postgres itself rather than trusting compose ordering.
                </li>
                <li>
                  Fedora: <code>pgdata:/var/lib/postgresql/data:Z</code> gives
                  the database a private SELinux label. No privileged mode or
                  disabled security labels.
                </li>
                <li>
                  Tunables, all optional in <code>.env</code>:{" "}
                  <code>RAILS_LOG_LEVEL</code>, <code>RAILS_FORCE_SSL</code>,{" "}
                  <code>RAILS_MAX_THREADS</code>, <code>WEB_CONCURRENCY</code>,{" "}
                  <code>DATABASE_PORT</code>.
                </li>
              </ul>
            </div>

            <pre className="code"><code>{`# compose.yaml — read by both Podman and Docker compose
# Native commands, from the repository root:
#   podman compose up --build -d
#   docker compose up --build -d   # optional alternative; same configuration
#
# Fedora/SELinux: application files are copied INTO the image, not bind-mounted
# from your home directory. Database storage uses a private :Z-labeled named
# volume. SELinux stays enforcing; do not use privileged or label=disable.
services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
    image: next-level-snake:local
    restart: unless-stopped
    networks:
      - snakenet
    ports:
      - "\${BIND_ADDRESS:-0.0.0.0}:\${PORT:-3000}:3000"
    environment:
      RAILS_ENV: production
      RAILS_LOG_LEVEL: \${RAILS_LOG_LEVEL:-info}
      PORT: 3000
      SECRET_KEY_BASE: \${SECRET_KEY_BASE:?Set SECRET_KEY_BASE in .env with openssl rand -hex 64}
      DATABASE_HOST: db
      DATABASE_PORT: 5432
      DATABASE_USER: \${DATABASE_USER:-snake}
      DATABASE_PASSWORD: \${DATABASE_PASSWORD:-snake}
      DATABASE_NAME: \${DATABASE_NAME:-snake_production}
      RAILS_FORCE_SSL: \${RAILS_FORCE_SSL:-false}
      RAILS_MAX_THREADS: \${RAILS_MAX_THREADS:-5}
      WEB_CONCURRENCY: \${WEB_CONCURRENCY:-0}
      # Absolute public origin used for invitation links and QR codes when the
      # app is served through a proxy or Cloudflare Tunnel (e.g.
      # https://snake.example.com). Empty means "use the request's own origin".
      MULTIPLAYER_PUBLIC_ORIGIN: \${MULTIPLAYER_PUBLIC_ORIGIN:-}
      # Comma-separated origins allowed to open the /cable WebSocket when a
      # proxy rewrites Origin. Same-origin already works without this.
      ACTION_CABLE_ALLOWED_ORIGINS: \${ACTION_CABLE_ALLOWED_ORIGINS:-}
    depends_on:
      db:
        condition: service_healthy
    # The entrypoint ALSO waits for Postgres; it does not rely solely on the
    # compose provider supporting health-based dependency ordering.
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:3000/up"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 60s

  db:
    image: docker.io/library/postgres:16-alpine
    restart: unless-stopped
    networks:
      - snakenet
    environment:
      POSTGRES_USER: \${DATABASE_USER:-snake}
      POSTGRES_PASSWORD: \${DATABASE_PASSWORD:-snake}
      POSTGRES_DB: \${DATABASE_NAME:-snake_production}
    volumes:
      # Private SELinux relabeling for this database container. Docker on
      # non-SELinux hosts also accepts this suffix, so no override is required.
      - pgdata:/var/lib/postgresql/data:Z
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U \"$\${POSTGRES_USER}\" -d \"$\${POSTGRES_DB}\""]
      interval: 5s
      timeout: 3s
      retries: 12

  # Official Cloudflare Tunnel connector (remotely-managed, token-based).
  # DISABLED by default: it belongs to the "tunnel" Compose profile and only
  # starts when .env sets COMPOSE_PROFILES=tunnel. The connector dials OUT to
  # Cloudflare, so no inbound port, port-forward or firewall rule is needed.
  # The token is deliberately guarded with :- (not :?) because Compose
  # interpolates the whole file even for profile-disabled services; a hard
  # guard here would break plain `compose up` for people not using the tunnel.
  cloudflared:
    image: docker.io/cloudflare/cloudflared:latest
    restart: unless-stopped
    profiles:
      - tunnel
    command: tunnel --no-autoupdate run
    environment:
      TUNNEL_TOKEN: \${CLOUDFLARE_TUNNEL_TOKEN:-}
      # Local-only metrics endpoint; also what the health probe asks "ready?".
      TUNNEL_METRICS: 127.0.0.1:20241
    networks:
      - snakenet
    depends_on:
      app:
        condition: service_healthy
    healthcheck:
      # The cloudflared binary probes its own metrics server; the distroless
      # image has no shell, curl or wget, so this is the supported check.
      test: ["CMD", "cloudflared", "tunnel", "--metrics", "127.0.0.1:20241", "ready"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 20s

networks:
  snakenet:

volumes:
  pgdata:`}</code></pre>
          </div>
        </div>
      </section>

      <footer className="footer">
        <span>Next Level Snake — wall-wrap arcade</span>
        <span>Ruby on Rails 8 · PostgreSQL · Puma · Podman/Docker</span>
        <span>
          Made entirely with{" "}
          <a href="https://arena.ai" target="_blank" rel="noreferrer">arena.ai</a>
        </span>
        <span>Scores isolated per speed × growth</span>
      </footer>

      <dialog className="dialog" id="auth-dialog" aria-labelledby="auth-title">
        <div className="dialog__inner">
          <div className="dialog__head">
            <h2 className="dialog__title" id="auth-title">Your name on the board</h2>
            <button className="dialog__close" id="auth-close" type="button" aria-label="Close">✕</button>
          </div>

          <div className="auth-tabs" role="tablist" aria-label="Login or create account">
            <button className="auth-tab" id="auth-tab-login" role="tab" aria-selected="true" type="button">Sign in</button>
            <button className="auth-tab" id="auth-tab-create" role="tab" aria-selected="false" type="button">Create account</button>
          </div>

          <form className="auth-form" id="form-login" autoComplete="off">
            <label className="auth-field">
              <span>Username</span>
              <input name="username" type="text" autoComplete="username" required minLength={2} maxLength={30} />
            </label>
            <label className="auth-field">
              <span>Password</span>
              <input name="password" type="password" autoComplete="current-password" required minLength={8} />
            </label>
            <p className="auth-error" id="auth-error-login" aria-live="polite" />
            <button className="btn btn--primary" type="submit">Sign in</button>
          </form>

          <form className="auth-form" id="form-create" autoComplete="off" hidden>
            <label className="auth-field">
              <span>Username</span>
              <input name="username" type="text" autoComplete="username" required minLength={2} maxLength={30} />
            </label>
            <label className="auth-field">
              <span>Password</span>
              <input name="password" type="password" autoComplete="new-password" required minLength={8} />
            </label>
            <label className="auth-field">
              <span>Confirm password</span>
              <input name="confirm-password" type="password" autoComplete="new-password" required minLength={8} />
            </label>
            <div className="auth-disclaimer" role="note">
              <strong>⚠️ Disclaimer</strong>
              <p>
                This comes with no warranty, there is a possibility I may accidentally delete your user data while trying to add a feature 😅
              </p>
            </div>
            <div className="auth-warning" role="note">
              <strong>🔑 Warning</strong>
              <p>
                An email is not required to make an account. However, this means
                that you will not be able to reset your password if you forget it.
                Please store your password in a safe place. I would highly recomend
                using a password manager, just in general. I use{" "}
                <a href="https://proton.me/pass" target="_blank" rel="noreferrer">Proton Pass</a>{" "}
                and really like and recomend it.
              </p>
            </div>
            <p className="auth-error" id="auth-error-create" aria-live="polite" />
            <button className="btn btn--primary" type="submit">Create account</button>
          </form>
        </div>
      </dialog>
      <GameRuntime />
    </>
  );
}
