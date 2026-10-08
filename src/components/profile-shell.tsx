import AuthDialog from "@/components/auth-dialog";
import ProfileRuntime from "@/components/profile-runtime";

// The profile page is a shell. public/profile.js reads GET /api/profile (or
// /api/profile?username=NAME for other players) and draws the stats, charts,
// activity heatmap, favorite mode/theme, level, rank and game log into
// #profile-root. `username` is present only when viewing another player.
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

      <main
        className="pf"
        id="profile-root"
        data-username={viewingOther ? username : undefined}
        aria-live="polite"
      />

      <footer className="footer">
        <span>Next Level Snake — wall-wrap arcade</span>
        <span>Ruby on Rails 8 · PostgreSQL · Puma · Podman/Docker</span>
        <span>Your games, your log</span>
      </footer>

      <AuthDialog />
      <ProfileRuntime />
    </>
  );
}
