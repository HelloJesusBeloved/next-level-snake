/*!
 * Multiplayer lobby (step 3) — plain HTTP against /api/rooms/*.
 *
 * Deliberately independent from app.js and the single-player engine: this
 * module owns the /multiplayer page only. Real-time synchronization arrives
 * in the next step and will replace the polling loop below; everything else
 * (rendering, confirmations, auth wiring) is written to survive that swap.
 *
 * Identity is never handled here. The server reads the signed-in session or
 * the httpOnly guest cookie it issued; the page only ever says what it wants
 * to do, never who it is.
 */

const NAME_KEY = 'snake.multiplayer.name.v1';
const CODE_PATTERN = /[^A-Z0-9]/g;

function $(id) { return document.getElementById(id); }

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function store(key, value) {
  try { window.localStorage.setItem(key, value); } catch (err) { /* private mode */ }
}
function recall(key) {
  try { return window.localStorage.getItem(key) || ''; } catch (err) { return ''; }
}

function api(url, options) {
  const opts = options || {};
  const headers = { Accept: 'application/json' };
  if (opts.method && opts.method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    if (opts.body === undefined) opts.body = '{}';
  }
  opts.headers = headers;
  opts.credentials = 'same-origin';
  return fetch(url, opts).then((res) => res.json().then(
    (json) => ({ ok: res.ok, status: res.status, json: json || {} }),
    () => ({ ok: res.ok, status: res.status, json: {} }),
  ));
}

export function mountLobby(root) {
  if (!root) return;

  const el = {
    flash: $('mp-flash'),
    entry: $('mp-entry'),
    room: $('mp-room'),
    name: $('mp-name'),
    code: $('mp-code'),
    codePreview: $('mp-code-preview'),
    create: $('mp-create'),
    join: $('mp-join'),
    identityNote: $('mp-identity-note'),
    authActions: $('mp-auth-actions'),
    headerAuth: $('mp-header-auth'),
    signIn: $('mp-signin'),
    createAccount: $('mp-create-account'),
    signInTop: $('mp-signin-top'),
    createTop: $('mp-create-top'),
    themes: $('mp-themes'),
    roomCode: $('mp-room-code'),
    roomState: $('mp-room-state'),
    copyCode: $('mp-copy-code'),
    copyLink: $('mp-copy-link'),
    count: $('mp-count'),
    readyCount: $('mp-ready-count'),
    startState: $('mp-start-state'),
    roster: $('mp-roster'),
    readyToggle: $('mp-ready-toggle'),
    start: $('mp-start'),
    disband: $('mp-disband'),
    leave: $('mp-leave'),
    hostNote: $('mp-host-note'),
    confirm: $('mp-confirm'),
    confirmBody: $('mp-confirm-body'),
    confirmOk: $('mp-confirm-ok'),
    confirmCancel: $('mp-confirm-cancel'),
    confirmClose: $('mp-confirm-close'),
    authDialog: $('auth-dialog'),
  };

  const state = { room: null, member: null, viewer: null, invite: '', pending: null, cancelled: null };
  const pollInterval = Math.max(2, parseInt(root.dataset.pollInterval, 10) || 5) * 1000;
  let timer = null;

  // ---- helpers --------------------------------------------------------------

  function flash(message, kind) {
    if (!el.flash) return;
    if (!message) { el.flash.hidden = true; el.flash.textContent = ''; return; }
    el.flash.hidden = false;
    el.flash.textContent = message;
    el.flash.setAttribute('data-kind', kind || 'info');
  }

  function cleanCode(value) {
    return String(value || '').toUpperCase().replace(CODE_PATTERN, '');
  }

  function desiredName() {
    return (el.name && el.name.value.trim()) || '';
  }

  function busy(on) {
    [el.create, el.join, el.readyToggle, el.start, el.disband, el.leave].forEach((button) => {
      if (button) button.disabled = !!on;
    });
  }

  // ---- rendering ------------------------------------------------------------

  function render() {
    const inRoom = !!state.room;
    if (el.entry) el.entry.hidden = inRoom;
    if (el.room) el.room.hidden = !inRoom;
    renderViewer();
    if (inRoom) renderRoom();
  }

  function renderViewer() {
    const viewer = state.viewer || {};
    if (el.identityNote) {
      el.identityNote.textContent = viewer.signed_in
        ? `Signed in as ${viewer.username}. Your room name can differ from your account name.`
        : 'Guests can play straight away — no account needed.';
    }
    if (el.authActions) el.authActions.hidden = !!viewer.signed_in;
    if (el.headerAuth) el.headerAuth.hidden = !!viewer.signed_in;
    if (el.name && !el.name.value) {
      el.name.value = viewer.signed_in ? viewer.username || '' : recall(NAME_KEY);
    }
  }

  function renderRoom() {
    const room = state.room;
    const me = state.member || {};
    const counts = room.counts || {};
    const start = room.start || {};
    const amHost = !!me.host;

    if (el.roomCode) el.roomCode.textContent = room.code;
    if (el.roomState) el.roomState.textContent = room.state;
    if (el.count) {
      el.count.textContent = `${counts.members} / ${counts.capacity} players`;
    }
    if (el.readyCount) {
      el.readyCount.textContent = `${counts.ready} ready`;
    }
    if (el.startState) {
      el.startState.textContent = start.eligible
        ? 'Enough players to start'
        : `Needs ${start.minimum_players} connected players`;
    }

    if (el.roster) {
      el.roster.innerHTML = (room.members || []).map((member) => {
        const tags = [];
        if (member.you) tags.push('<span class="mp-player__tag">you</span>');
        if (!member.online) tags.push('<span class="mp-player__tag">away</span>');
        return [
          `<li class="mp-player${member.you ? ' is-you' : ''}">`,
          `<span class="mp-dot${member.online ? ' is-online' : ''}" aria-hidden="true"></span>`,
          member.host
            ? '<span class="mp-crown" role="img" aria-label="Host">👑</span>'
            : '',
          `<span class="mp-player__name">${esc(member.display_name)}</span>`,
          tags.join(''),
          '<span class="mp-player__spacer"></span>',
          `<span class="mp-badge${member.ready ? ' is-ready' : ''}">${member.ready ? 'Ready' : 'Not ready'}</span>`,
          '</li>',
        ].join('');
      }).join('');
    }

    if (el.readyToggle) el.readyToggle.textContent = me.ready ? 'Not ready' : "I'm ready";
    if (el.start) el.start.hidden = !amHost;
    if (el.disband) el.disband.hidden = !amHost;
    if (el.hostNote) el.hostNote.hidden = !amHost;
    state.invite = room.invite_url || '';
  }

  // ---- server conversation ---------------------------------------------------

  function apply(out) {
    if (out.json && Object.prototype.hasOwnProperty.call(out.json, 'room')) {
      state.room = out.json.room && out.json.room.members ? out.json.room : null;
      state.member = out.json.member || null;
    }
    if (out.json && out.json.viewer) state.viewer = out.json.viewer;
    if (out.json && out.json.notice) flash(out.json.notice, 'info');
    render();
    return out;
  }

  function refresh() {
    return api('/api/rooms/current').then((out) => {
      if (!out.ok) return out;
      apply(out);
      return out;
    }).catch(() => null);
  }

  function poll() {
    window.clearTimeout(timer);
    timer = window.setTimeout(function tick() {
      if (document.visibilityState === 'hidden') { poll(); return; }
      refresh().then(poll);
    }, pollInterval);
  }

  // Requirement 12: never silently abandon a room. Ask, then retry.
  function confirmSwitch(message, retry, onCancel) {
    if (!el.confirm || !el.confirm.showModal) {
      if (window.confirm(message)) retry();
      else if (onCancel) onCancel();
      return;
    }
    if (el.confirmBody) el.confirmBody.textContent = message;
    state.pending = retry;
    state.cancelled = onCancel || null;
    el.confirm.showModal();
  }

  function handleFailure(out, retry) {
    const code = out.json && out.json.code;
    const message = (out.json && out.json.error) || 'Something went wrong';
    if (code === 'in_other_room') {
      const current = (out.json && out.json.current) || {};
      confirmSwitch(
        `You are already in room ${current.code}. Leave it and join this one?`,
        () => retry(true),
      );
      return;
    }
    flash(message, 'error');
  }

  function createRoom(leaveCurrent) {
    const name = desiredName();
    if (!name && !(state.viewer && state.viewer.signed_in)) {
      flash('Enter a name to play as.', 'error');
      if (el.name) el.name.focus();
      return;
    }
    if (name) store(NAME_KEY, name);
    busy(true);
    api('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({
        display_name: name,
        leave_current: !!leaveCurrent,
      }),
    }).then((out) => {
      busy(false);
      if (!out.ok) return handleFailure(out, createRoom);
      flash('Room ready — share the code or the invite link.', 'info');
      apply(out);
      history.replaceState({}, '', `/multiplayer/${out.json.room.code}`);
    }).catch(() => { busy(false); flash('Network error — try again', 'error'); });
  }

  function joinCode(code, leaveCurrent) {
    if (el.code) el.code.value = code;
    joinRoom(leaveCurrent);
  }

  function joinRoom(leaveCurrent) {
    const code = cleanCode(el.code && el.code.value);
    if (!code) { flash('Enter an invitation code.', 'error'); return; }
    const name = desiredName();
    if (name) store(NAME_KEY, name);
    busy(true);
    api(`/api/rooms/${code}/join`, {
      method: 'POST',
      body: JSON.stringify({ display_name: name, leave_current: !!leaveCurrent }),
    }).then((out) => {
      busy(false);
      if (!out.ok) return handleFailure(out, joinRoom);
      flash('', null);
      apply(out);
      history.replaceState({}, '', `/multiplayer/${code}`);
    }).catch(() => { busy(false); flash('Network error — try again', 'error'); });
  }

  function roomAction(path, body) {
    if (!state.room) return Promise.resolve(null);
    busy(true);
    return api(`/api/rooms/${state.room.code}/${path}`, {
      method: 'POST',
      body: JSON.stringify(body || {}),
    }).then((out) => {
      busy(false);
      if (!out.ok) { flash((out.json && out.json.error) || 'Something went wrong', 'error'); return out; }
      apply(out);
      return out;
    }).catch(() => { busy(false); flash('Network error — try again', 'error'); return null; });
  }

  // Looks a code up before anyone commits to it, so invalid, disbanded and
  // expired invitations explain themselves straight away.
  function previewCode(code) {
    if (!el.codePreview) return;
    if (!code || code.length < 4) { el.codePreview.hidden = true; return; }
    api(`/api/rooms/${code}`).then((out) => {
      el.codePreview.hidden = false;
      if (!out.ok) { el.codePreview.textContent = (out.json && out.json.error) || 'That code did not work.'; return; }
      if (out.json.room && out.json.room.members) { el.codePreview.hidden = true; return; } // already a member
      const preview = out.json.room || {};
      const counts = preview.counts || {};
      el.codePreview.textContent = preview.joinable
        ? `${preview.host_name || 'Someone'}'s room · ${counts.members}/${counts.capacity} players`
        : 'That room is not open for joining right now.';
    }).catch(() => { el.codePreview.hidden = true; });
  }

  // navigator.clipboard only exists in secure contexts, so on a plain HTTP
  // self-host it must fall back to the selection trick — which is why "Copy"
  // used to look dead before this existed.
  function copy(text, button, label) {
    if (!text) return;
    const done = () => {
      if (!button) return;
      const original = button.textContent;
      button.textContent = label;
      window.setTimeout(() => { button.textContent = original; }, 1500);
    };
    const legacy = () => {
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.left = '-9999px';
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        document.body.removeChild(area);
        done();
      } catch (err) {
        flash(`Copy failed — it is: ${text}`, 'info');
      }
    };
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, legacy);
    } else {
      legacy();
    }
  }

  // ---- accounts (reuses the shared auth dialog markup) ------------------------

  function setAuthMode(mode) {
    const login = mode !== 'create';
    const tabLogin = $('auth-tab-login');
    const tabCreate = $('auth-tab-create');
    const formLogin = $('form-login');
    const formCreate = $('form-create');
    if (tabLogin) tabLogin.setAttribute('aria-selected', String(login));
    if (tabCreate) tabCreate.setAttribute('aria-selected', String(!login));
    if (formLogin) formLogin.hidden = !login;
    if (formCreate) formCreate.hidden = login;
  }

  function openAuth(mode) {
    if (!el.authDialog || !el.authDialog.showModal) return;
    setAuthMode(mode);
    if (!el.authDialog.open) el.authDialog.showModal();
  }

  // Signing in from inside a room keeps the seat: the server attaches this
  // browser's verified guest membership to the account (step 2's claim).
  function afterAuth() {
    const hadGuestRoom = !!state.room && !!state.member && state.member.guest;
    const finish = () => refresh().then(() => {
      if (el.authDialog && el.authDialog.open) el.authDialog.close();
    });
    if (!hadGuestRoom) return finish();
    return api('/api/rooms/claim', { method: 'POST' }).then((out) => {
      if (out.ok) { apply(out); flash('Your seat is now linked to your account.', 'info'); }
      return finish();
    }).catch(finish);
  }

  function submitAuth(url, form, errorId) {
    const errEl = $(errorId);
    if (errEl) errEl.textContent = '';
    const username = form.elements.username ? form.elements.username.value : '';
    const password = form.elements.password ? form.elements.password.value : '';
    const confirmField = form.elements['confirm-password'];
    if (confirmField && confirmField.value !== password) {
      if (errEl) errEl.textContent = 'Passwords do not match';
      return;
    }
    api(url, { method: 'POST', body: JSON.stringify({ username, password }) }).then((out) => {
      if (!out.ok) {
        if (errEl) errEl.textContent = (out.json && out.json.error) || 'Something went wrong';
        return;
      }
      afterAuth();
    }).catch(() => { if (errEl) errEl.textContent = 'Network error — try again'; });
  }

  // ---- theme picker (same segmented control as the game page settings) -------

  function savedSettings() {
    try { return JSON.parse(window.localStorage.getItem('snake.settings.v1') || '{}') || {}; }
    catch (err) { return {}; }
  }

  function markThemes() {
    if (!el.themes) return;
    const active = document.documentElement.dataset.theme || 'classic';
    el.themes.querySelectorAll('button[data-theme]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.theme === active));
    });
  }

  function pickTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    // Merge into the saved settings instead of replacing them, so the game
    // page's speed/growth/custom choices are never lost from here.
    const settings = savedSettings();
    settings.theme = theme;
    try { window.localStorage.setItem('snake.settings.v1', JSON.stringify(settings)); } catch (err) { /* blocked */ }
    window.MatrixRain?.set(theme === 'terminal');
    markThemes();
  }

  // ---- wiring -----------------------------------------------------------------

  function on(node, event, handler) { if (node) node.addEventListener(event, handler); }

  on(el.create, 'click', () => createRoom(false));
  on(el.join, 'click', () => joinRoom(false));
  on(el.readyToggle, 'click', () => roomAction('ready', { ready: !(state.member && state.member.ready) }));
  on(el.leave, 'click', () => {
    roomAction('leave').then(() => {
      flash('You left the room. Your seat is kept for a while if you come back.', 'info');
      history.replaceState({}, '', '/multiplayer');
    });
  });
  on(el.disband, 'click', () => {
    if (!window.confirm('Disband this room for everyone?')) return;
    roomAction('disband').then(() => {
      flash('Room disbanded.', 'info');
      history.replaceState({}, '', '/multiplayer');
    });
  });
  on(el.start, 'click', () => {
    roomAction('start').then((out) => {
      if (out && out.ok) flash(out.json.notice || 'Ready to start.', 'info');
    });
  });

  on(el.copyCode, 'click', () => copy(state.room && state.room.code, el.copyCode, 'Copied'));
  on(el.copyLink, 'click', () => copy(state.invite, el.copyLink, 'Copied'));

  on(el.code, 'input', () => {
    const cleaned = cleanCode(el.code.value);
    if (el.code.value !== cleaned) el.code.value = cleaned;
    previewCode(cleaned);
  });
  on(el.name, 'change', () => store(NAME_KEY, desiredName()));

  on(el.signIn, 'click', () => openAuth('login'));
  on(el.createAccount, 'click', () => openAuth('create'));
  on(el.signInTop, 'click', () => openAuth('login'));
  on(el.createTop, 'click', () => openAuth('create'));
  if (el.themes) {
    el.themes.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-theme]');
      if (button) pickTheme(button.dataset.theme);
    });
  }
  markThemes();
  on($('auth-tab-login'), 'click', () => setAuthMode('login'));
  on($('auth-tab-create'), 'click', () => setAuthMode('create'));
  on($('auth-close'), 'click', () => el.authDialog && el.authDialog.close());
  on($('form-login'), 'submit', (event) => {
    event.preventDefault();
    submitAuth('/api/auth/login', event.target, 'auth-error-login');
  });
  on($('form-create'), 'submit', (event) => {
    event.preventDefault();
    submitAuth('/api/auth/signup', event.target, 'auth-error-create');
  });

  const closeConfirm = (cancelled) => {
    const onCancel = state.cancelled;
    state.pending = null;
    state.cancelled = null;
    if (el.confirm && el.confirm.open) el.confirm.close();
    if (cancelled && onCancel) onCancel();
  };
  on(el.confirmOk, 'click', () => {
    const retry = state.pending;
    closeConfirm(false);
    if (retry) retry();
  });
  on(el.confirmCancel, 'click', () => closeConfirm(true));
  on(el.confirmClose, 'click', () => closeConfirm(true));

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });

  // ---- boot --------------------------------------------------------------------
  // A normal refresh lands here: ask the server what room this browser is in,
  // and only fall back to the code in the URL when it is in none.
  refresh().then(() => {
    const code = cleanCode(root.dataset.roomCode);
    if (state.room) {
      // Already seated, and someone sent a link to a *different* room: ask
      // before giving up the seat (requirement 12), and keep the URL honest.
      if (code && code !== state.room.code) {
        confirmSwitch(
          `You are in room ${state.room.code}. Leave it and join ${code}?`,
          () => joinCode(code, true),
          () => history.replaceState({}, '', `/multiplayer/${state.room.code}`),
        );
      }
    } else if (code) {
      if (el.code) el.code.value = code;
      previewCode(code);
      flash('Enter a name, then join this room.', 'info');
      if (el.name && !el.name.value) el.name.focus();
    }
    poll();
  });
}
