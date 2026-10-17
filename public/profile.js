/*
 * Next Level Snake — profile page.
 *
 * Shared by the Rails app and the preview. public/profile.js draws everything
 * into #profile-root from GET /api/profile (your own profile, or
 * GET /api/profile?username=NAME for any other player's public profile).
 *
 * Vanilla JS, no dependencies, no build step. Charts are hand-built SVG.
 */
(function () {
  'use strict';

  var TOKEN_KEY = 'snake.token.v1';
  var STORE_KEY = 'snake.settings.v1';

  var LEVELS = [
    { id: 1, label: 'Chill', ms: 165 },
    { id: 2, label: 'Easy', ms: 130 },
    { id: 3, label: 'Normal', ms: 105 },
    { id: 4, label: 'Fast', ms: 80 },
    { id: 5, label: 'Insane', ms: 60 },
    { id: 6, label: 'Ludicrous', ms: 42 }
  ];
  var THEMES = [
    { id: 'classic', name: 'Classic' },
    { id: 'arcade', name: 'Arcade' },
    { id: 'vintage', name: 'Vintage' },
    { id: 'terminal', name: 'Terminal' },
    { id: 'paper', name: 'Paper' },
    { id: 'violet', name: 'Midnight Violet' },
    { id: 'sunsetfire', name: 'Royal Sunset' }
  ];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // XP weights by speed level: faster modes are worth more. Custom-mode games
  // and quit runs earn no XP at all.
  var XP_WEIGHT = { 1: 0.6, 2: 0.8, 3: 1.0, 4: 1.3, 5: 1.6, 6: 2.0 };

  // Mini-board colours. Fixed (not theme variables): each board is a little
  // screen of its own, and must read the same on every cabinet skin.
  var BOARD = { field: '#07090c', snake: '#2ce05e', head: '#c9ffd8', food: '#ff3b30', crash: '#ffd34e' };

  var HEAT_WEEKS = 53;
  var LOG_PAGE = 20;
  var AVG_WINDOW = 5;

  var root = document.getElementById('profile-root');
  if (!root) return;

  function $(id) { return document.getElementById(id); }
  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function num(x) { return String(Math.round(x * 10) / 10); }
  function comma(x) { return String(Math.round(x)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  // ---- run classification ---------------------------------------------------
  // A run that the player quit does not count toward any stats; it only appears
  // in the log when it reached a score of 10 or higher.
  function isQuit(g) { return g.end_state && g.end_state.cause === 'quit'; }
  function isCompleted(g) { return !isQuit(g); }          // includes older runs with no end_state
  function isCustom(g) { return g.speed_custom != null || g.growth_custom != null; }
  function logVisible(g) { return isCompleted(g) || (isQuit(g) && g.score >= 10); }
  function xpFor(g) {
    if (!isCompleted(g) || isCustom(g)) return 0;
    var weight = (g.speed_level && XP_WEIGHT[g.speed_level]) || 1;
    return Math.round(g.score * weight);
  }
  // Level from XP: level L needs 100*(L-1)^2 cumulative XP.
  function levelFromXp(xp) {
    var level = Math.floor(Math.sqrt(xp / 100)) + 1;
    var base = 100 * (level - 1) * (level - 1);
    var next = 100 * level * level;
    var span = next - base;
    return { level: level, into: xp - base, span: span, to_next: next - xp, pct: span ? (xp - base) / span : 0 };
  }

  function totalXp(games) {
    var s = 0;
    for (var i = 0; i < games.length; i++) s += xpFor(games[i]);
    return s;
  }

  // ---- vocabulary: modes, themes, dates --------------------------------------
  function levelById(id) {
    for (var i = 0; i < LEVELS.length; i++) if (LEVELS[i].id === Number(id)) return LEVELS[i];
    return LEVELS[2];
  }
  function themeName(id) {
    for (var i = 0; i < THEMES.length; i++) if (THEMES[i].id === id) return THEMES[i].name;
    return id;
  }
  function speedText(g) {
    return g.speed_custom != null ? 'Custom ' + g.speed_custom + ' ms' : levelById(g.speed_level).label;
  }
  function growthText(g) {
    return g.growth_custom != null ? '\u00d7' + g.growth_custom + ' custom' : '\u00d7' + g.growth;
  }
  function modeLabel(g) { return speedText(g) + ' \u00b7 ' + growthText(g); }
  function modeKey(g) {
    return (g.speed_custom != null ? 'c' + g.speed_custom : String(g.speed_level)) + '-' +
      (g.growth_custom != null ? 'c' + g.growth_custom : String(g.growth));
  }

  function asDate(x) { return x instanceof Date ? x : new Date(x); }
  function dayKey(x) {
    var d = asDate(x);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function dayNumber(key) {
    var p = key.split('-');
    return Math.round(Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000);
  }
  function fmtDay(x) { var d = asDate(x); return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear(); }
  function fmtShort(x) { var d = asDate(x); return d.getDate() + ' ' + MONTHS[d.getMonth()]; }
  function fmtTime(x) { var d = asDate(x); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }

  // ---- aggregation -----------------------------------------------------------
  // One row per mode (completed, non-quit games only), most-played first.
  function modeTable(games) {
    var map = {};
    var list = [];
    games.forEach(function (g) {
      if (!isCompleted(g)) return;
      var key = modeKey(g);
      var m = map[key];
      if (!m) { m = map[key] = { key: key, label: modeLabel(g), count: 0, sum: 0, best: 0, last: 0 }; list.push(m); }
      m.count += 1;
      m.sum += g.score;
      if (g.score > m.best) m.best = g.score;
      var t = asDate(g.created_at).getTime();
      if (t > m.last) m.last = t;
    });
    list.sort(function (a, b) { return b.count - a.count || b.best - a.best; });
    return list;
  }

  // Stats over completed (non-quit) games. `total` is every game in the log.
  function summarize(games) {
    var s = { total: games.length, completed: 0, food: 0, best: 0, bestGame: null, days: {}, last30: 0, avg: 0 };
    var cutoff = Date.now() - 30 * 86400000;
    games.forEach(function (g) {
      if (!isCompleted(g)) return;
      s.completed += 1;
      s.food += g.score;
      if (!s.bestGame || g.score > s.bestGame.score) s.bestGame = g;
      var k = dayKey(g.created_at);
      s.days[k] = (s.days[k] || 0) + 1;
      if (asDate(g.created_at).getTime() >= cutoff) s.last30 += 1;
    });
    s.best = s.bestGame ? s.bestGame.score : 0;
    s.avg = s.completed ? s.food / s.completed : 0;

    var nums = Object.keys(s.days).map(dayNumber).sort(function (a, b) { return a - b; });
    s.activeDays = nums.length;
    var longest = 0, run = 0, prev = null;
    nums.forEach(function (n) {
      run = prev !== null && n === prev + 1 ? run + 1 : 1;
      if (run > longest) longest = run;
      prev = n;
    });
    s.longest = longest;

    var have = {};
    nums.forEach(function (n) { have[n] = true; });
    var today = dayNumber(dayKey(new Date()));
    var cursor = have[today] ? today : have[today - 1] ? today - 1 : null;
    var current = 0;
    while (cursor !== null && have[cursor]) { current += 1; cursor -= 1; }
    s.current = current;
    return s;
  }

  // ---- ending-position board --------------------------------------------------
  function boardSvg(es) {
    if (!es || !es.snake || !es.snake.length) {
      return '<div class="board board--none" title="No snapshot was recorded for this older game">no<br>snapshot</div>';
    }
    var cols = es.cols, rows = es.rows;
    var d = '';
    for (var i = 0; i < es.snake.length; i++) {
      var c = es.snake[i];
      d += 'M' + (c % cols) + ' ' + Math.floor(c / cols) + 'h1v1h-1z';
    }
    var head = es.snake[0];
    var label = 'Ending snake position, length ' + es.snake.length +
      (es.cause === 'crash' ? ', ended in a crash' : ', ended by quitting');
    var out = '<svg class="board" viewBox="0 0 ' + cols + ' ' + rows + '" role="img" aria-label="' + esc(label) +
      '" shape-rendering="crispEdges">' +
      '<rect class="b-field" width="' + cols + '" height="' + rows + '" fill="' + BOARD.field + '"/>' +
      '<path class="b-snake" d="' + d + '" fill="' + BOARD.snake + '"/>' +
      '<rect class="b-head" x="' + (head % cols) + '" y="' + Math.floor(head / cols) + '" width="1" height="1" fill="' + BOARD.head + '"/>';
    if (es.food != null) {
      out += '<rect class="b-food" x="' + ((es.food % cols) + 0.15) + '" y="' + (Math.floor(es.food / cols) + 0.15) +
        '" width="0.7" height="0.7" fill="' + BOARD.food + '"/>';
    }
    if (es.crash != null) {
      var x = es.crash % cols, y = Math.floor(es.crash / cols);
      out += '<path class="b-crash" d="M' + (x + 0.12) + ' ' + (y + 0.12) + 'l0.76 0.76M' + (x + 0.88) + ' ' + (y + 0.12) +
        'l-0.76 0.76" stroke="' + BOARD.crash + '" stroke-width="0.3" stroke-linecap="round" fill="none"/>';
    }
    return out + '</svg>';
  }

  // ---- state -------------------------------------------------------------------
  var authUser = null;      // the signed-in player's name (or null)
  var state = {
    username: null,          // whose profile is shown
    isYou: true,
    games: [],               // newest first, as the API returns them
    rank: 1,
    favorite: null,
    chartMode: 'all',
    logMode: 'all',
    logShown: LOG_PAGE,
    confirmId: null,
    themeNote: '',
    toastTimer: 0
  };

  // ---- api ---------------------------------------------------------------------
  function api(url, options) {
    options = options || {};
    var headers = { Accept: 'application/json' };
    if (options.method && options.method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      if (options.body === undefined) options.body = '{}';
    }
    var token = getToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    options.headers = headers;
    options.credentials = 'same-origin';
    return fetch(url, options);
  }
  function readJson(res) {
    return res.json().then(
      function (json) { return { ok: res.ok, status: res.status, json: json || {} }; },
      function () { return { ok: res.ok, status: res.status, json: {} }; }
    );
  }
  function getToken() {
    try { return window.localStorage.getItem(TOKEN_KEY); } catch (err) { return null; }
  }
  function setToken(token) {
    try {
      if (token) window.localStorage.setItem(TOKEN_KEY, token);
      else window.localStorage.removeItem(TOKEN_KEY);
    } catch (err) { /* ignore */ }
  }

  // ---- profile target ----------------------------------------------------------
  // #profile-root carries data-username when viewing another player; otherwise
  // it is the viewer's own profile (requires sign-in).
  function profileUrl() {
    var u = root.getAttribute('data-username');
    return u ? '/api/profile?username=' + encodeURIComponent(u) : '/api/profile';
  }

  function applyProfile(json) {
    state.username = json.user.username;
    state.isYou = json.user.is_you === true;
    state.games = json.user.games || [];
    state.rank = json.user.rank || 1;
    state.favorite = json.user.favorite_theme || null;
    state.chartMode = 'all';
    state.logMode = 'all';
    state.logShown = LOG_PAGE;
    state.confirmId = null;
    state.themeNote = '';
  }

  function loadProfile() {
    root.setAttribute('aria-busy', 'true');
    root.innerHTML = '<p class="pf-loading">Loading the profile\u2026</p>';
    api(profileUrl()).then(readJson).then(function (out) {
      root.removeAttribute('aria-busy');
      if (out.status === 404) { showError('No player with that name.'); return; }
      if (out.status === 401) { showGate(); return; }
      if (!out.ok) { showError(out.json.error || 'Could not load the profile.'); return; }
      applyProfile(out.json);
      setSkinVisible(true);
      buildShell();
      renderAll();
    }).catch(function () {
      root.removeAttribute('aria-busy');
      showError('Could not reach the server.');
    });
  }

  // ---- shell ---------------------------------------------------------------------
  function buildShell() {
    var eyebrow = state.isYou ? 'Your profile' : 'Viewing ' + state.username + ' \u00b7 public profile';
    var xp = totalXp(state.games);
    var lvl = levelFromXp(xp);
    var favName = state.favorite ? themeName(state.favorite) : null;
    var s = summarize(state.games);

    root.innerHTML =
      '<section class="card pf-hero" id="pf-hero">' +
        '<div class="pf-avatar" aria-hidden="true">' + esc((state.username || '?').charAt(0).toUpperCase()) + '</div>' +
        '<div class="pf-id">' +
          '<p class="pf-eyebrow">' + esc(eyebrow) + '</p>' +
          '<h1 class="pf-name" id="pf-name">' + esc(state.username) + '</h1>' +
          '<div class="pf-hero-metrics">' +
            '<div class="pf-rank-badge">' +
              '<span class="pf-rank-badge__label">Overall Rank</span>' +
              '<span class="pf-rank-badge__val">#' + comma(state.rank) + '</span>' +
            '</div>' +
            '<div class="pf-stat-badge">' +
              '<span class="pf-stat-badge__label">Total Games</span>' +
              '<span class="pf-stat-badge__val">' + comma(s.total) + '</span>' +
            '</div>' +
          '</div>' +
          '<div class="xp-meter pf-level">' +
            '<div class="xp-meter__top">' +
              '<span class="xp-meter__level pf-level__num">Level ' + lvl.level + '</span>' +
              '<div class="xp-meter__info-wrap">' +
                '<span class="xp-meter__xp pf-level__xp">' + comma(xp) + ' XP</span>' +
                '<button type="button" class="xp-info-btn" aria-label="How XP is calculated" tabindex="0">' +
                  '<span class="xp-info-icon" aria-hidden="true">i</span>' +
                  '<span class="xp-popover" role="tooltip">' +
                    '<strong>How XP is calculated</strong>' +
                    '<p>Earn XP on completed runs with preset speeds:</p>' +
                    '<ul class="xp-popover__list">' +
                      '<li><span>Chill (165ms)</span><b>\u00d70.6</b></li>' +
                      '<li><span>Easy (130ms)</span><b>\u00d70.8</b></li>' +
                      '<li><span>Normal (105ms)</span><b>\u00d71.0</b></li>' +
                      '<li><span>Fast (80ms)</span><b>\u00d71.3</b></li>' +
                      '<li><span>Insane (60ms)</span><b>\u00d71.6</b></li>' +
                      '<li><span>Ludicrous (42ms)</span><b>\u00d72.0</b></li>' +
                    '</ul>' +
                    '<p class="xp-popover__note">XP = Score \u00d7 Speed multiplier. Quits and custom sliders earn 0 XP. Level L requires 100 \u00d7 (L\u22121)\u00b2 cumulative XP.</p>' +
                  '</span>' +
                '</button>' +
              '</div>' +
            '</div>' +
            '<div class="xp-meter__bar pf-level__bar" role="progressbar" aria-valuemin="0" aria-valuemax="' + lvl.span + '" aria-valuenow="' + lvl.into + '" aria-label="Progress to level ' + (lvl.level + 1) + '">' +
              '<i style="width:' + Math.max(lvl.into ? 3 : 0, Math.round(lvl.pct * 100)) + '%"></i>' +
            '</div>' +
            '<span class="xp-meter__next">' + comma(lvl.into) + ' / ' + comma(lvl.span) + ' XP \u00b7 ' + comma(lvl.to_next) + ' to level ' + (lvl.level + 1) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="pf-fav">' +
          '<span class="pf-fav__label">Favorite theme</span>' +
          (state.favorite
            ? '<span class="pf-fav__value" id="pf-fav-badge"><span class="swatch" data-swatch="' + esc(state.favorite) + '"><i aria-hidden="true"></i></span>' + esc(favName) + '</span>'
            : '<span class="pf-fav__value is-empty" id="pf-fav-badge">Not picked yet</span>') +
        '</div>' +
      '</section>' +

      '<section class="pf-tiles" id="pf-tiles" aria-label="Your stats"></section>' +

      '<div class="pf-grid">' +
        '<section class="card pf-card pf-wide" aria-labelledby="pf-chart-title">' +
          '<div class="pf-card__head"><h2 class="card__title" id="pf-chart-title">Progress</h2>' +
          '<label class="pf-select"><span class="sr-only">Mode shown in the chart</span><select id="pf-chart-mode"></select></label></div>' +
          '<div class="pf-chart" id="pf-chart"></div>' +
          '<p class="pf-trend" id="pf-trend"></p>' +
          '<ul class="pf-legend" aria-hidden="true"><li><i class="lg lg--pt"></i>Each game</li>' +
          '<li><i class="lg lg--avg"></i>' + AVG_WINDOW + '-game average</li><li><i class="lg lg--best"></i>Best so far</li></ul>' +
        '</section>' +
        '<section class="card pf-card pf-wide" id="pf-heat-card"></section>' +
        '<section class="card pf-card" id="pf-modes"></section>' +
        '<section class="card pf-card" id="pf-theme"></section>' +
        '<section class="card pf-card pf-wide" id="pf-bests"></section>' +
        '<section class="card pf-card pf-wide" aria-labelledby="pf-log-title">' +
          '<div class="pf-card__head"><h2 class="card__title" id="pf-log-title">Game log</h2>' +
          '<span class="pf-count" id="pf-log-count"></span>' +
          '<label class="pf-select"><span class="sr-only">Mode shown in the log</span><select id="pf-log-mode"></select></label></div>' +
          '<ol class="log" id="pf-log"></ol>' +
          '<div class="pf-more"><button type="button" class="btn btn--small" id="pf-log-more" hidden>Show more</button></div>' +
        '</section>' +
      '</div>' +
      '<div class="pf-toast" id="pf-toast" role="status" aria-live="polite"></div>';

    if (!state.isYou && authUser) {
      var you = root.querySelector('.pf-id');
      if (you) {
        var back = document.createElement('p');
        back.className = 'pf-back';
        back.innerHTML = 'This is a public profile. ' +
          '<a class="pf-back__link" href="/profile">View your own profile</a>';
        you.appendChild(back);
      }
    }
  }

  // ---- sections -----------------------------------------------------------------
  function renderHero() {
    // The hero is built in buildShell(); kept as a no-op for renderAll symmetry.
  }

  function tile(key, label, value, sub) {
    return '<div class="pf-tile" data-stat="' + key + '"><span class="pf-tile__label">' + label + '</span>' +
      '<span class="pf-tile__value">' + value + '</span><span class="pf-tile__sub">' + sub + '</span></div>';
  }

  function renderTiles() {
    var s = summarize(state.games);
    var last10 = state.games.filter(isCompleted).slice(0, 10);
    var last10avg = last10.length
      ? last10.reduce(function (sum, g) { return sum + g.score; }, 0) / last10.length
      : 0;
    $('pf-tiles').innerHTML =
      tile('games', 'Games completed in last 30 days', comma(s.last30), comma(s.completed) + ' all-time') +
      tile('best', 'Best score', s.best, s.bestGame ? esc(modeLabel(s.bestGame)) : 'No games yet') +
      tile('avg', 'Average score', s.completed ? num(s.avg) : '\u2014', last10.length ? 'last ' + last10.length + ': ' + num(last10avg) : 'play a game') +
      tile('food', 'Food eaten', comma(s.food), 'pieces across runs') +
      tile('active', 'Active days', s.activeDays, 'days with at least one game') +
      tile('streak', 'Day streak', s.current, 'longest ' + plural(s.longest, 'day', 'days'));
  }

  function renderModes() {
    var host = $('pf-modes');
    var list = modeTable(state.games);
    if (!list.length) {
      host.innerHTML = '<h2 class="card__title">Favorite mode</h2><p class="pf-empty">Play a few games and your favorite mode shows up here.</p>';
      return;
    }
    var fav = list[0];
    var total = state.games.filter(isCompleted).length || 1;
    host.innerHTML =
      '<h2 class="card__title">Favorite mode</h2>' +
      '<p class="pf-fav-mode" id="pf-fav-mode"><b>' + esc(fav.label) + '</b><span>' + plural(fav.count, 'game', 'games') +
      ' \u00b7 ' + Math.round((fav.count / total) * 100) + '% of runs</span></p>' +
      '<ul class="mb">' + list.slice(0, 6).map(function (m, i) {
        return '<li class="mb__row' + (i === 0 ? ' is-fav' : '') + '"><span class="mb__label">' + esc(m.label) + '</span>' +
          '<span class="mb__bar"><i style="width:' + Math.max(4, Math.round((m.count / fav.count) * 100)) + '%"></i></span>' +
          '<span class="mb__n">' + m.count + '</span></li>';
      }).join('') + '</ul>';
  }

  function renderBests() {
    var host = $('pf-bests');
    var list = modeTable(state.games).sort(function (a, b) { return b.best - a.best || b.count - a.count; });
    if (!list.length) {
      host.innerHTML = '<h2 class="card__title">High scores</h2><p class="pf-empty">No high scores yet \u2014 the best run in each mode lands here.</p>';
      return;
    }
    host.innerHTML =
      '<h2 class="card__title">High scores <span class="pf-sub">best run per mode</span></h2>' +
      '<div class="pf-scroll"><table class="records pf-bests"><thead><tr><th scope="col">Mode</th><th scope="col">Best</th>' +
      '<th scope="col">Games</th><th scope="col">Average</th><th scope="col">Last played</th></tr></thead><tbody>' +
      list.map(function (m) {
        return '<tr data-mode="' + esc(m.key) + '"><td>' + esc(m.label) + '</td><td class="num">' + m.best + '</td>' +
          '<td>' + m.count + '</td><td class="dim">' + num(m.sum / m.count) + '</td><td class="dim">' + fmtDay(m.last) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  // Favorite theme section in profile: matches the Theme panel styling with swatches.
  function renderTheme() {
    var host = $('pf-theme');
    if (!host) return;
    var editable = state.isYou;
    var html = '<h2 class="card__title">Favorite theme</h2>';

    if (editable) {
      html += '<div class="segmented pf-fav-segmented" role="group" aria-label="Favorite theme">' +
        THEMES.map(function (t) {
          var isFav = state.favorite === t.id;
          return '<button type="button" data-fav-theme="' + t.id + '" aria-pressed="' + isFav + '">' +
            '<span class="swatch" data-swatch="' + t.id + '"><i aria-hidden="true"></i>' + esc(t.name) + '</span></button>';
        }).join('') + '</div>' +
        '<div class="pf-theme-actions">' +
          (state.favorite ? '<button type="button" class="btn btn--small" id="pf-theme-clear">Clear favorite</button>' : '') +
        '</div>' +
        '<p class="pf-theme-status" id="pf-theme-status" role="status">' + esc(state.themeNote) + '</p>';
    } else {
      html += state.favorite
        ? '<p class="pf-fav-mode"><b>' + esc(themeName(state.favorite)) + '</b><span>their favorite</span></p>' +
          '<div class="segmented pf-fav-segmented" role="group">' +
            THEMES.map(function (t) {
              var isFav = state.favorite === t.id;
              return '<button type="button" disabled aria-pressed="' + isFav + '">' +
                '<span class="swatch" data-swatch="' + t.id + '"><i aria-hidden="true"></i>' + esc(t.name) + '</span></button>';
            }).join('') + '</div>'
        : '<p class="pf-empty">No favorite theme picked.</p>';
      html += '<p class="pf-sub">Only ' + esc(state.username) + ' can change their favorite.</p>';
    }

    host.innerHTML = html;
    syncSkinPanel();
  }

  function heatLevel(count) {
    return count === 0 ? 0 : count === 1 ? 1 : count <= 3 ? 2 : count <= 6 ? 3 : 4;
  }

  function renderHeat() {
    var counts = {};
    state.games.forEach(function (g) {
      if (!isCompleted(g)) return;
      var k = dayKey(g.created_at);
      counts[k] = (counts[k] || 0) + 1;
    });

    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var day = new Date(today);
    day.setDate(day.getDate() - today.getDay() - (HEAT_WEEKS - 1) * 7);

    var cells = '';
    var labels = '';
    var total = 0;
    var active = 0;
    var column = 0;
    var lastMonth = -1;
    while (day <= today) {
      if (day.getDay() === 0) {
        column += 1;
        if (day.getMonth() !== lastMonth) {
          labels += '<span style="grid-column:' + column + '">' + MONTHS[day.getMonth()] + '</span>';
          lastMonth = day.getMonth();
        }
      }
      var key = dayKey(day);
      var count = counts[key] || 0;
      total += count;
      if (count) active += 1;
      cells += '<i class="hm lv' + heatLevel(count) + '" data-count="' + count + '" data-date="' + key + '" title="' +
        (count ? plural(count, 'game', 'games') : 'No games') + ' on ' + WEEKDAYS[day.getDay()] + ' ' + fmtDay(day) + '"></i>';
      day.setDate(day.getDate() + 1);
    }

    $('pf-heat-card').innerHTML =
      '<div class="pf-card__head"><h2 class="card__title">Activity</h2>' +
      '<span class="pf-count" id="pf-heat-summary">' + plural(total, 'game', 'games') + ' in the last year \u00b7 ' +
      plural(active, 'active day', 'active days') + '</span></div>' +
      '<div class="hm-scroll"><div class="hm-inner">' +
        '<div class="hm-months" style="--cols:' + column + '">' + labels + '</div>' +
        '<div class="hm-body"><div class="hm-days" aria-hidden="true"><span></span><span>Mon</span><span></span><span>Wed</span><span></span><span>Fri</span><span></span></div>' +
        '<div class="hm-grid" id="pf-heat" role="img" aria-label="Games played per day over the last year">' + cells + '</div></div>' +
      '</div></div>' +
      '<div class="hm-legend" aria-hidden="true"><span>Less</span><i class="hm lv0"></i><i class="hm lv1"></i><i class="hm lv2"></i><i class="hm lv3"></i><i class="hm lv4"></i><span>More</span></div>';
  }

  function niceStep(raw) {
    var p = Math.pow(10, Math.floor(Math.log(raw || 1) / Math.LN10));
    var f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  }
  function mean(list) {
    if (!list.length) return 0;
    return list.reduce(function (sum, v) { return sum + v; }, 0) / list.length;
  }

  // Progress chart: each completed game as a dot, a rolling average, and the
  // best so far. Hovering a point shows which games feed the line there.
  function chartData() {
    return state.games.filter(function (g) {
      return isCompleted(g) && (state.chartMode === 'all' || modeKey(g) === state.chartMode);
    }).sort(function (a, b) { return asDate(a.created_at) - asDate(b.created_at) || a.id - b.id; });
  }

  function renderChart() {
    var host = $('pf-chart');
    var trendEl = $('pf-trend');
    if (!host) return;
    var list = chartData();
    var n = list.length;

    var prevSvg = host.querySelector('svg');
    if (prevSvg) { prevSvg.onmousemove = null; prevSvg.onmouseleave = null; }
    var prevTip = host.querySelector('.pf-chart-tip');
    if (prevTip) prevTip.remove();

    if (n < 2) {
      host.innerHTML = '<p class="pf-empty">' + (n === 0
        ? 'No completed games in this mode yet.'
        : 'Play at least two completed games in this mode to chart your progress.') + '</p>';
      if (trendEl) trendEl.textContent = '';
      return;
    }

    var W = 760, H = 270, L = 42, R = 16, T = 16, B = 34;
    var scores = list.map(function (g) { return g.score; });
    var max = Math.max(4, Math.max.apply(null, scores));
    var step = niceStep(max / 4);
    var top = Math.ceil(max / step) * step;
    function X(i) { return L + (i * (W - L - R)) / (n - 1); }
    function Y(v) { return T + (H - T - B) * (1 - v / top); }
    function f(v) { return v.toFixed(1); }

    var grid = '';
    for (var v = 0; v <= top + 1e-9; v += step) {
      grid += '<line class="gl" x1="' + L + '" x2="' + (W - R) + '" y1="' + f(Y(v)) + '" y2="' + f(Y(v)) + '"/>' +
        '<text class="gt" x="' + (L - 8) + '" y="' + f(Y(v) + 4) + '" text-anchor="end">' + v + '</text>';
    }

    var avg = [];
    for (var i = 0; i < n; i++) {
      var from = Math.max(0, i - AVG_WINDOW + 1);
      avg.push([X(i), Y(mean(scores.slice(from, i + 1)))]);
    }
    var avgLine = avg.map(function (p) { return f(p[0]) + ',' + f(p[1]); }).join(' ');
    var area = 'M' + f(X(0)) + ' ' + f(Y(0)) + ' ' + avg.map(function (p) { return 'L' + f(p[0]) + ' ' + f(p[1]); }).join(' ') +
      ' L' + f(X(n - 1)) + ' ' + f(Y(0)) + ' Z';

    var best = scores[0];
    var bestPath = 'M' + f(X(0)) + ' ' + f(Y(best));
    for (var j = 1; j < n; j++) {
      if (scores[j] > best) { best = scores[j]; bestPath += ' H' + f(X(j)) + ' V' + f(Y(best)); }
    }
    bestPath += ' H' + f(X(n - 1));

    var dots = list.map(function (g, k) {
      return '<circle class="pt" data-idx="' + k + '" cx="' + f(X(k)) + '" cy="' + f(Y(g.score)) + '" r="3.2">' +
        '<title>Game ' + (k + 1) + ': ' + g.score + ' points \u00b7 ' + fmtDay(g.created_at) + ' \u00b7 ' + esc(modeLabel(g)) + '</title></circle>';
    }).join('');

    var marks = [0, Math.floor((n - 1) / 2), n - 1].filter(function (m, k, a) { return a.indexOf(m) === k; });
    var xlabels = marks.map(function (m) {
      var anchor = m === 0 ? 'start' : m === n - 1 ? 'end' : 'middle';
      return '<text class="gt" x="' + f(X(m)) + '" y="' + (H - 10) + '" text-anchor="' + anchor + '">' + fmtShort(list[m].created_at) + '</text>';
    }).join('');

    host.innerHTML =
      '<div class="pf-chart-wrap">' +
      '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Your score for each completed game over time, with a rolling average and your best so far">' +
        grid +
        '<path class="avg-area" d="' + area + '"/>' +
        '<path class="best-line" d="' + bestPath + '"/>' +
        '<polyline class="avg-line" points="' + avgLine + '"/>' +
        dots +
        '<line class="chart-hover-line" x1="0" x2="0" y1="' + T + '" y2="' + (H - B) + '" visibility="hidden"/>' +
        '<circle class="chart-hover-dot" r="5" visibility="hidden"/>' +
        '<rect class="chart-capture" x="' + L + '" y="' + T + '" width="' + (W - L - R) + '" height="' + (H - T - B) + '" fill="transparent"/>' +
        xlabels +
      '</svg>' +
      '<div class="pf-chart-tip" hidden></div>' +
      '</div>';

    var svg = host.querySelector('svg');
    var hoverLine = host.querySelector('.chart-hover-line');
    var hoverDot = host.querySelector('.chart-hover-dot');
    var tip = host.querySelector('.pf-chart-tip');
    svg.onmousemove = function (e) {
      var rect = svg.getBoundingClientRect();
      var scaleX = W / rect.width;
      var mx = (e.clientX - rect.left) * scaleX;
      var i = Math.round((mx - L) / ((W - L - R) / (n - 1)));
      i = Math.max(0, Math.min(n - 1, i));
      var x = X(i), y = Y(scores[i]);
      hoverLine.setAttribute('x1', x); hoverLine.setAttribute('x2', x);
      hoverLine.setAttribute('visibility', 'visible');
      hoverDot.setAttribute('cx', x); hoverDot.setAttribute('cy', y);
      hoverDot.setAttribute('visibility', 'visible');

      var from = Math.max(0, i - AVG_WINDOW + 1);
      var windowGames = list.slice(from, i + 1);
      var avgVal = mean(windowGames.map(function (g) { return g.score; }));
      var rows = windowGames.map(function (g, k) {
        var idx = from + k;
        return '<li class="pf-chart-tip__row' + (idx === i ? ' is-current' : '') + '"><span>Game ' + (idx + 1) +
          '</span><b>' + g.score + ' pts</b><span>' + esc(modeLabel(g)) + '</span></li>';
      }).join('');
      tip.innerHTML =
        '<div class="pf-chart-tip__head">Game ' + (i + 1) + ' \u00b7 <b>' + scores[i] + ' pts</b></div>' +
        '<div class="pf-chart-tip__meta">' + fmtDay(list[i].created_at) + ' \u00b7 ' + esc(modeLabel(list[i])) + '</div>' +
        '<div class="pf-chart-tip__avg">' + AVG_WINDOW + '-game average: <b>' + num(avgVal) + '</b> (games ' + (from + 1) + '\u2013' + (i + 1) + ')</div>' +
        '<ol class="pf-chart-tip__list">' + rows + '</ol>';
      tip.hidden = false;
      var hostRect = host.getBoundingClientRect();
      var px = e.clientX - hostRect.left + 14;
      var py = e.clientY - hostRect.top - 10;
      var tw = tip.offsetWidth || 200;
      if (px + tw > hostRect.width) px = e.clientX - hostRect.left - tw - 14;
      if (px < 0) px = 4;
      if (py < 0) py = 4;
      tip.style.left = px + 'px';
      tip.style.top = py + 'px';
    };
    svg.onmouseleave = function () {
      hoverLine.setAttribute('visibility', 'hidden');
      hoverDot.setAttribute('visibility', 'hidden');
      if (tip) tip.hidden = true;
    };

    if (n >= 4) {
      var k = Math.min(10, Math.floor(n / 2));
      var recent = mean(scores.slice(-k));
      var prior = mean(scores.slice(-2 * k, -k));
      var diff = recent - prior;
      trendEl.textContent = 'Your last ' + k + ' games average ' + num(recent) + ' \u2014 ' +
        (diff > 0.05 ? 'up ' + num(diff) : diff < -0.05 ? 'down ' + num(-diff) : 'level') + ' from the ' + k + ' before.';
    } else {
      trendEl.textContent = 'Keep playing \u2014 trends appear after a few more completed games.';
    }
  }

  function logItem(g) {
    var es = g.end_state;
    var length = es && es.snake ? es.snake.length : null;
    var cause = es ? (es.cause === 'crash' ? 'Crashed' : 'Quit') : '';
    var meta = fmtDay(g.created_at) + ' \u00b7 ' + fmtTime(g.created_at) + (cause ? ' \u00b7 ' + cause : '') +
      (length ? ' \u00b7 length ' + length : '');
    var asking = state.confirmId === g.id;
    var actions;
    if (!state.isYou) {
      actions = '<span class="pf-sub">public profile \u2014 view only</span>';
    } else if (asking) {
      actions = '<span class="log__ask">Remove this game?</span>' +
        '<button type="button" class="btn btn--small btn--danger" data-remove-yes="' + g.id + '">Yes, remove</button>' +
        '<button type="button" class="btn btn--small" data-remove-no>Cancel</button>';
    } else {
      actions = '<button type="button" class="btn btn--small" data-remove="' + g.id + '" aria-label="Remove the ' + g.score +
        '-point game from ' + esc(fmtDay(g.created_at)) + '">Remove</button>';
    }
    var hasBoard = es && es.snake && es.snake.length;
    var board = hasBoard
      ? '<button type="button" class="log__board log__board--btn" data-enlarge="' + g.id + '" title="Enlarge ending position" aria-label="Enlarge the ending position of the ' + g.score + '-point game">' + boardSvg(es) + '</button>'
      : '<div class="log__board">' + boardSvg(es) + '</div>';
    return '<li class="log__item' + (isQuit(g) ? ' is-quit' : '') + '" data-id="' + g.id + '">' +
      board +
      '<div class="log__main"><span class="log__score">' + g.score + '</span>' +
      '<span class="log__mode">' + esc(modeLabel(g)) + '</span><span class="log__meta">' + esc(meta) + '</span></div>' +
      '<div class="log__actions">' + actions + '</div></li>';
  }

  // Only completed games, and quit games with a score of 10 or higher, are shown.
  function logList() {
    return state.games.filter(function (g) {
      if (!logVisible(g)) return false;
      return state.logMode === 'all' || modeKey(g) === state.logMode;
    });
  }

  function isQuitsHidden() {
    return state.games.some(function (g) { return !logVisible(g); });
  }

  function renderLog() {
    var list = logList();
    var shown = list.slice(0, state.logShown);
    $('pf-log-count').textContent = plural(list.length, 'game', 'games') + (isQuitsHidden() ? ' (some quits hidden)' : '');
    $('pf-log').innerHTML = shown.length
      ? shown.map(logItem).join('')
      : '<li class="log__empty">' + (state.games.length
        ? 'No games in this mode.'
        : 'No games logged yet \u2014 play a run and it lands here.') + '</li>';
    var more = $('pf-log-more');
    var left = list.length - shown.length;
    more.hidden = left <= 0;
    more.textContent = 'Show more (' + left + ' left)';
  }

  function fillSelects() {
    var list = modeTable(state.games);
    var completedTotal = state.games.filter(isCompleted).length;
    [['pf-chart-mode', 'chartMode'], ['pf-log-mode', 'logMode']].forEach(function (pair) {
      var select = $(pair[0]);
      var current = state[pair[1]];
      if (current !== 'all' && !list.some(function (m) { return m.key === current; })) {
        current = state[pair[1]] = 'all';
      }
      select.innerHTML = '<option value="all">All modes (' + completedTotal + ')</option>' + list.map(function (m) {
        return '<option value="' + esc(m.key) + '">' + esc(m.label) + ' (' + m.count + ')</option>';
      }).join('');
      select.value = current;
    });
  }

  function renderAll() {
    renderHero();
    renderTiles();
    renderModes();
    renderBests();
    renderTheme();
    renderHeat();
    fillSelects();
    renderChart();
    renderLog();
  }

  // ---- actions ------------------------------------------------------------------
  function deleteGame(id) {
    if (!state.isYou) return;
    api('/api/games/' + id, { method: 'DELETE' }).then(readJson).then(function (out) {
      if (out.status === 401) { state.isYou = false; loadProfile(); return; }
      if (!out.ok && out.status !== 404) { toast(out.json.error || 'Could not remove the game.', true); return; }
      state.games = state.games.filter(function (g) { return g.id !== id; });
      state.confirmId = null;
      renderAll();
      toast('Game removed from your log and from the leaderboard.');
    }).catch(function () { toast('Could not reach the server.', true); });
  }

  function saveFavorite(id) {
    if (!state.isYou) return;
    api('/api/profile', { method: 'PATCH', body: JSON.stringify({ favorite_theme: id }) }).then(readJson).then(function (out) {
      if (out.status === 401) { state.isYou = false; loadProfile(); return; }
      if (!out.ok) { toast(out.json.error || 'Could not save your favorite theme.', true); return; }
      state.favorite = out.json.user.favorite_theme || null;
      state.themeNote = id ? 'Favorite theme saved: ' + themeName(id) + '.' : 'Favorite theme cleared.';
      buildShell();
      renderAll();
    }).catch(function () { toast('Could not reach the server.', true); });
  }

  function readSettings() {
    try { return JSON.parse(window.localStorage.getItem(STORE_KEY) || '{}') || {}; }
    catch (err) { return {}; }
  }

  function currentTheme() {
    var fromDom = document.documentElement.getAttribute('data-theme');
    if (THEMES.some(function (t) { return t.id === fromDom; })) return fromDom;
    var saved = readSettings().theme;
    return THEMES.some(function (t) { return t.id === saved; }) ? saved : 'classic';
  }

  // Cabinet skin controls the global theme (the same localStorage key the game
  // page reads), not a profile-only view.
  function applyGlobalTheme(id) {
    if (!THEMES.some(function (t) { return t.id === id; })) return;
    document.documentElement.setAttribute('data-theme', id);
    var settings = readSettings();
    settings.theme = id;
    try { window.localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch (err) { /* storage blocked */ }
    syncSkinPanel();
    syncRain();
  }

  // Terminal theme's Matrix rain (public/rain.js) — the profile has no run to
  // yield to, so it simply follows the theme.
  function syncRain() {
    if (window.MatrixRain) window.MatrixRain.set(currentTheme() === 'terminal');
  }

  function syncSkinPanel() {
    var id = currentTheme();
    var group = document.getElementById('pf-skin-theme');
    if (group) {
      var buttons = group.querySelectorAll('[data-theme]');
      for (var i = 0; i < buttons.length; i++) {
        buttons[i].setAttribute('aria-pressed', String(buttons[i].getAttribute('data-theme') === id));
      }
    }
    var label = document.getElementById('pf-skin-value');
    if (label) label.textContent = themeName(id);
  }

  function bindSkinPanel() {
    var group = document.getElementById('pf-skin-theme');
    if (!group || group.__nlsBound) return;
    group.__nlsBound = true;
    group.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-theme]') : null;
      if (!btn) return;
      applyGlobalTheme(btn.getAttribute('data-theme'));
    });
    syncSkinPanel();
  }

  // "Play in this theme": makes the favorite the global cabinet skin.
  function applyFavorite() {
    var id = state.favorite;
    if (!id) return;
    applyGlobalTheme(id);
    state.themeNote = 'The game will open in ' + themeName(id) + '.';
    renderTheme();
  }

  function openBoard(game) {
    var dlg = document.getElementById('board-lightbox');
    var frame = document.getElementById('board-lightbox-frame');
    var cap = document.getElementById('board-lightbox-cap');
    if (!dlg || !frame || !game || !game.end_state) return;
    frame.innerHTML = boardSvg(game.end_state);
    if (cap) {
      var length = game.end_state.snake ? game.end_state.snake.length : 0;
      cap.textContent = game.score + ' points · ' + modeLabel(game) + ' · length ' + length +
        (game.end_state.cause === 'crash' ? ' · crashed' : ' · quit');
    }
    if (typeof dlg.showModal === 'function') {
      if (!dlg.open) dlg.showModal();
    } else {
      dlg.setAttribute('open', '');
    }
  }

  function closeBoard() {
    var dlg = document.getElementById('board-lightbox');
    if (!dlg) return;
    if (typeof dlg.close === 'function' && dlg.open) dlg.close();
    else dlg.removeAttribute('open');
  }

  function toast(message, isError) {
    var el = $('pf-toast');
    if (!el) return;
    el.textContent = message;
    el.className = 'pf-toast is-visible' + (isError ? ' is-error' : '');
    window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(function () { el.className = 'pf-toast'; }, 3600);
  }

  // The cabinet skin panel only appears next to a loaded profile. On the
  // sign-in gate, the error screen and while loading, it stays hidden.
  function setSkinVisible(on) {
    var side = document.querySelector('.pf-side');
    var layout = document.querySelector('.pf-layout');
    if (side) side.hidden = !on;
    if (layout) layout.classList.toggle('is-gated', !on);
  }

  function showGate() {
    setSkinVisible(false);
    state.username = null;
    state.isYou = true;
    root.innerHTML =
      '<section class="card pf-gate">' +
        '<p class="pf-eyebrow">Player profile</p>' +
        '<h1 class="pf-gate__title">Sign in to see your profile</h1>' +
        '<p class="pf-note">Your profile is your game log: level, rank, high scores, progress charts, an ' +
        'activity heatmap and where the snake ended up in every run. Guest runs are not saved, so sign in ' +
        '(or make an account \u2014 no email needed) and play.</p>' +
        '<div class="pf-gate__actions">' +
          '<button class="btn btn--primary" id="gate-signin" type="button">Sign in</button>' +
          '<button class="btn" id="gate-create" type="button">Create account</button>' +
          '<a class="btn" href="/">Play a game</a>' +
        '</div>' +
      '</section>';
  }

  function showError(message) {
    setSkinVisible(false);
    root.innerHTML =
      '<section class="card pf-gate"><h1 class="pf-gate__title">Something went wrong</h1>' +
      '<p class="pf-note">' + esc(message) + '</p>' +
      '<div class="pf-gate__actions"><button class="btn" id="pf-retry" type="button">Try again</button></div></section>';
  }

  // ---- events ---------------------------------------------------------------------
  root.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var el = t.closest('[data-fav-theme]');
    if (el) return saveFavorite(el.getAttribute('data-fav-theme'));
    if (t.closest('#pf-theme-clear')) return saveFavorite(null);
    if (t.closest('#pf-theme-apply')) return applyFavorite();
    el = t.closest('[data-enlarge]');
    if (el) {
      var enlarged = state.games.filter(function (g) { return String(g.id) === el.getAttribute('data-enlarge'); })[0];
      if (enlarged) openBoard(enlarged);
      return;
    }
    el = t.closest('[data-remove-yes]');
    if (el) return deleteGame(Number(el.getAttribute('data-remove-yes')));
    if (t.closest('[data-remove-no]')) { state.confirmId = null; return renderLog(); }
    el = t.closest('[data-remove]');
    if (el) { state.confirmId = Number(el.getAttribute('data-remove')); return renderLog(); }
    if (t.closest('#pf-log-more')) { state.logShown += LOG_PAGE; return renderLog(); }
    if (t.closest('#pf-retry')) { loadProfile(); return; }
    if (t.closest('#gate-signin')) return openAuthDialog('login');
    if (t.closest('#gate-create')) return openAuthDialog('create');
  });

  root.addEventListener('change', function (e) {
    var id = e.target && e.target.id;
    if (id === 'pf-chart-mode') { state.chartMode = e.target.value; renderChart(); }
    if (id === 'pf-log-mode') { state.logMode = e.target.value; state.logShown = LOG_PAGE; state.confirmId = null; renderLog(); }
  });

  // ---- accounts ---------------------------------------------------------------------
  var authDialog = $('auth-dialog');
  var authOut = $('auth-out');
  var authIn = $('auth-in');
  var authUserChip = $('auth-user');
  var formLogin = $('form-login');
  var formCreate = $('form-create');
  var tabLogin = $('auth-tab-login');
  var tabCreate = $('auth-tab-create');

  function renderAuth() {
    if (authOut) authOut.hidden = !!authUser;
    if (authIn) authIn.hidden = !authUser;
    if (authUserChip) {
      authUserChip.innerHTML = authUser
        ? '<i class="chip__dot" aria-hidden="true"></i>Player \u2014 <b>' + esc(authUser) + '</b>'
        : '';
      authUserChip.classList.toggle('is-signed-in', !!authUser);
    }
  }

  // Put the cursor in the username box of whichever form is showing (deferred so
  // it runs after showModal, which would otherwise focus the close button).
  function focusAuthField(mode) {
    var form = mode === 'create' ? formCreate : formLogin;
    var input = form && form.elements ? form.elements.username : null;
    if (!input) return;
    window.setTimeout(function () { input.focus(); }, 0);
  }

  function setAuthMode(mode) {
    var login = mode !== 'create';
    if (formLogin) formLogin.hidden = !login;
    if (formCreate) formCreate.hidden = login;
    if (tabLogin) tabLogin.setAttribute('aria-selected', String(login));
    if (tabCreate) tabCreate.setAttribute('aria-selected', String(!login));
    focusAuthField(mode);
  }

  // "i" buttons open the XP explanation on tap (touch) or hover (mouse). A tap on
  // the explanation itself is ignored; a tap anywhere else closes it.
  function bindXpInfo() {
    if (document.__nlsXpInfoBound) return;
    document.__nlsXpInfoBound = true;
    document.addEventListener('click', function (e) {
      var target = e.target;
      if (target && target.closest && target.closest('.xp-popover')) return;
      var btn = target && target.closest ? target.closest('.xp-info-btn') : null;
      var open = document.querySelectorAll('.xp-info-btn.is-open');
      for (var i = 0; i < open.length; i++) {
        if (open[i] !== btn) { open[i].classList.remove('is-open'); open[i].setAttribute('aria-expanded', 'false'); }
      }
      if (btn) {
        var on = !btn.classList.contains('is-open');
        btn.classList.toggle('is-open', on);
        btn.setAttribute('aria-expanded', String(on));
      }
    });
  }

  function openAuthDialog(mode) {
    if (!authDialog) return;
    setAuthMode(mode);
    if (authDialog.showModal && !authDialog.open) authDialog.showModal();
  }

  function postAuth(url, form, errorId) {
    var errEl = $(errorId);
    var body = {
      username: form.elements.username ? form.elements.username.value : '',
      password: form.elements.password ? form.elements.password.value : ''
    };
    if (errEl) errEl.textContent = '';
    return api(url, { method: 'POST', body: JSON.stringify(body) }).then(readJson).then(function (out) {
      if (!out.ok) { if (errEl) errEl.textContent = out.json.error || 'Something went wrong'; return; }
      authUser = out.json.user && out.json.user.username;
      setToken(out.json.token || null);
      renderAuth();
      if (authDialog && authDialog.open) authDialog.close();
      // Viewing your own profile? Reload it now that you're signed in.
      if (!root.getAttribute('data-username')) loadProfile();
    }).catch(function () { if (errEl) errEl.textContent = 'Network error \u2014 try again'; });
  }

  // ---- go ---------------------------------------------------------------------
  // Idempotent boot. The preview renders #profile-root on the server and React
  // hydrates over it, so the profile must be (re)drawn AFTER hydration — and
  // again on a client-side navigation between /profile and /profile/NAME.
  // Rails just runs it once on load. Called by window.SnakeProfile.boot().
  var bootToken = 0;
  function boot() {
    var token = ++bootToken;

    // Re-read the root: React may have replaced the element during hydration.
    root = document.getElementById('profile-root');
    if (!root) return;

    // Re-bind the header auth controls (they live outside #profile-root and are
    // also re-rendered by React). The cabinet skin panel uses the same global
    // theme as the game page.
    bindHeaderAuth();
    bindSkinPanel();
    bindXpInfo();
    setSkinVisible(false);
    syncRain();

    var isOther = Boolean(root.getAttribute('data-username'));
    root.innerHTML = '<p class="pf-loading">Loading ' + (isOther ? 'the profile' : 'your profile') + '\u2026</p>';

    if (isOther) {
      // Public profile of another player — no sign-in needed.
      loadProfile();
    } else {
      // Your own profile — requires sign-in.
      api('/api/auth/me').then(readJson).then(function (out) {
        if (token !== bootToken) return; // a newer boot superseded this one
        authUser = out.ok && out.json.user ? out.json.user.username : null;
        if (!authUser) setToken(null);
        renderAuth();
        if (authUser) loadProfile(); else showGate();
      }).catch(function () {
        if (token !== bootToken) return;
        renderAuth();
        showError('Could not reach the server.');
      });
    }
  }

  // The header auth buttons are outside #profile-root, so they are re-bound on
  // every boot rather than relying on a single delegated listener.
  function bindHeaderAuth() {
    var dialog = document.getElementById('auth-dialog');
    var login = document.getElementById('form-login');
    var create = document.getElementById('form-create');
    var tabL = document.getElementById('auth-tab-login');
    var tabC = document.getElementById('auth-tab-create');
    authDialog = dialog;
    formLogin = login;
    formCreate = create;
    tabLogin = tabL;
    tabCreate = tabC;
    authOut = document.getElementById('auth-out');
    authIn = document.getElementById('auth-in');
    authUserChip = document.getElementById('auth-user');

    function once(node, type, fn) {
      if (!node || node.__nlsBound) return;
      node.__nlsBound = true;
      node.addEventListener(type, fn);
    }
    once(document.getElementById('board-lightbox-close'), 'click', function () { closeBoard(); });
    once(document.getElementById('board-lightbox'), 'click', function (e) {
      if (e.target && e.target.id === 'board-lightbox') closeBoard();
    });
    once(document.getElementById('btn-open-login'), 'click', function () { openAuthDialog('login'); });
    once(document.getElementById('btn-open-create'), 'click', function () { openAuthDialog('create'); });
    once(document.getElementById('auth-close'), 'click', function () { if (dialog && dialog.open) dialog.close(); });
    once(document.getElementById('btn-logout'), 'click', function () {
      api('/api/auth/logout', { method: 'POST', body: '{}' }).catch(function () { /* ignore */ }).then(function () {
        authUser = null;
        setToken(null);
        renderAuth();
        if (!root.getAttribute('data-username')) loadProfile();
      });
    });
    once(tabL, 'click', function () { setAuthMode('login'); });
    once(tabC, 'click', function () { setAuthMode('create'); });
    once(dialog, 'click', function (e) { if (e.target === dialog) dialog.close(); });
    if (login && !login.__nlsBound) {
      login.__nlsBound = true;
      login.addEventListener('submit', function (e) { e.preventDefault(); postAuth('/api/auth/login', login, 'auth-error-login'); });
    }
    if (create && !create.__nlsBound) {
      create.__nlsBound = true;
      create.addEventListener('submit', function (e) {
        e.preventDefault();
        var pw = create.elements.password ? create.elements.password.value : '';
        var confirm = create.elements['confirm-password'] ? create.elements['confirm-password'].value : '';
        var errEl = document.getElementById('auth-error-create');
        if (pw !== confirm) { if (errEl) errEl.textContent = 'Passwords do not match'; return; }
        postAuth('/api/auth/signup', create, 'auth-error-create');
      });
    }
  }

  // Rails (no React): boot once the DOM is ready.
  window.SnakeProfile = { boot: boot, reload: loadProfile };
  function autoBoot() { if (document.getElementById('profile-root')) boot(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoBoot);
  else autoBoot();
})();
