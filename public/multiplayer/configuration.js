// Step 6: identity color and pre-Brawl settings. The API chooses/reserves colors
// and the final board. Telemetry is NOT identity and is never trusted as a way
// to control another membership. Every tab reports its own capabilities.
export function collectCapabilities() {
  const matches = (query) => !!window.matchMedia?.(query).matches;
  return {
    width: Math.round(window.innerWidth), height: Math.round(window.innerHeight),
    screen_width: Math.round(window.screen?.width || 0), screen_height: Math.round(window.screen?.height || 0),
    coarse: matches('(any-pointer: coarse)'), fine: matches('(any-pointer: fine)'),
    hover: matches('(hover: hover)'), touch_points: navigator.maxTouchPoints || 0,
    mobile_hint: navigator.userAgentData?.mobile === true,
  };
}

export function mountConfiguration({ api, apply, getState }) {
  const $ = (id) => document.getElementById(id);
  const swatches = $('mp-color-options');
  const colorMessage = $('mp-color-status');
  const columns = $('mp-board-columns');
  const rows = $('mp-board-rows');
  const presets = $('mp-board-preset');
  const saveBoard = $('mp-board-save');
  const boardMessage = $('mp-board-status');
  const strategyChoice = $('mp-presentation-choice');
  const saveStrategy = $('mp-presentation-save');
  const strategyMessage = $('mp-presentation-status');
  const clientId = window.crypto?.randomUUID?.() || `tab_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  let roomCode = null;
  let timer = null;
  let resizeTimer = null;
  let reporting = false;
  let pending = false;
  let paletteKey = '';
  let boardKey = '';
  let strategyKey = '';

  const message = (node, text, failed = false) => {
    if (!node) return;
    node.textContent = text;
    node.dataset.kind = failed ? 'error' : 'info';
  };

  async function post(action, body, target, success) {
    const code = getState().room?.code;
    if (!code || pending) return;
    pending = true;
    render(getState().room, getState().member);
    try {
      const out = await api(`/api/rooms/${code}/${action}`, { method: 'POST', body: JSON.stringify(body) });
      if (getState().room?.code !== code) return;
      if (out.ok) {
        apply(out);
        message(target, success);
      } else {
        message(target, out.json?.error || 'Could not save. Try again.', true);
        const fresh = await api('/api/rooms/current');
        if (fresh.ok && getState().room?.code === code) apply(fresh);
      }
    } catch {
      message(target, 'Connection lost. Refresh to confirm the saved settings, then try again.', true);
    } finally {
      pending = false;
      render(getState().room, getState().member);
    }
  }

  async function report() {
    const code = getState().room?.code;
    if (!code || reporting) return;
    reporting = true;
    try {
      const out = await api(`/api/rooms/${code}/capabilities`, {
        method: 'POST', body: JSON.stringify({ client_id: clientId, capabilities: collectCapabilities() }),
      });
      if (out.ok && getState().room?.code === code) apply(out);
      else if (!out.ok) message(boardMessage, out.json?.error || 'Device not verified; default board remains required.', true);
    } catch {
      // Missing/stale telemetry is conservative on the server, never a grant.
      message(boardMessage, 'Device report unavailable. The server may require the default grid.', true);
    } finally { reporting = false; }
  }

  function renderPalette(room, member) {
    if (!swatches) return;
    const palette = room.colors || { options: [] };
    const key = JSON.stringify([palette, member?.color?.slot, room.state, pending]);
    if (key !== paletteKey) {
      paletteKey = key;
      swatches.replaceChildren();
      for (const option of palette.options) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'mp-color-option';
        button.dataset.slot = String(option.slot);
        if (/^#[0-9A-F]{6}$/i.test(option.hex)) button.style.setProperty('--player-color', option.hex);
        const own = member?.color?.slot === option.slot;
        const occupied = !!option.taken_by && !own;
        button.disabled = occupied || option.locked || room.state === 'in_match' || pending;
        button.setAttribute('aria-pressed', String(own));
        const status = own ? 'Your color' : occupied ? `Used by ${option.player}` : option.locked ? 'Reserved for this match' : 'Available';
        button.setAttribute('aria-label', `${option.label} (${option.hex}) — ${status}`);
        button.title = `${option.label} · ${status}`;
        const dot = document.createElement('span');
        dot.className = 'mp-identity-color';
        dot.setAttribute('aria-hidden', 'true');
        const text = document.createElement('span');
        text.className = 'mp-color-option__label';
        text.textContent = own ? '✓' : occupied || option.locked ? '—' : '';
        button.append(dot, text);
        swatches.append(button);
      }
    }
    const ownColor = $('mp-my-color');
    if (ownColor && member?.color) {
      ownColor.textContent = `${member.color.label} · ${member.color.hex}`;
      ownColor.style.setProperty('--player-color', member.color.hex);
    }
    $('mp-color-note').textContent = room.state === 'in_match'
      ? 'Colors are frozen for this match. Change yours in the next lobby.'
      : `Solid color for your snake, own food and indicators in future matches. Used colors are reserved; ${palette.spare || 6} spare choices are kept. Names always identify players too.`;
  }

  function renderBoard(room, member) {
    const board = room.board;
    if (!board || !columns || !rows || !presets || !saveBoard) return;
    $('mp-board-current').textContent = `${board.columns} × ${board.rows}`;
    $('mp-board-reason').textContent = board.reason;
    const recommendation = board.recommendation;
    $('mp-board-recommendation').textContent = board.frozen
      ? 'The running grid is immutable. New arrivals spectate; resizing affects only the next Brawl.'
      : `For ${board.participants} eligible player${board.participants === 1 ? '' : 's'}: ${recommendation.label}. Custom range: 24–96 columns, 18–72 rows.`;
    const key = JSON.stringify([room.code, board.requested, board.custom_allowed, member?.host]);
    if (key !== boardKey) {
      boardKey = key;
      presets.replaceChildren();
      for (const preset of board.presets) {
        const option = document.createElement('option');
        option.value = preset.key;
        option.textContent = preset.label;
        option.dataset.columns = preset.columns;
        option.dataset.rows = preset.rows;
        presets.append(option);
      }
      const custom = document.createElement('option');
      custom.value = 'custom'; custom.textContent = 'Custom dimensions'; presets.append(custom);
      columns.value = board.requested.columns;
      rows.value = board.requested.rows;
      presets.value = board.presets.find((p) => p.columns === board.requested.columns && p.rows === board.requested.rows)?.key || 'custom';
    }
    const disabled = !board.editable || pending;
    [columns, rows, presets, saveBoard].forEach((input) => { input.disabled = disabled; });
    saveBoard.hidden = !member?.host;
    $('mp-board-host-label').textContent = member?.host ? 'Host controls · next Brawl' : 'Host-controlled · read only';
  }

  function renderPresentationStrategy(room, member) {
    if (!strategyChoice || !saveStrategy) return;
    const selected = room.presentation_strategy === 'responsive' ? 'responsive' : 'classic';
    const brawlRoom = room.mode === 'brawl';
    const editable = !!member?.host && brawlRoom && ['lobby', 'finished'].includes(room.state);
    const key = JSON.stringify([room.code, room.mode, selected, room.state, member?.host, pending]);
    if (key !== strategyKey) {
      strategyKey = key;
      strategyChoice.value = selected;
    }
    strategyChoice.disabled = !editable || pending;
    saveStrategy.disabled = !editable || pending;
    saveStrategy.hidden = !member?.host;
    $('mp-presentation-host-label').textContent = !brawlRoom
      ? 'Brawl-only setting · read only'
      : member?.host ? 'Host controls · next Brawl' : 'Host-controlled · read only';
    $('mp-presentation-reason').textContent = !brawlRoom
      ? 'This presentation choice applies only to Brawl; Duel remains a separate game mode.'
      : room.state === 'in_match'
        ? 'This match’s presentation is locked. Choose a strategy for the next Brawl after it ends.'
        : 'Classic and Responsive are presentation strategies, independent of game rules.';
    // Step 3: both strategies are implemented. The copy states what each one
    // DOES rather than what it lacks, and never implies a fallback: the strategy
    // is frozen into the match, and diagnostics name the one actually running.
    const availability = $('mp-presentation-availability');
    if (availability) {
      availability.textContent = !brawlRoom
        ? 'The Brawl presentation strategy does not change or configure Duel mode.'
        : selected === 'responsive'
          ? 'Responsive Brawl: your own snake moves the moment you press, and other players are played back smoothly from buffered server-confirmed movement (slightly behind live). Scores, collisions, food and results stay server-authoritative.'
          : 'Classic Brawl: every frame is painted exactly as the server sends it, with no local prediction or playback buffer. This is the original behaviour.';
      availability.dataset.kind = 'info';
    }
  }

  function render(room, member) {
    if (!room) {
      roomCode = null;
      window.clearInterval(timer); timer = null;
      paletteKey = ''; boardKey = ''; strategyKey = '';
      return;
    }
    renderPalette(room, member);
    renderBoard(room, member);
    renderPresentationStrategy(room, member);
    if (roomCode !== room.code) {
      roomCode = room.code;
      window.clearInterval(timer);
      timer = window.setInterval(report, 25000);
      // Do not issue a request reentrantly inside lobby render/apply.
      window.setTimeout(report, 0);
    }
  }

  swatches?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-slot]');
    if (!button || button.disabled) return;
    post('color', { color_slot: Number(button.dataset.slot) }, colorMessage, 'Your color is reserved. Everyone in the room can see it.');
  });
  presets?.addEventListener('change', () => {
    const preset = presets.selectedOptions[0];
    if (preset.dataset.columns) { columns.value = preset.dataset.columns; rows.value = preset.dataset.rows; }
  });
  $('mp-board-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (saveBoard.disabled) return;
    post('board', { columns: Number(columns.value), rows: Number(rows.value) }, boardMessage, 'Board preference saved. The server checks devices again before each new Brawl.');
  });
  $('mp-presentation-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (saveStrategy.disabled) return;
    post('presentation_strategy', { presentation_strategy: strategyChoice.value }, strategyMessage,
      'Presentation strategy saved for the next Brawl.');
  });

  const resized = () => { window.clearTimeout(resizeTimer); resizeTimer = window.setTimeout(report, 300); };
  window.addEventListener('resize', resized);
  window.addEventListener('orientationchange', resized);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) report(); });
  window.addEventListener('pagehide', () => { window.clearInterval(timer); window.clearTimeout(resizeTimer); });
  return { render };
}
