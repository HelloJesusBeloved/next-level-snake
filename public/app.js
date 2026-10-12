/*!
 * Next Level Snake — page wiring: score HUD, scoreboard + run history,
 * modifiers (incl. custom), themes, accounts and the filterable leaderboards.
 * Shared by the Rails app and the preview.
 * Talks to /api/scores, /api/leaderboard and /api/auth/*.
 */
(function () {
  'use strict';

  var STORE_KEY = 'snake.settings.v1';
  var RUNS_KEY = 'snake.runs.v1';
  var TOKEN_KEY = 'snake.token.v1';

  // Canvas palettes — the CSS counterparts live in styles.css [data-theme=...].
  var THEMES = {
    arcade: { field: '#050505', snake: '#2CE05E', snakeGlow: 0.38, food: '#FF3B30', foodGlow: 0.55, blocks: false, roundFood: true, blink: false },
    classic: { field: '#000000', snake: '#35FF6B', snakeGlow: 0, food: '#FF3B30', foodGlow: 0.3, blocks: true, blockGap: 0, roundFood: false, blink: false },
    vintage: { field: '#B8C69A', snake: '#1E2C16', snakeGlow: 0, food: '#1E2C16', foodGlow: 0, blocks: true, blockGap: 0.12, roundFood: false, blink: false },
    terminal: { field: '#020805', snake: '#31F084', snakeGlow: 0.5, food: '#FF4141', foodGlow: 0.6, blocks: false, roundFood: true, blink: false },
    paper: { field: '#F6F1E2', snake: '#191713', snakeGlow: 0, food: '#C8102E', foodGlow: 0, blocks: false, roundFood: true, blink: false },
    violet: { field: '#0B0617', snake: '#7DF4FF', snakeGlow: 0.55, food: '#FF7AC8', foodGlow: 0.6, blocks: false, roundFood: true, blink: false },
    sunsetfire: { field: '#180306', snake: '#FFD34E', snakeGlow: 0.5, food: '#FF5839', foodGlow: 0.6, blocks: false, roundFood: true, blink: false }
  };
  var THEME_NAMES = {
    arcade: 'Arcade', classic: 'Classic', vintage: 'Vintage', terminal: 'Terminal',
    paper: 'Paper', violet: 'Violet', sunsetfire: 'Royal Sunset'
  };

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  function $(id) { return document.getElementById(id); }
  function all(selector) { return Array.prototype.slice.call(document.querySelectorAll(selector)); }
  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function bounded(value, min, max, fallback) {
    var n = parseInt(value, 10);
    return isNaN(n) ? fallback : Math.min(max, Math.max(min, n));
  }

  function loadSettings() {
    var d = {
      speedId: 3, speedCustom: 42, useCustomSpeed: false,
      growth: 1, growthCustom: 2, useCustomGrowth: false,
      theme: 'arcade'
    };
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      if (!raw) return d;
      var p = JSON.parse(raw);
      return {
        speedId: bounded(p.speedId, 1, 6, d.speedId),
        speedCustom: bounded(p.speedCustom, 0, 100, d.speedCustom),
        useCustomSpeed: p.useCustomSpeed === true,
        growth: bounded(p.growth, 1, 5, d.growth),
        growthCustom: bounded(p.growthCustom, 0, 100, d.growthCustom),
        useCustomGrowth: p.useCustomGrowth === true,
        theme: THEMES[p.theme] ? p.theme : d.theme
      };
    } catch (err) {
      return d;
    }
  }

  function saveSettings(settings) {
    try { window.localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch (err) { /* ignore */ }
  }

  // ---- session token --------------------------------------------------------
  // The session cookie is the normal way to stay signed in. Browsers refuse to
  // keep cookies for a page embedded in a frame on another site (hosted
  // previews, dashboards, strict privacy modes), and then every request looks
  // anonymous. So the page also keeps the session token (when the server hands
  // one out) and sends it explicitly as a bearer header.
  var memToken = null;
  function getToken() {
    try { return window.localStorage.getItem(TOKEN_KEY) || memToken; } catch (err) { return memToken; }
  }
  function setToken(token) {
    memToken = token || null;
    try {
      if (token) window.localStorage.setItem(TOKEN_KEY, token);
      else window.localStorage.removeItem(TOKEN_KEY);
    } catch (err) { /* ignore */ }
  }

  function api(url, options) {
    var opts = options || {};
    var headers = { Accept: 'application/json' };
    if (opts.method && opts.method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      if (opts.body === undefined) opts.body = '{}';
    }
    var token = getToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    opts.headers = headers;
    opts.credentials = 'same-origin';
    return fetch(url, opts);
  }

  function readJson(res) {
    return res.json().then(
      function (json) { return { ok: res.ok, status: res.status, json: json || {} }; },
      function () { return { ok: res.ok, status: res.status, json: {} }; }
    );
  }

  // ---- run history (this device) ---------------------------------------------
  function loadRuns() {
    try {
      var list = JSON.parse(window.localStorage.getItem(RUNS_KEY) || '[]');
      return Array.isArray(list) ? list : [];
    } catch (err) { return []; }
  }
  function saveRuns(list) {
    try { window.localStorage.setItem(RUNS_KEY, JSON.stringify(list.slice(0, 30))); } catch (err) { /* ignore */ }
  }

  function levelOf(levels, id) {
    for (var i = 0; i < levels.length; i++) if (levels[i].id === id) return levels[i];
    return levels[2];
  }

  function fmtDate(value) {
    if (!value) return '—';
    var d = new Date(value);
    if (isNaN(d.getTime())) return '—';
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
  }

  function timeAgo(ms) {
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 45) return 'just now';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }

  // --- modifier vocabulary (mirrors src/lib/levels.ts and the Rails Score) ----
  function presetSpeed(s) { return s.speedPreset != null ? s.speedPreset : s.speedId; }
  function presetGrowth(s) { return s.growthPreset != null ? s.growthPreset : s.growth; }
  function speedKeyOf(s) { return s.useCustomSpeed ? 'c' + s.speedCustom : String(presetSpeed(s)); }
  function growthKeyOf(s) { return s.useCustomGrowth ? 'c' + s.growthCustom : String(presetGrowth(s)); }
  function comboKeyOf(s) { return speedKeyOf(s) + '-' + growthKeyOf(s); }

  function speedText(s) {
    if (s.useCustomSpeed) return 'Custom · ' + s.speedCustom + ' ms';
    var level = levelOf(window.__nlsLevels || [], presetSpeed(s));
    return level.label + ' · ' + level.ms + ' ms';
  }
  function growthText(s) {
    return s.useCustomGrowth ? '×' + s.growthCustom + ' (custom)' : '×' + presetGrowth(s);
  }
  function modeLabel(s) {
    var speed = s.useCustomSpeed
      ? 'Custom ' + s.speedCustom + ' ms'
      : levelOf(window.__nlsLevels || [], presetSpeed(s)).label;
    var growth = s.useCustomGrowth ? '×' + s.growthCustom + ' custom' : '×' + presetGrowth(s);
    return speed + ' · ' + growth;
  }

  function rowLevel(r) {
    var list = window.__nlsLevels || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === Number(r.speed_level)) return list[i];
    }
    return list[2] || { label: 'Normal', ms: 105 };
  }
  function rowSpeedText(r) {
    return r.speed_custom != null
      ? 'Custom · ' + r.speed_custom + ' ms'
      : rowLevel(r).label + ' · ' + rowLevel(r).ms + ' ms';
  }
  function rowGrowthText(r) {
    return r.growth_custom != null ? '×' + r.growth_custom + ' (custom)' : '×' + r.growth;
  }

  function boot() {
    var root = $('snake-root');
    if (!root || !window.SnakeGame) return;

    var levels = window.SnakeGame.levels;
    window.__nlsLevels = levels;

    var settings = loadSettings();
    var game = window.SnakeGame.create(root, {
      speedId: settings.speedId,
      customSpeed: settings.speedCustom,
      useCustomSpeed: settings.useCustomSpeed,
      growth: settings.growth,
      customGrowth: settings.growthCustom,
      useCustomGrowth: settings.useCustomGrowth
    });

    var overlay = $('overlay');
    var panels = { start: $('panel-start'), pause: $('panel-pause'), over: $('panel-over') };
    var speedValueEl = $('speed-value');
    var growthValueEl = $('growth-value');
    var themeValueEl = $('theme-value');
    var speedGroup = $('settings-speed');
    var growthGroup = $('settings-growth');
    var themeGroup = $('settings-theme');
    var customSpeedRow = $('custom-speed-row');
    var customSpeedInput = $('custom-speed');
    var customSpeedVal = $('custom-speed-val');
    var customGrowthRow = $('custom-growth-row');
    var customGrowthInput = $('custom-growth');
    var customGrowthVal = $('custom-growth-val');
    var pauseBtn = $('pause-btn');
    var settingsCard = $('settings-card');
    var settingsLock = $('settings-lock');
    var pauseSpeedEl = $('pause-speed');
    var pauseGrowthEl = $('pause-growth');
    var scoreEls = all('[data-live-score]');

    var authUser = null;
    var comboBest = {};       // the signed-in player's own best per combination
    var runs = loadRuns();    // recent runs on this device, newest first
    var locked = false;
    var playingNow = false;
    var pendingRun = null;
    // Set right after a successful save; renderBoard turns it into a one-shot
    // highlight so the player sees their run when they open the board.
    var pendingHighlight = false;

    function currentSettingsShape() {
      return {
        speedId: settings.speedId, speedCustom: settings.speedCustom, useCustomSpeed: settings.useCustomSpeed,
        growth: settings.growth, growthCustom: settings.growthCustom, useCustomGrowth: settings.useCustomGrowth
      };
    }

    // ---- readouts: HUD, scoreboard, run history --------------------------------
    function setScore(n) {
      var text = String(n);
      for (var i = 0; i < scoreEls.length; i++) scoreEls[i].textContent = text;
    }

    // Signed in: the account's own best. Guest: the best on this device.
    function bestFor(key) {
      if (authUser) return typeof comboBest[key] === 'number' ? comboBest[key] : undefined;
      var best;
      for (var i = 0; i < runs.length; i++) {
        if (runs[i].key === key && (best === undefined || runs[i].score > best)) best = runs[i].score;
      }
      return best;
    }

    function renderRuns() {
      var listEl = $('recent-runs');
      var statsEl = $('mode-stats');
      if (!listEl) return;

      if (!runs.length) {
        listEl.innerHTML = '<li class="runs__empty">Play a run and it shows up here.</li>';
      } else {
        var bestByKey = {};
        runs.forEach(function (r) {
          if (bestByKey[r.key] === undefined || r.score > bestByKey[r.key]) bestByKey[r.key] = r.score;
        });
        var html = '';
        runs.forEach(function (r) {
          var isBest = r.score > 0 && r.score === bestByKey[r.key];
          html += '<li class="runs__item' + (isBest ? ' is-best' : '') + '">' +
            '<span class="runs__score">' + r.score + '</span>' +
            '<span class="runs__mode">' + esc(r.mode) + '</span>' +
            '<span class="runs__when">' + timeAgo(r.at) + '</span></li>';
        });
        listEl.innerHTML = html;
      }

      if (statsEl) {
        var key = comboKeyOf(currentSettingsShape());
        var same = runs.filter(function (r) { return r.key === key; });
        if (!same.length) {
          statsEl.textContent = 'No runs in this mode yet';
        } else {
          var total = same.reduce(function (sum, r) { return sum + r.score; }, 0);
          var avg = Math.round((total / same.length) * 10) / 10;
          statsEl.textContent = 'Played ' + same.length + ' · Avg ' + avg + ' · Last ' + same[0].score;
        }
      }
    }

    function refreshReadouts() {
      var shape = currentSettingsShape();
      var label = modeLabel(shape);
      var best = bestFor(comboKeyOf(shape));
      all('[data-live-mode]').forEach(function (el) { el.textContent = label; });
      all('[data-live-best]').forEach(function (el) { el.textContent = typeof best === 'number' ? String(best) : '—'; });
      renderRuns();
    }

    function addRun(state) {
      runs.unshift({ score: state.score, key: comboKeyOf(state), mode: modeLabel(state), at: Date.now() });
      runs = runs.slice(0, 30);
      saveRuns(runs);
    }

    // ---- overlay panels ---------------------------------------------------------
    function showPanel(name) {
      for (var key in panels) {
        if (panels[key]) panels[key].classList.toggle('is-visible', key === name);
      }
      if (overlay) overlay.classList.add('is-visible');
      fitOverlayPanel();
    }

    function hideOverlay() {
      if (overlay) overlay.classList.remove('is-visible');
    }

    // Fit result/start/pause panels to the screen without a scrollbar. This
    // runs only on panel visibility/text/size changes, NEVER on the game loop
    // or directional input path. The compact CSS does most of the work; scaling
    // is a last resort for very small landscape screens or long server errors.
    function fitOverlayPanel() {
      if (!overlay || !overlay.classList.contains('is-visible')) return;
      var panel = overlay.querySelector('.panel.is-visible');
      if (!panel) return;
      var availableW = Math.max(1, overlay.clientWidth - 20);
      var availableH = Math.max(1, overlay.clientHeight - 20);
      var naturalW = Math.max(panel.offsetWidth, panel.scrollWidth, 1);
      var naturalH = Math.max(panel.offsetHeight, panel.scrollHeight, 1);
      var scale = Math.min(1, availableW / naturalW, availableH / naturalH);
      panel.style.setProperty('--panel-scale', String(Math.floor(scale * 10000) / 10000));
    }

    if (window.ResizeObserver && overlay) {
      var panelObserver = new window.ResizeObserver(fitOverlayPanel);
      panelObserver.observe(overlay);
      Object.keys(panels).forEach(function (key) {
        if (panels[key]) panelObserver.observe(panels[key]);
      });
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitOverlayPanel);

    // ---- keep the score on screen ------------------------------------------------
    // Scrolls the page by the least amount that puts the WHOLE playfield in the
    // viewport. The score does not need room in the page: a floating pill (see
    // .hud-float) shows it at the top of the window for the whole run. Instant
    // (not smooth), so the scroll offset is final before the page is locked.
    function revealPlayfield() {
      var hud = $('hud');
      var frame = root.querySelector('.snake-frame');
      if (!hud && !frame) return;
      document.body.classList.toggle('has-run', game.state().running);
      var vh = window.innerHeight || document.documentElement.clientHeight;
      var anchor = hud || frame;
      var anchorRect = anchor.getBoundingClientRect();
      var frameRect = frame ? frame.getBoundingClientRect() : anchorRect;
      var topMargin = 8;
      var delta = 0;
      if (anchorRect.top < topMargin) delta = anchorRect.top - topMargin;                    // scoreboard above the top: align it to the top
      else if (frameRect.bottom > vh - topMargin) delta = frameRect.bottom - (vh - topMargin); // box below the fold: bring its bottom into view
      if (Math.abs(delta) > 1) window.scrollTo(window.scrollX, window.scrollY + delta);
    }

    // ---- page scroll lock while a run is live ------------------------------------
    var scrollLock = null;
    function setPlaying(active) {
      document.body.classList.toggle('has-run', game.state().running);
      if (active) {
        if (scrollLock) return;
        scrollLock = { x: window.scrollX, y: window.scrollY };
        var gap = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
        document.body.style.setProperty('--play-scroll-top', -scrollLock.y + 'px');
        document.body.style.setProperty('--play-scrollbar-gap', gap + 'px');
        document.documentElement.classList.add('is-playing');
        document.body.classList.add('is-playing');
      } else {
        var saved = scrollLock;
        document.body.classList.remove('is-playing');
        document.documentElement.classList.remove('is-playing');
        document.body.style.removeProperty('--play-scroll-top');
        document.body.style.removeProperty('--play-scrollbar-gap');
        scrollLock = null;
        if (saved) window.scrollTo(saved.x, saved.y);
      }
    }

    // ---- settings ------------------------------------------------------------------
    function renderSettings() {
      var level = levelOf(levels, settings.speedId);

      if (speedValueEl) speedValueEl.textContent = settings.useCustomSpeed
        ? 'Custom · ' + settings.speedCustom + ' ms'
        : level.label + ' · ' + level.ms + ' ms';
      if (growthValueEl) growthValueEl.textContent = settings.useCustomGrowth
        ? '×' + settings.growthCustom + ' per food'
        : '×' + settings.growth + ' per food';
      if (themeValueEl) themeValueEl.textContent = THEME_NAMES[settings.theme];

      if (speedGroup) {
        var sButtons = speedGroup.querySelectorAll('button[data-speed]');
        for (var i = 0; i < sButtons.length; i++) {
          var id = sButtons[i].getAttribute('data-speed');
          var pressed = id === 'custom' ? settings.useCustomSpeed : Number(id) === settings.speedId && !settings.useCustomSpeed;
          sButtons[i].setAttribute('aria-pressed', String(pressed));
        }
      }
      if (growthGroup) {
        var gButtons = growthGroup.querySelectorAll('button[data-growth]');
        for (var j = 0; j < gButtons.length; j++) {
          var gid = gButtons[j].getAttribute('data-growth');
          var gpressed = gid === 'custom' ? settings.useCustomGrowth : Number(gid) === settings.growth && !settings.useCustomGrowth;
          gButtons[j].setAttribute('aria-pressed', String(gpressed));
        }
      }
      if (customSpeedRow) customSpeedRow.hidden = !settings.useCustomSpeed;
      if (customSpeedInput) customSpeedInput.value = String(settings.speedCustom);
      if (customSpeedVal) customSpeedVal.textContent = settings.speedCustom + ' ms/step';
      if (customGrowthRow) customGrowthRow.hidden = !settings.useCustomGrowth;
      if (customGrowthInput) customGrowthInput.value = String(settings.growthCustom);
      if (customGrowthVal) customGrowthVal.textContent = '×' + settings.growthCustom + ' per food';

      if (themeGroup) {
        var tButtons = themeGroup.querySelectorAll('button[data-theme]');
        for (var k = 0; k < tButtons.length; k++) {
          tButtons[k].setAttribute('aria-pressed', String(tButtons[k].getAttribute('data-theme') === settings.theme));
        }
      }
      refreshReadouts();
    }

    function applyTheme() {
      document.documentElement.setAttribute('data-theme', settings.theme);
      game.setTheme(THEMES[settings.theme]);
      syncRain();
    }

    // The snake gets the CPU first: decorative background animation is
    // suspended for the duration of an active run and returns on pause/quit.
    function syncRain() {
      startMatrixRain(settings.theme === 'terminal' && !playingNow);
    }

    function setLocked(next) {
      locked = next;
      if (settingsCard) {
        settingsCard.classList.toggle('is-locked', next);
        var controls = settingsCard.querySelectorAll('button, input');
        for (var i = 0; i < controls.length; i++) controls[i].disabled = next;
      }
      if (settingsLock) settingsLock.hidden = !next;
    }

    // ---- leaderboard -----------------------------------------------------------------
    // One board is shown at a time. Each has its own speed/growth filter. A filter
    // value is 'all', a preset id ('3'), 'c' (any custom value) or 'cNN' (exactly NN).
    var board = {
      which: 'standard',
      filters: { standard: { speed: '3', growth: '1' }, custom: { speed: 'all', growth: 'all' } },
      seq: 0,
      last: null,
      timer: 0
    };
    var tabEls = all('.lb__tab');
    var chipsSpeed = $('filter-speed');
    var chipsGrowth = $('filter-growth');
    var statusEl = $('lb-status');
    var bodyEl = $('board-body');

    function chip(value, label, pressed) {
      return '<button type="button" class="fchip" data-value="' + value + '" aria-pressed="' + pressed + '">' + esc(label) + '</button>';
    }

    function customInput(kind, value) {
      var shown = value.length > 1 ? value.slice(1) : '';
      return '<input class="fchip-input" type="number" min="0" max="100" step="1" inputmode="numeric" ' +
        'placeholder="any" value="' + shown + '" data-kind="' + kind + '" ' +
        'aria-label="Exact custom ' + (kind === 'speed' ? 'speed in milliseconds' : 'growth') + ' (optional)">';
    }

    function renderTabs() {
      tabEls.forEach(function (tab) {
        var on = tab.getAttribute('data-board') === board.which;
        tab.classList.toggle('is-active', on);
        tab.setAttribute('aria-selected', String(on));
      });
    }

    function renderFilters() {
      if (!chipsSpeed || !chipsGrowth) return;
      var f = board.filters[board.which];
      var custom = board.which === 'custom';

      var sp = chip('all', 'All', f.speed === 'all');
      levels.forEach(function (l) { sp += chip(String(l.id), l.label, f.speed === String(l.id)); });
      if (custom) {
        var spCustom = f.speed.charAt(0) === 'c';
        sp += chip('c', 'Custom', spCustom) + (spCustom ? customInput('speed', f.speed) : '');
      }
      chipsSpeed.innerHTML = sp;

      var gr = chip('all', 'All', f.growth === 'all');
      for (var n = 1; n <= 5; n++) gr += chip(String(n), '×' + n, f.growth === String(n));
      if (custom) {
        var grCustom = f.growth.charAt(0) === 'c';
        gr += chip('c', 'Custom', grCustom) + (grCustom ? customInput('growth', f.growth) : '');
      }
      chipsGrowth.innerHTML = gr;
    }

    function filterText(kind, v) {
      if (v === 'all') return kind === 'speed' ? 'all speeds' : 'all growth';
      if (v === 'c') return kind === 'speed' ? 'any custom speed' : 'any custom growth';
      if (v.charAt(0) === 'c') return kind === 'speed' ? 'custom ' + v.slice(1) + ' ms' : 'custom ×' + v.slice(1);
      if (kind === 'speed') {
        var lvl = levelOf(levels, Number(v));
        return lvl.label + ' (' + lvl.ms + ' ms)';
      }
      return '×' + v;
    }

    function renderBoard() {
      if (!bodyEl || !board.last) return;
      var data = board.last;
      var f = board.filters[data.board];
      var rows = data.rows || [];
      var name = data.board === 'custom' ? 'Custom' : 'Standard';
      var scope = filterText('speed', f.speed) + ' · ' + filterText('growth', f.growth);

      if (!rows.length) {
        bodyEl.innerHTML = '<tr class="empty"><td colspan="6">No runs match these filters yet. ' +
          'Try “Reset filters”, or be the first on the board.</td></tr>';
        if (statusEl) statusEl.textContent = name + ' board · ' + scope + ' · no runs yet';
        return;
      }

      var max = rows.reduce(function (m, r) { return Math.max(m, r.score); }, 1);
      var html = '';
      rows.forEach(function (r, i) {
        var mine = authUser && r.username === authUser;
        var justSaved = pendingHighlight && mine;
        var badge = i < 3 ? String(i + 1) : 'n';
        var width = Math.max(4, Math.round((r.score / max) * 100));
        html += '<tr class="' + (mine ? 'is-you ' : '') + (justSaved ? 'just-saved' : '') + '">' +
          '<td class="rank"><span class="rank__badge rank__badge--' + badge + '">' + (i + 1) + '</span></td>' +
          '<td class="user"><a class="user__cell user__link" href="/profile/' + encodeURIComponent(r.username) + '" title="View ' + esc(r.username) + '\'s profile">' +
            '<span class="avatar">' + esc(r.username.charAt(0).toUpperCase()) + '</span>' +
            '<span class="user__name">' + esc(r.username) + '</span>' + (mine ? '<span class="you-tag">you</span>' : '') + '</a></td>' +
          '<td class="dim">' + esc(rowSpeedText(r)) + '</td>' +
          '<td class="dim">' + esc(rowGrowthText(r)) + '</td>' +
          '<td class="num"><b>' + r.score + '</b><span class="scorebar" style="--w:' + width + '%"></span></td>' +
          '<td class="dim">' + fmtDate(r.created_at) + '</td></tr>';
      });
      bodyEl.innerHTML = html;

      // One-shot: mark the player's own row, without moving the page.
      if (pendingHighlight) {
        pendingHighlight = false;
        // Keep the result screen in view. The saved row remains highlighted,
        // but viewing the leaderboard is now an explicit navigation choice.
      }

      var total = Number(data.total) || rows.length;
      if (statusEl) {
        statusEl.textContent = name + ' board · ' + scope + ' · ' +
          (total > rows.length ? 'top ' + rows.length + ' of ' + total + ' runs' : total + (total === 1 ? ' run' : ' runs'));
      }
    }

    // Responses can finish out of order, so only the newest request may draw.
    function loadBoard() {
      var seq = ++board.seq;
      var which = board.which;
      var f = board.filters[which];
      if (statusEl && !board.last) statusEl.textContent = 'Loading the board…';
      api('/api/leaderboard?board=' + which + '&speed=' + encodeURIComponent(f.speed) + '&growth=' + encodeURIComponent(f.growth))
        .then(readJson)
        .then(function (out) {
          if (seq !== board.seq) return;
          if (!out.ok) { if (statusEl) statusEl.textContent = 'Could not load the board. Please try again.'; return; }
          board.last = out.json;
          board.last.board = which;
          renderBoard();
        })
        .catch(function () {
          if (seq === board.seq && statusEl) statusEl.textContent = 'Could not reach the server.';
        });
    }

    function selectBoard(which) {
      board.which = which;
      renderTabs();
      renderFilters();
      loadBoard();
    }

    tabEls.forEach(function (tab) {
      tab.addEventListener('click', function () { selectBoard(tab.getAttribute('data-board')); });
    });

    var filtersEl = $('lb-filters');
    if (filtersEl) {
      filtersEl.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('.fchip') : null;
        if (!btn) return;
        var kind = btn.parentNode.id === 'filter-speed' ? 'speed' : 'growth';
        board.filters[board.which][kind] = btn.getAttribute('data-value');
        renderFilters();
        loadBoard();
      });
      filtersEl.addEventListener('input', function (e) {
        var input = e.target;
        if (!input.classList || !input.classList.contains('fchip-input')) return;
        var kind = input.getAttribute('data-kind');
        window.clearTimeout(board.timer);
        board.timer = window.setTimeout(function () {
          var n = parseInt(input.value, 10);
          board.filters[board.which][kind] = isNaN(n) ? 'c' : 'c' + Math.min(100, Math.max(0, n));
          loadBoard();
        }, 250);
      });
    }

    var resetBtn = $('filter-reset');
    if (resetBtn) {
      resetBtn.addEventListener('click', function () {
        board.filters[board.which] = board.which === 'standard'
          ? { speed: '3', growth: '1' }
          : { speed: 'all', growth: 'all' };
        renderFilters();
        loadBoard();
      });
    }

    var mineBtn = $('filter-mine');
    if (mineBtn) {
      mineBtn.addEventListener('click', function () {
        var custom = settings.useCustomSpeed || settings.useCustomGrowth;
        board.which = custom ? 'custom' : 'standard';
        board.filters[board.which] = {
          speed: settings.useCustomSpeed ? 'c' + settings.speedCustom : String(settings.speedId),
          growth: settings.useCustomGrowth ? 'c' + settings.growthCustom : String(settings.growth)
        };
        renderTabs();
        renderFilters();
        loadBoard();
      });
    }

    // ---- accounts and saving ------------------------------------------------------------
    var authDialog = $('auth-dialog');
    var authOut = $('auth-out');
    var authIn = $('auth-in');
    var authUserChip = $('auth-user');
    var formLogin = $('form-login');
    var formCreate = $('form-create');
    var tabLogin = $('auth-tab-login');
    var tabCreate = $('auth-tab-create');
    var saveNote = $('final-save');
    var saveNoteText = $('final-save-text');
    var saveNoteActions = $('final-save-actions');
    var againBtn = $('btn-again');

    function renderAuth() {
      if (authOut) authOut.hidden = !!authUser;
      if (authIn) authIn.hidden = !authUser;
      if (authUserChip) {
        authUserChip.innerHTML = authUser
          ? '<i class="chip__dot" aria-hidden="true"></i>Player — <b>' + esc(authUser) + '</b>'
          : '';
        authUserChip.classList.toggle('is-signed-in', !!authUser);
      }
      refreshReadouts();
      if (board.last) renderBoard();
    }

    function saveNoteShow(text, showActions) {
      if (saveNote) saveNote.hidden = false;
      if (saveNoteText) saveNoteText.textContent = text;
      if (saveNoteActions) saveNoteActions.hidden = !showActions;
      fitOverlayPanel();
    }

    // Guests can play, but nothing is stored for them. A finished guest run is
    // held here and saved the moment they sign in. Starting another run or
    // signing out discards it, so a run is never attached to the wrong account.
    function saveRun(payload) {
      if (!authUser) {
        pendingRun = payload;
        saveNoteShow('Guest runs are not saved. Sign in to keep this run.', true);
        return;
      }
      submitScore(payload);
    }

    // The note only claims "Saved" after the server has said so.
    function submitScore(payload) {
      pendingRun = null;
      saveNoteShow('Saving…', false);
      api('/api/scores', { method: 'POST', body: JSON.stringify(payload) })
        .then(readJson)
        .then(function (out) {
          if (out.ok) {
            comboBest = out.json.best || comboBest;
            applyXpPayload(out.json);
            saveNoteShow('Saved to the leaderboard as ' + authUser + '.', false);
            refreshReadouts();
            pendingHighlight = true; // renderBoard will flash + scroll to this row
            loadBoard();
          } else if (out.status === 401) {
            // The server does not recognise this browser's session any more.
            authUser = null;
            setToken(null);
            pendingRun = payload;
            renderAuth();
            saveNoteShow('Your session is no longer valid, so this run is not saved yet. Sign in again and it will be added.', true);
          } else {
            saveNoteShow('Could not save this run (' + (out.json.error || 'error ' + out.status) + ').', false);
          }
        })
        .catch(function () {
          saveNoteShow('Could not reach the server, so this run was not saved.', false);
        });
    }

    // Returns true when a save was sent; its response already carries the
    // refreshed best, and it reloads the board itself.
    function flushPendingRun() {
      if (!pendingRun || !authUser) return false;
      submitScore(pendingRun);
      return true;
    }

    // "Play again" waits out the same one-second lockout the engine enforces.
    function lockAgain() {
      if (!againBtn) return;
      againBtn.disabled = true;
      var wait = game.lockoutRemaining ? game.lockoutRemaining() : 1000;
      window.setTimeout(function () { againBtn.disabled = false; }, Math.ceil(wait) + 20);
    }

    function levelFromXp(xp) {
      xp = Math.max(0, Math.round(Number(xp) || 0));
      var level = Math.floor(Math.sqrt(xp / 100)) + 1;
      var base = 100 * (level - 1) * (level - 1);
      var next = 100 * level * level;
      var span = Math.max(1, next - base);
      var into = xp - base;
      return { xp: xp, level: level, into: into, span: span, toNext: next - xp, pct: into / span };
    }

    function renderXp(progress) {
      var meter = $('xp-meter');
      if (!meter) return;
      var levelEl = $('xp-level');
      var textEl = $('xp-text');
      var fill = $('xp-fill');
      var bar = $('xp-bar');
      var nextEl = $('xp-next');
      var signin = $('xp-signin');
      var signedIn = !!progress;
      if (signin) signin.hidden = signedIn;
      if (textEl) textEl.hidden = !signedIn;
      if (!signedIn) {
        if (levelEl) levelEl.textContent = 'Level —';
        if (nextEl) nextEl.textContent = '';
        if (fill) fill.style.width = '0%';
        if (bar) {
          bar.setAttribute('aria-valuenow', '0');
          bar.setAttribute('aria-valuemax', '100');
          bar.setAttribute('aria-label', 'Sign in to track XP');
        }
        return;
      }
      var pct = Math.max(progress.into ? 3 : 0, Math.round(progress.pct * 100));
      if (levelEl) levelEl.textContent = 'Level ' + progress.level;
      if (textEl) textEl.textContent = progress.into + ' / ' + progress.span + ' XP';
      if (nextEl) nextEl.textContent = progress.toNext + ' XP to level ' + (progress.level + 1);
      if (fill) fill.style.width = pct + '%';
      if (bar) {
        bar.setAttribute('aria-valuenow', String(progress.into));
        bar.setAttribute('aria-valuemax', String(progress.span));
        bar.setAttribute('aria-label', 'Progress to level ' + (progress.level + 1));
      }
    }

    function applyXpPayload(json) {
      if (!json || json.xp == null) { renderXp(null); return; }
      var progress = json.xp.level != null ? json.xp : levelFromXp(json.xp);
      renderXp(progress);
    }

    var scoresSeq = 0;
    function loadScores() {
      var seq = ++scoresSeq;
      api('/api/scores').then(readJson).then(function (out) {
        if (seq !== scoresSeq || !out.ok) return;
        comboBest = out.json.best || {};
        applyXpPayload(out.json);
        refreshReadouts();
      }).catch(function () { /* offline: keep what we have */ });
    }

    function setAuthMode(mode) {
      var login = mode !== 'create';
      if (formLogin) formLogin.hidden = !login;
      if (formCreate) formCreate.hidden = login;
      if (tabLogin) tabLogin.setAttribute('aria-selected', String(login));
      if (tabCreate) tabCreate.setAttribute('aria-selected', String(!login));
    }

    function openAuthDialog(mode) {
      if (!authDialog) return;
      game.pause();
      setAuthMode(mode);
      if (authDialog.showModal && !authDialog.open) authDialog.showModal();
    }

    function postAuth(url, form, errElId) {
      var errEl = $(errElId);
      var data = {
        username: form.elements.username ? form.elements.username.value : '',
        password: form.elements.password ? form.elements.password.value : ''
      };
      if (errEl) errEl.textContent = '';
      return api(url, { method: 'POST', body: JSON.stringify(data) })
        .then(readJson)
        .then(function (out) {
          if (!out.ok) {
            if (errEl) errEl.textContent = out.json.error || 'Something went wrong';
            return;
          }
          authUser = out.json.user && out.json.user.username;
          setToken(out.json.token || null);
          comboBest = {};
          renderAuth();
          if (authDialog && authDialog.open) authDialog.close();
          if (!flushPendingRun()) loadScores();
          loadBoard();
        })
        .catch(function () {
          if (errEl) errEl.textContent = 'Network error — try again';
        });
    }

    function loadMe() {
      return api('/api/auth/me').then(readJson).then(function (out) {
        authUser = out.ok && out.json.user ? out.json.user.username : null;
        if (!authUser) setToken(null); // a stale token is no use to anyone
        renderAuth();
      }).catch(function () { /* stay anonymous */ });
    }

    // ---- game events ------------------------------------------------------------------------
    game.on('score', setScore);

    game.on('start', function () {
      setScore(0);
      hideOverlay();
      // Bring the HUD and the whole box into view, then lock the page there,
      // so the score is on screen for the entire run.
      revealPlayfield();
      setPlaying(true);
      if (pauseBtn) pauseBtn.textContent = 'Pause';
      setLocked(true);
      playingNow = true;
      pendingRun = null; // starting a new run discards an unsaved guest run
      if (saveNote) saveNote.hidden = true;
      syncRain();
    });

    game.on('pause', function (state) {
      setPlaying(false);
      if (pauseSpeedEl) pauseSpeedEl.textContent = speedText(state);
      if (pauseGrowthEl) pauseGrowthEl.textContent = growthText(state) + ' per food';
      if (pauseBtn) pauseBtn.textContent = 'Unpause';
      showPanel('pause');
      playingNow = false;
      syncRain();
    });

    game.on('resume', function () {
      if (pauseBtn) pauseBtn.textContent = 'Pause';
      hideOverlay();
      // The page was k before
      // locking again, so the score is visible when play continues.
      revealPlayfield();
      setPlaying(true);
      playingNow = true;
      syncRain();
    });

    game.on('gameover', function (state) {
      setPlaying(false);
      if (pauseBtn) pauseBtn.textContent = 'Pause';
      setLocked(false);
      playingNow = false;
      syncRain();

      var key = comboKeyOf(state);
      var previousBest = bestFor(key);
      var isRecord = state.score > 0 && (previousBest === undefined || state.score > previousBest);

      var scoreEl = $('final-score');
      var speedEl = $('final-speed');
      var growthEl = $('final-growth');
      var bestEl = $('final-best');
      var flagEl = $('final-flag');

      if (scoreEl) scoreEl.textContent = String(state.score);
      if (speedEl) speedEl.textContent = speedText(state) + ' / step';
      if (growthEl) growthEl.textContent = growthText(state) + ' blocks per food';
      if (bestEl) {
        bestEl.textContent = (previousBest === undefined ? '—' : String(previousBest)) +
          (isRecord ? ' → ' + state.score : '');
      }
      if (flagEl) flagEl.hidden = !isRecord;

      addRun(state);
      refreshReadouts();
      showPanel('over');
      lockAgain();

      saveRun({
        score: state.score,
        speed_level: state.useCustomSpeed ? null : state.speedPreset,
        speed_custom: state.useCustomSpeed ? state.speedCustom : null,
        growth: state.useCustomGrowth ? null : state.growthPreset,
        growth_custom: state.useCustomGrowth ? state.growthCustom : null,
        end_state: state.endState || null
      });
    });

    // ---- controls ----------------------------------------------------------------------------
    function bindClick(id, fn) {
      var node = $(id);
      if (node) node.addEventListener('click', fn);
    }

    function guard() { return !locked; }

    bindClick('btn-start', function () { game.start(); });
    bindClick('btn-again', function () { game.start(); });
    bindClick('btn-resume', function () { game.resume(); });
    bindClick('btn-quit', function () { game.quit(); });
    // The run is already over by the time the death screen shows, so "Quit" just
    // closes it and returns to the start screen (modifiers are unlocked by then).
    bindClick('btn-quit-over', function () { showPanel('start'); });
    bindClick('pause-btn', function () { game.togglePause(); });

    // Navigation remains usable during play: pause before the anchor scrolls.
    all('.masthead__meta a[href^="#"]').forEach(function (link) {
      link.addEventListener('click', function () { game.pause(); });
    });

    all('.js-settings').forEach(function (button) {
      button.addEventListener('click', function () {
        if (locked) return;
        hideOverlay();
        setPlaying(false);
        var card = $('settings-card');
        if (card && card.scrollIntoView) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });

    if (speedGroup) {
      speedGroup.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('button[data-speed]') : null;
        if (!btn || !guard()) return;
        var id = btn.getAttribute('data-speed');
        if (id === 'custom') {
          settings.useCustomSpeed = true;
          game.setCustomSpeed(settings.speedCustom);
        } else {
          settings.speedId = Number(id);
          settings.useCustomSpeed = false;
          game.setSpeed(settings.speedId);
        }
        saveSettings(settings);
        renderSettings();
      });
    }

    if (customSpeedInput) {
      customSpeedInput.addEventListener('input', function () {
        if (!guard()) return;
        settings.speedCustom = Number(customSpeedInput.value);
        saveSettings(settings);
        game.setCustomSpeed(settings.speedCustom);
        renderSettings();
      });
    }

    if (growthGroup) {
      growthGroup.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('button[data-growth]') : null;
        if (!btn || !guard()) return;
        var id = btn.getAttribute('data-growth');
        if (id === 'custom') {
          settings.useCustomGrowth = true;
          game.setCustomGrowth(settings.growthCustom);
        } else {
          settings.growth = Number(id);
          settings.useCustomGrowth = false;
          game.setGrowth(settings.growth);
        }
        saveSettings(settings);
        renderSettings();
      });
    }

    if (customGrowthInput) {
      customGrowthInput.addEventListener('input', function () {
        if (!guard()) return;
        settings.growthCustom = Number(customGrowthInput.value);
        saveSettings(settings);
        game.setCustomGrowth(settings.growthCustom);
        renderSettings();
      });
    }

    if (themeGroup) {
      themeGroup.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('button[data-theme]') : null;
        if (!btn || !guard()) return;
        var id = btn.getAttribute('data-theme');
        if (!THEMES[id]) return;
        settings.theme = id;
        saveSettings(settings);
        applyTheme();
        renderSettings();
      });
    }

    bindClick('xp-signin', function () { openAuthDialog('login'); });
    bindClick('btn-open-login', function () { openAuthDialog('login'); });
    bindClick('btn-open-create', function () { openAuthDialog('create'); });
    bindClick('btn-final-signin', function () { openAuthDialog('login'); });
    bindClick('btn-final-create', function () { openAuthDialog('create'); });
    bindClick('auth-close', function () { if (authDialog && authDialog.open) authDialog.close(); });
    bindClick('btn-logout', function () {
      api('/api/auth/logout', { method: 'POST' })
        .catch(function () { /* ignore */ })
        .then(function () {
          authUser = null;
          pendingRun = null;
          comboBest = {};
          setToken(null);
          if (saveNote) saveNote.hidden = true;
          renderAuth();
          renderXp(null);
          loadBoard();
        });
    });
    if (tabLogin) tabLogin.addEventListener('click', function () { setAuthMode('login'); });
    if (tabCreate) tabCreate.addEventListener('click', function () { setAuthMode('create'); });
    if (authDialog) {
      authDialog.addEventListener('click', function (e) {
        if (e.target === authDialog) authDialog.close();
      });
    }
    if (formLogin) {
      formLogin.addEventListener('submit', function (e) {
        e.preventDefault();
        postAuth('/api/auth/login', formLogin, 'auth-error-login');
      });
    }
    if (formCreate) {
      formCreate.addEventListener('submit', function (e) {
        e.preventDefault();
        var pw = formCreate.elements.password ? formCreate.elements.password.value : '';
        var confirm = formCreate.elements['confirm-password'] ? formCreate.elements['confirm-password'].value : '';
        var errEl = $('auth-error-create');
        if (pw !== confirm) {
          if (errEl) errEl.textContent = 'Passwords do not match';
          return;
        }
        postAuth('/api/auth/signup', formCreate, 'auth-error-create');
      });
    }

    document.addEventListener('keydown', function (e) {
      if (authDialog && authDialog.open) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var target = e.target;
      if (target && target.closest && target.closest('input, textarea, select, [contenteditable]')) return;
      var key = (e.key || '').toLowerCase();
      if (key === 'p' || key === 'escape') {
        var st = game.state();
        if (st.running) {
          e.preventDefault();
          game.togglePause();
        }
      }
    });

    // ---- Matrix rain (terminal theme, page background only) -----------------------------------
    // Time-based, independent of refresh rate: 8 rows/second, larger 20px glyphs
    // on a 22px grid. Bigger type in fewer columns is both easier to read and
    // strictly cheaper to draw than the old 13px/14px grid.
    var RAIN_COL = 22;
    var rain = {
      canvas: null, ctx: null, raf: 0, drops: [], w: 0, h: 0,
      running: false, last: null, accumulator: 0, stepMs: 1000 / 8,
      glyphs: '01ﾊﾐﾋｰｳｼﾅﾓﾆｻﾜﾂｵﾘｱﾎﾃﾏｹﾒｴｶｷﾑﾕﾗｾﾈｽ'
    };

    function sizeRain() {
      if (!rain.canvas) return;
      rain.w = window.innerWidth;
      rain.h = window.innerHeight;
      rain.canvas.width = rain.w;
      rain.canvas.height = rain.h;
      var cols = Math.ceil(rain.w / RAIN_COL);
      if (rain.drops.length !== cols) {
        rain.drops = [];
        for (var i = 0; i < cols; i++) rain.drops.push(Math.floor(Math.random() * -50));
      }
    }

    function rainFrame(t) {
      if (!rain.running) { rain.raf = 0; return; }
      rain.raf = window.requestAnimationFrame(rainFrame);
      if (document.hidden) { rain.last = null; rain.accumulator = 0; return; }
      var dt = rain.last == null ? 0 : Math.min(t - rain.last, 250);
      rain.last = t;
      rain.accumulator += dt;
      if (rain.accumulator < rain.stepMs) return;
      rain.accumulator %= rain.stepMs;

      var ctx = rain.ctx;
      ctx.fillStyle = 'rgba(3, 7, 10, 0.13)';
      ctx.fillRect(0, 0, rain.w, rain.h);
      ctx.font = '20px "IBM Plex Mono", monospace';
      ctx.fillStyle = 'rgba(49, 240, 132, 0.92)';
      for (var i = 0; i < rain.drops.length; i++) {
        var ch = rain.glyphs.charAt(Math.floor(Math.random() * rain.glyphs.length));
        ctx.fillText(ch, i * RAIN_COL, rain.drops[i] * RAIN_COL);
        if (rain.drops[i] * RAIN_COL > rain.h && Math.random() > 0.975) rain.drops[i] = 0;
        rain.drops[i] += 1;
      }
    }

    function startMatrixRain(enable) {
      if (!enable || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        rain.running = false;
        window.cancelAnimationFrame(rain.raf);
        rain.raf = 0;
        rain.last = null;
        rain.accumulator = 0;
        if (rain.canvas) rain.canvas.style.display = 'none';
        return;
      }
      if (!rain.canvas) {
        rain.canvas = $('matrix-rain');
        if (!rain.canvas) return;
        rain.ctx = rain.canvas.getContext('2d');
        if (!rain.ctx) return;
        window.addEventListener('resize', sizeRain);
      }
      rain.canvas.style.display = 'block';
      if (!rain.running) {
        sizeRain();
        rain.running = true;
        rain.last = null;
        rain.accumulator = 0;
        rain.raf = window.requestAnimationFrame(rainFrame);
      }
    }

    // ---- copy buttons on code blocks ----------------------------------------------------------
    all('pre.code').forEach(function (pre) {
      var parent = pre.parentElement;
      if (!parent) return;
      parent.style.position = 'relative';
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'code-copy';
      btn.textContent = 'Copy';
      btn.addEventListener('click', function () {
        var text = pre.innerText;
        function done(ok) {
          btn.textContent = ok ? 'Copied' : 'Ctrl+C';
          window.setTimeout(function () { btn.textContent = 'Copy'; }, 1400);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
        } else {
          pre.style.userSelect = 'all';
          done(false);
        }
      });
      parent.insertBefore(btn, pre);
    });

    applyTheme();
    renderTabs();
    renderFilters();
    renderSettings();
    renderAuth();
    setLocked(false);
    loadMe();
    loadScores();
    loadBoard();
  }

  // The engine script may be hoisted or deferred by the host page — wait for it.
  ready(function () {
    var tries = 0;
    (function wait() {
      if (window.SnakeGame && $('snake-root')) return boot();
      if (tries++ > 200) return;
      window.setTimeout(wait, 25);
    })();
  });
})();
