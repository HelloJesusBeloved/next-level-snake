// Invitation page. A name and a join button — the lobby loads after the
// server seats this browser.
(function () {
  const root = document.getElementById('join-root');
  const form = document.getElementById('join-form');
  if (!root || !form) return;

  const code = root.dataset.code;
  const name = document.getElementById('join-name');
  const button = document.getElementById('join-go');
  const flash = document.getElementById('join-flash');
  const NAME_KEY = 'snake.multiplayer.name.v1';

  function show(message, kind) {
    if (!flash) return;
    flash.hidden = !message;
    flash.textContent = message || '';
    if (message) flash.setAttribute('data-kind', kind || 'info');
  }

  try {
    const saved = window.localStorage.getItem(NAME_KEY) || '';
    if (name && !name.value && saved) name.value = saved;
  } catch (err) { /* private mode */ }

  fetch('/api/rooms/current', { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
    .then((res) => res.json())
    .then((json) => {
      const viewer = json && json.viewer;
      if (name && !name.value && viewer && viewer.signed_in && viewer.username) {
        name.value = viewer.username;
      }
    })
    .catch(() => {});

  function join(leaveCurrent) {
    const displayName = (name.value || '').trim();
    if (displayName.length < 2) {
      show('Enter a name to play as.', 'error');
      name.focus();
      return;
    }
    try { window.localStorage.setItem(NAME_KEY, displayName); } catch (err) { /* private mode */ }
    button.disabled = true;
    fetch('/api/rooms/' + encodeURIComponent(code) + '/join', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: displayName, leave_current: !!leaveCurrent }),
    }).then((res) => res.json().then(
      (json) => ({ ok: res.ok, json: json || {} }),
      () => ({ ok: res.ok, json: {} }),
    )).then((out) => {
      if (out.ok) {
        window.location.assign('/multiplayer/' + code);
        return;
      }
      if (out.json.code === 'in_other_room') {
        const current = (out.json.current && out.json.current.code) || 'another room';
        button.disabled = false;
        if (window.confirm('You are already in room ' + current + '. Leave it and join this one?')) {
          join(true);
        }
        return;
      }
      show(out.json.error || 'Could not join that room.', 'error');
      button.disabled = false;
    }).catch(() => {
      show('Network error — try again', 'error');
      button.disabled = false;
    });
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    join(false);
  });
}());
