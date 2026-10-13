import AuthDialog from "@/components/auth-dialog";
import ProfileRuntime from "@/components/profile-runtime";

const SKINS = [
  { id: "classic", name: "Classic" },
  { id: "arcade", name: "Arcade" },
  { id: "vintage", name: "Vintage" },
  { id: "terminal", name: "Terminal" },
  { id: "paper", name: "Paper" },
  { id: "violet", name: "Midnight Violet" },
  { id: "sunsetfire", name: "Royal Sunset" },
] as const;

function GithubIcon() {
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.28-.01-1.04-.02-2.04-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.33-1.76-1.33-1.76-1.09-.74.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.49.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.61-2.81 5.62-5.48 5.92.43.37.81 1.1.81 2.22 0 1.6-.01 2.9-.01 3.29 0 .32.22.69.83.57A12.01 12.01 0 0 0 24 12c0-6.63-5.37-12-12-12Z" />
    </svg>
  );
}

// The profile page is a shell. public/profile.js reads GET /api/profile (or
// /api/profile?username=NAME for other players) and draws the stats, charts,
// activity heatmap, favorite mode/theme, level, rank and game log into
// #profile-root. The cabinet-skin panel is outside that root so it always
// controls the global theme, including on the sign-in gate.
export default function ProfileShell({ username }: { username?: string }) {
  const viewingOther = Boolean(username);
  const eyebrow = viewingOther ? `Player Profile — ${username}` : "Player Profile";

  return (
    <>
      <div className="page-texture" aria-hidden="true" />
      <div className="page-scrim" aria-hidden="true" />

      <div className="spine" aria-hidden="true">
        <span>
          Next Level Snake <b>/</b> {viewingOther ? "Player" : "Your Profile"}
        </span>
      </div>

      <header className="masthead">
        <a className="masthead__brand" href="/" aria-label="Next Level Snake — back to the game">
          <span className="mark" aria-hidden="true" />
          <span className="brand__text">
            <span className="brand__eyebrow">Next Level</span>
            <span className="wordmark">Snake</span>
          </span>
        </a>
        <nav className="masthead__meta" aria-label="Main navigation">
          <a className="btn btn--small btn--nav" href="/">
            <svg className="nav-icon" viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M6 2h12v2h4v4a5 5 0 0 1-5 5h-.5A6 6 0 0 1 13 15.9V18h3v4H8v-4h3v-2.1A6 6 0 0 1 7.5 13H7a5 5 0 0 1-5-5V4h4V2Zm-2 4v1a3 3 0 0 0 3 3V6H4Zm16 0h-3v4a3 3 0 0 0 3-3V6Z" /></svg>
            Play
          </a>
          <a className="btn btn--small btn--nav" href="/#leaderboard">
            <svg className="nav-icon" viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M4 3h16a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm1 3h2V5H5v1Zm0 2h2V7H5v1Zm12-3h-2v1h2V5Zm0 3h-2V7h2v1ZM4 12h16a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1Zm1 3h2v-1H5v1Zm0 2h2v-1H5v1Zm12-3h-2v1h2v-1Zm0 3h-2v-1h2v1Z" /></svg>
            Leaderboard
          </a>
          <a className="btn btn--small btn--nav" href="/profile" aria-current={viewingOther ? undefined : "page"}>
            <svg className="nav-icon" viewBox="0 0 24 24" width="15" height="15" fill="currentColor" shapeRendering="crispEdges" aria-hidden="true"><path d="M2 8h20v3H2Zm1 3h6v5H3v-5Zm13 0h6v5h-6v-5Z" /></svg>
            Profile
          </a>
          <a
            className="btn btn--small btn--nav"
            href="https://github.com/HelloJesusBeloved/next-level-snake"
            target="_blank"
            rel="noreferrer"
          >
            <GithubIcon />
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

      <main className="pf-layout is-gated">
        <aside className="pf-side" aria-label="Theme" hidden>
          <div className="card" id="pf-skin-card">
            <div className="card__head">
              <h2 className="card__title">Theme</h2>
              <span className="setting__value" id="pf-skin-value">Classic</span>
            </div>
            <div className="segmented" id="pf-skin-theme" role="group" aria-label="Theme">
              {SKINS.map((skin) => (
                <button key={skin.id} type="button" data-theme={skin.id} aria-pressed={skin.id === "classic"}>
                  <span className="swatch" data-swatch={skin.id}><i aria-hidden="true" />{skin.name}</span>
                </button>
              ))}
            </div>
          </div>
        </aside>

        <div
          className="pf"
          id="profile-root"
          data-username={viewingOther ? username : undefined}
          aria-live="polite"
        />
      </main>

      <p className="sr-only">{eyebrow}</p>

      <footer className="footer">
        <span>Next Level Snake — wall-wrap arcade</span>
        <span>Ruby on Rails 8 · PostgreSQL · Puma · Podman/Docker</span>
        <span>Your games, your log</span>
      </footer>

      <dialog className="board-lightbox" id="board-lightbox" aria-labelledby="board-lightbox-title">
        <div className="board-lightbox__inner">
          <div className="board-lightbox__head">
            <h2 id="board-lightbox-title">Ending position</h2>
            <button className="dialog__close" id="board-lightbox-close" type="button" aria-label="Close enlarged board">✕</button>
          </div>
          <div className="board-lightbox__frame" id="board-lightbox-frame" />
          <p className="board-lightbox__cap" id="board-lightbox-cap" />
        </div>
      </dialog>

      <AuthDialog />
      <ProfileRuntime />
    </>
  );
}
