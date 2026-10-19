// Sign-in / create-account dialog. Markup only: public/app.js (game page) and
// public/profile.js (profile page) bring it to life. Ids must stay in sync with
// both scripts, and with rails/app/views/shared/_auth_dialog.html.erb.
export default function AuthDialog() {
  return (
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
  );
}
