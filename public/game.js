/*!
 * Snake — shared game core.
 * Served verbatim by the Rails app (rails/public/game.js) and by this preview
 * (public/game.js). Vanilla JS, no dependencies, no build step.
 *
 * window.SnakeGame.create(rootElement, options) -> game api
 */
(function (global) {
  'use strict';

  var LEVELS = [
    { id: 1, label: 'Chill', ms: 165 },
    { id: 2, label: 'Easy', ms: 130 },
    { id: 3, label: 'Normal', ms: 105 },
    { id: 4, label: 'Fast', ms: 80 },
    { id: 5, label: 'Insane', ms: 60 },
    { id: 6, label: 'Ludicrous', ms: 42 }
  ];

  function clampInt(value, min, max, fallback) {
    var n = parseInt(value, 10);
    if (isNaN(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function el(tag, cls) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  }

  function create(root, opts) {
    opts = opts || {};
    if (!root) throw new Error('SnakeGame.create: a root element is required');

    var cols = opts.cols || 24;
    var rows = opts.rows || 18;
    var speedId = clampInt(opts.speedId, 1, 6, 3);
    var speedCustom = clampInt(opts.customSpeed, 0, 100, 42);
    var useCustomSpeed = !!opts.useCustomSpeed;
    var growth = clampInt(opts.growth, 1, 5, 1);
    var growthCustom = clampInt(opts.customGrowth, 0, 100, 2);
    var useCustomGrowth = !!opts.useCustomGrowth;
    var startLength = opts.startLength || 3;

    // ---- DOM -------------------------------------------------------------
    root.innerHTML = '';
    root.classList.add('snake-root');

    var frame = el('div', 'snake-frame');
    var field = el('div', 'snake-field');
    var canvas = document.createElement('canvas');
    canvas.className = 'snake-canvas';
    canvas.setAttribute('tabindex', '0');
    canvas.setAttribute('role', 'application');
    canvas.setAttribute('aria-label', 'Snake playfield. Use WASD or the arrow keys, or swipe anywhere while playing.');
    field.appendChild(canvas);
    var terminalCursor = el('span', 'terminal-cursor');
    terminalCursor.textContent = '>';
    terminalCursor.setAttribute('aria-hidden', 'true');
    field.appendChild(terminalCursor);
    frame.appendChild(field);

    // Decorative arcade cabinet (only displayed by the Arcade theme). Purely
    // visual: it never affects layout of the field, and it takes no input.
    var cabinet = el('div', 'cabinet');
    cabinet.setAttribute('aria-hidden', 'true');
    cabinet.innerHTML =
      '<div class="cabinet__marquee">' +
        '<i class="cabinet__bulb"></i>' +
        '<span class="cabinet__marquee-text">Next Level Snake</span>' +
        '<i class="cabinet__bulb"></i>' +
      '</div>' +
      '<div class="cabinet__deck">' +
        '<span class="cabinet__stick"><i></i></span>' +
        '<span class="cabinet__buttons"><i></i><i></i><i></i><i></i></span>' +
        '<span class="cabinet__coin"></span>' +
      '</div>';
    frame.appendChild(cabinet);
    root.appendChild(frame);

    var ctx = canvas.getContext('2d');

    // ---- state -----------------------------------------------------------
    var listeners = {};
    var snake = [];
    var dir = { x: 1, y: 0 };
    var queue = [];
    var food = { x: -1, y: -1 };
    var score = 0;
    var grow = 0;
    var started = false;
    var running = false;
    var paused = false;
    var acc = 0;
    var last = 0;
    var rafId = 0;
    var wrapFlash = null;
    var crashCell = null; // the cell a crash ran into (null when the player quit)
    var cssW = 0;
    var cssH = 0;
    var cell = 20;
    var ox = 0;
    var oy = 0;
    var dpr = 1;

    // Visual theme — merged over these defaults by game.setTheme(). Mirrors the
    // CSS themes in styles.css; page.js keeps both in sync.
    var DEFAULT_THEME = {
      field: '#050505',
      snake: '#2CE05E',
      snakeGlow: 0.38,
      food: '#FF3B30',
      foodGlow: 0.55,
      blocks: false,
      blockGap: 0,
      roundFood: true,
      blink: false
    };
    var theme = {};
    for (var tk in DEFAULT_THEME) theme[tk] = DEFAULT_THEME[tk];

    // Pre-computed halo colours: a wide translucent second pass replaces
    // ctx.shadowBlur, which is by far the most expensive thing a canvas can do.
    var haloSnake = '';
    var haloFood = '';

    // Only repaint when something actually changed. An idle board costs nothing.
    var dirty = true;
    function markDirty() { dirty = true; }

    // Reused every frame so Classic's row-span pass allocates nothing.
    var spanScratch = [];

    function speedMs() { return useCustomSpeed ? speedCustom : LEVELS[speedId - 1].ms; }
    function speedLabel() { return useCustomSpeed ? 'Custom' : LEVELS[speedId - 1].label; }
    function growthEff() { return useCustomGrowth ? growthCustom : growth; }

    function emit(name, data) {
      var list = listeners[name] || [];
      for (var i = 0; i < list.length; i++) list[i](data);
    }

    function state() {
      return {
        score: score,
        length: snake.length,
        speedPreset: speedId,
        speedCustom: speedCustom,
        useCustomSpeed: useCustomSpeed,
        speedLabel: speedLabel(),
        speedMs: speedMs(),
        growthPreset: growth,
        growthCustom: growthCustom,
        useCustomGrowth: useCustomGrowth,
        growth: growthEff(),
        isCustom: useCustomSpeed || useCustomGrowth,
        started: started,
        running: running,
        paused: paused
      };
    }

    // ---- world -----------------------------------------------------------
    function occupied(x, y) {
      for (var i = 0; i < snake.length; i++) {
        if (snake[i].x === x && snake[i].y === y) return true;
      }
      return false;
    }

    function placeFood() {
      var x;
      var y;
      for (var a = 0; a < 300; a++) {
        x = Math.floor(Math.random() * cols);
        y = Math.floor(Math.random() * rows);
        if (!occupied(x, y)) { food.x = x; food.y = y; return; }
      }
      for (y = 0; y < rows; y++) {
        for (x = 0; x < cols; x++) {
          if (!occupied(x, y)) { food.x = x; food.y = y; return; }
        }
      }
      food.x = -1; food.y = -1;
    }

    function reset() {
      var cx = Math.floor(cols / 2);
      var cy = Math.floor(rows / 2);
      snake = [];
      for (var i = 0; i < startLength; i++) snake.push({ x: cx - i, y: cy });
      dir = { x: 1, y: 0 };
      queue = [];
      score = 0;
      grow = 0;
      acc = 0;
      wrapFlash = null;
      crashCell = null;
      placeFood();
    }

    // After a run ends, the next one cannot begin for one second. A key pressed
    // during that window is ignored, so a frantic keypress cannot skip the
    // game-over screen. Timestamps come from the same clock the loop uses.
    var RESTART_LOCKOUT_MS = 1000;
    var deadAt = -Infinity;
    function nowMs() { return (global.performance || Date).now(); }
    function lockoutRemaining() {
      return Math.max(0, RESTART_LOCKOUT_MS - (nowMs() - deadAt));
    }

    function start() {
      if (running) return false;
      if (lockoutRemaining() > 0) return false;
      reset();
      started = true;
      running = true;
      paused = false;
      touch = null;
      last = 0;
      root.classList.add('is-active');
      emit('start', state());
      emit('score', score);
      dirty = false;
      draw();
      return true;
    }

    // Where the run ended, for the profile's game log. Cells are y*cols+x
    // indexes (compact: the log loads every game at once). Built only when a
    // run ends, never per frame.
    function endState() {
      var cells = [];
      for (var i = 0; i < snake.length; i++) cells.push(snake[i].y * cols + snake[i].x);
      return {
        cols: cols,
        rows: rows,
        snake: cells,
        food: food.x >= 0 ? food.y * cols + food.x : null,
        crash: crashCell ? crashCell.y * cols + crashCell.x : null,
        cause: crashCell ? 'crash' : 'quit'
      };
    }

    function die() {
      running = false;
      paused = false;
      started = false;
      touch = null;
      deadAt = nowMs();
      root.classList.remove('is-active');
      var over = state();
      over.endState = endState();
      emit('gameover', over);
      dirty = false;
      draw();
    }

    function pushDir(d) {
      var lastDir = queue.length ? queue[queue.length - 1] : dir;
      if (d.x === lastDir.x && d.y === lastDir.y) return;
      if (snake.length > 1 && d.x === -lastDir.x && d.y === -lastDir.y) return;
      if (queue.length < 2) queue.push(d);
    }

    function step() {
      if (queue.length) {
        var next = queue.shift();
        if (snake.length < 2 || !(next.x === -dir.x && next.y === -dir.y)) dir = next;
      }
      var head = snake[0];
      var nx = (head.x + dir.x + cols) % cols;
      var ny = (head.y + dir.y + rows) % rows;

      var limit = grow > 0 ? snake.length : snake.length - 1;
      for (var i = 0; i < limit; i++) {
        if (snake[i].x === nx && snake[i].y === ny) { crashCell = { x: nx, y: ny }; die(); return; }
      }

      if (Math.abs(nx - head.x) > 1 || Math.abs(ny - head.y) > 1) {
        wrapFlash = { x: nx, y: ny, t: (global.performance || Date).now() };
        emit('wrap', { x: nx, y: ny });
      }

      snake.unshift({ x: nx, y: ny });

      if (nx === food.x && ny === food.y) {
        score += 1;
        grow += growthEff();
        placeFood();
        emit('score', score);
      }

      if (grow > 0) grow -= 1;
      else snake.pop();
    }

    // ---- render ----------------------------------------------------------
    function roundRectPath(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r);
      ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
    }

    function withAlpha(hex, alpha) {
      // hex like '#2CE05E' -> rgba() so glows track the theme colour.
      var h = (hex || '').replace('#', '');
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      if (h.length !== 6) return hex;
      var r = parseInt(h.slice(0, 2), 16);
      var g = parseInt(h.slice(2, 4), 16);
      var b = parseInt(h.slice(4, 6), 16);
      return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')';
    }

    function refreshHalo() {
      // Colours are derived once per theme change, never per frame.
      haloSnake = withAlpha(theme.snake, Math.min(0.5, theme.snakeGlow * 0.5));
      haloFood = withAlpha(theme.food, Math.min(0.55, theme.foodGlow * 0.55));
    }

    function draw() {
      if (!cssW || !cssH) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = theme.field;
      ctx.fillRect(0, 0, cssW, cssH);

      var now = (global.performance || Date).now();

      // food — a red box
      var foodVisible = !theme.blink || Math.floor(now / 420) % 2 === 0;
      if (food.x >= 0 && foodVisible) {
        var pad = Math.max(1, cell * 0.1);
        var fx0 = ox + food.x * cell + pad;
        var fy0 = oy + food.y * cell + pad;
        var fw = cell - pad * 2;
        if (theme.blocks || !theme.roundFood) {
          ctx.beginPath();
          ctx.rect(fx0, fy0, fw, fw);
        } else {
          roundRectPath(fx0, fy0, fw, fw, Math.max(1.5, cell * 0.14));
        }
        if (theme.foodGlow) {
          ctx.strokeStyle = haloFood;
          ctx.lineWidth = cell * 0.5;
          ctx.lineJoin = 'round';
          ctx.stroke();
        }
        ctx.fillStyle = theme.food;
        ctx.fill();
      }

      if (snake.length) {
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.beginPath();
        if (theme.blocks) {
          var gap = theme.blockGap ? Math.max(1, Math.round(cell * theme.blockGap)) : 0;
          if (gap === 0) {
            // Classic: merge adjacent cells into row spans. Shared edges land on
            // identical device pixels and the silhouette is filled ONCE, with no
            // stroke — so no seams or internal outlines are ever visible.
            spanScratch.length = 0;
            for (var q = 0; q < snake.length; q++) spanScratch.push(snake[q]);
            spanScratch.sort(function (a, b) { return a.y - b.y || a.x - b.x; });
            for (var b = 0; b < spanScratch.length;) {
              var first = spanScratch[b];
              var endX = first.x;
              b++;
              while (b < spanScratch.length && spanScratch[b].y === first.y && spanScratch[b].x === endX + 1) {
                endX = spanScratch[b].x;
                b++;
              }
              var left = Math.round((ox + first.x * cell) * dpr) / dpr;
              var right = Math.round((ox + (endX + 1) * cell) * dpr) / dpr;
              var top = Math.round((oy + first.y * cell) * dpr) / dpr;
              var bottom = Math.round((oy + (first.y + 1) * cell) * dpr) / dpr;
              ctx.rect(left, top, right - left, bottom - top);
            }
          } else {
            // Vintage intentionally retains distinct square tiles.
            for (var v = 0; v < snake.length; v++) {
              var seg = snake[v];
              ctx.rect(
                ox + seg.x * cell + gap / 2,
                oy + seg.y * cell + gap / 2,
                cell - gap,
                cell - gap
              );
            }
          }
          ctx.fillStyle = theme.snake;
          ctx.fill();
        } else {
          // One continuous body, no borders between blocks.
          var prev = null;
          for (var i = 0; i < snake.length; i++) {
            var s = snake[i];
            var px = ox + s.x * cell + cell / 2;
            var py = oy + s.y * cell + cell / 2;
            if (prev && Math.abs(s.x - prev.x) <= 1 && Math.abs(s.y - prev.y) <= 1) {
              ctx.lineTo(px, py);
            } else {
              ctx.moveTo(px, py);
            }
            prev = s;
          }
          if (theme.snakeGlow) {
            ctx.strokeStyle = haloSnake;
            ctx.lineWidth = cell * 1.45;
            ctx.stroke();
          }
          ctx.strokeStyle = theme.snake;
          ctx.lineWidth = cell;
          ctx.stroke();
        }
      }

      // phosphor flash where the body left the wall
      if (wrapFlash) {
        var age = ((global.performance || Date).now() - wrapFlash.t) / 260;
        if (age >= 1) {
          wrapFlash = null;
        } else {
          ctx.save();
          ctx.globalAlpha = (1 - age) * 0.75;
          ctx.fillStyle = theme.snake;
          var fx = ox + wrapFlash.x * cell;
          var fy = oy + wrapFlash.y * cell;
          ctx.fillRect(fx - cell * 0.35, fy - cell * 0.35, cell * 1.7, cell * 1.7);
          ctx.restore();
        }
      }
    }

    // ---- sizing ----------------------------------------------------------
    function resize() {
      var rect = field.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      dpr = Math.min(global.devicePixelRatio || 1, 2);
      cssW = rect.width;
      cssH = rect.height;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      cell = Math.min(cssW / cols, cssH / rows);
      ox = (cssW - cell * cols) / 2;
      oy = (cssH - cell * rows) / 2;
      dirty = false;
      draw();
    }

    // ---- loop ------------------------------------------------------------
    function frameLoop(t) {
      rafId = global.requestAnimationFrame(frameLoop);

      if (running && !paused) {
        var dt = last ? t - last : 0;
        last = t;
        if (dt > 400) dt = 400;
        var ms = speedMs();
        if (ms < 16) {
          // Custom speed in the sub-frame range: exactly one step per frame.
          acc = 0;
          if (dt > 0) { step(); markDirty(); }
        } else {
          acc += dt;
          var guard = 0;
          while (acc >= ms && guard < 6) {
            acc -= ms;
            guard++;
            step();
            markDirty();
            if (!running) break;
          }
        }
      } else {
        last = t;
      }

      // Redraw only when the board changed (or an animation is still running).
      if (dirty || wrapFlash || theme.blink) {
        draw();
        dirty = false;
      }
    }

    // ---- input -----------------------------------------------------------
    var KEYMAP = {
      arrowup: { x: 0, y: -1 }, w: { x: 0, y: -1 },
      arrowdown: { x: 0, y: 1 }, s: { x: 0, y: 1 },
      arrowleft: { x: -1, y: 0 }, a: { x: -1, y: 0 },
      arrowright: { x: 1, y: 0 }, d: { x: 1, y: 0 }
    };

    // The keyboard belongs to the game only while the cabinet is on screen —
    // scrolled down to the manual, arrows still scroll the page as usual.
    // Visibility is cached by an IntersectionObserver: measuring the cabinet on
    // every keypress would force layout and add milliseconds of input lag.
    var onScreen = true;
    var observer = null;

    function engaged() {
      if (running || started) return true;
      if (observer) return onScreen;
      var rect = root.getBoundingClientRect();
      var vh = global.innerHeight || document.documentElement.clientHeight;
      return rect.height > 0 && rect.bottom > 80 && rect.top < vh - 80;
    }

    function onKeyDown(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Keys belong to form fields (and open dialogs) first — the snake must
      // never eat "w" typed into a password box.
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (document.querySelector && document.querySelector('dialog[open]')) return;
      var key = (e.key || '').toLowerCase();
      var d = KEYMAP[key];
      if (d) {
        if (paused || !engaged()) return;
        e.preventDefault();
        if (!started) start();
        if (running) pushDir(d);
        return;
      }
      if (key === ' ' || key === 'enter') {
        // Preserve native keyboard activation for every button and link.
        if (t && t.closest && t.closest('button, a, [role="button"]')) return;
        if (!running && engaged()) { e.preventDefault(); start(); }
      }
    }

    var touch = null;

    function acceptsTouch() {
      return running && !paused && !document.querySelector('dialog[open]');
    }

    function onTouchStart(e) {
      touch = null;
      if (!acceptsTouch() || !e.touches || e.touches.length !== 1) return;
      var target = e.target;
      var control = target && target.closest ? target.closest('input, textarea, select, [contenteditable], dialog') : null;
      if (control && !control.disabled) return;
      var finger = e.touches[0];
      touch = { id: finger.identifier, x: finger.clientX, y: finger.clientY };
      // Do not cancel touchstart: taps must still generate clicks on buttons.
    }

    function onTouchMove(e) {
      if (!acceptsTouch()) { touch = null; return; }
      if (!touch || !e.touches || e.touches.length !== 1) return;
      var finger = e.touches[0];
      if (finger.identifier !== touch.id) return;
      // Swipes anywhere on the document steer the snake, never the page.
      // Only movement is cancelled; a stationary tap still activates controls.
      if (e.cancelable) e.preventDefault();
      var dx = finger.clientX - touch.x;
      var dy = finger.clientY - touch.y;
      if (Math.abs(dx) < 20 && Math.abs(dy) < 20) return;
      var d = Math.abs(dx) > Math.abs(dy)
        ? { x: dx > 0 ? 1 : -1, y: 0 }
        : { x: 0, y: dy > 0 ? 1 : -1 };
      pushDir(d);
      touch.x = finger.clientX;
      touch.y = finger.clientY;
    }

    function onTouchEnd() { touch = null; }

    function pause() {
      if (!running || paused) return;
      paused = true;
      touch = null;
      root.classList.remove('is-active');
      emit('pause', state());
    }

    function resume() {
      if (!running || !paused) return;
      paused = false;
      touch = null;
      last = 0;
      root.classList.add('is-active');
      emit('resume', state());
    }

    function onVisibility() {
      if (document.hidden) pause();
    }

    global.addEventListener('keydown', onKeyDown, { passive: false });
    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd, { passive: true });
    document.addEventListener('touchcancel', onTouchEnd, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);

    var ro = null;
    if (global.ResizeObserver) {
      ro = new global.ResizeObserver(resize);
      ro.observe(field);
    }
    if (global.IntersectionObserver) {
      observer = new global.IntersectionObserver(function (entries) {
        onScreen = entries.length ? entries[0].isIntersecting : true;
      }, { rootMargin: '-80px 0px -80px 0px' });
      observer.observe(root);
    }
    global.addEventListener('resize', resize);

    refreshHalo();
    resize();
    dirty = false;
    draw();
    rafId = global.requestAnimationFrame(frameLoop);

    // ---- api -------------------------------------------------------------
    return {
      levels: LEVELS,
      start: start,
      restart: start,
      lockoutRemaining: lockoutRemaining,
      pause: pause,
      resume: resume,
      togglePause: function () {
        if (paused) resume();
        else pause();
      },
      setSpeed: function (id) {
        if (started) return;
        speedId = clampInt(id, 1, 6, speedId);
        useCustomSpeed = false;
        acc = 0;
        emit('speed', speedId);
      },
      setCustomSpeed: function (ms) {
        if (started) return;
        speedCustom = clampInt(ms, 0, 100, speedCustom);
        useCustomSpeed = true;
        acc = 0;
        emit('speed', speedCustom);
      },
      setGrowth: function (n) {
        if (started) return;
        growth = clampInt(n, 1, 5, growth);
        useCustomGrowth = false;
        emit('growth', growth);
      },
      setCustomGrowth: function (n) {
        if (started) return;
        growthCustom = clampInt(n, 0, 100, growthCustom);
        useCustomGrowth = true;
        emit('growth', growthCustom);
      },
      quit: function () {
        if (started) { crashCell = null; die(); }
      },
      setTheme: function (t) {
        if (started || !t) return;
        for (var k in DEFAULT_THEME) {
          theme[k] = Object.prototype.hasOwnProperty.call(t, k) && t[k] !== undefined ? t[k] : DEFAULT_THEME[k];
        }
        refreshHalo();
        dirty = false;
        draw();
      },
      getTheme: function () {
        var copy = {};
        for (var k in theme) copy[k] = theme[k];
        return copy;
      },
      on: function (name, fn) {
        listeners[name] = listeners[name] || [];
        listeners[name].push(fn);
        return this;
      },
      state: state,
      destroy: function () {
        global.cancelAnimationFrame(rafId);
        global.removeEventListener('keydown', onKeyDown);
        document.removeEventListener('touchstart', onTouchStart);
        document.removeEventListener('touchmove', onTouchMove);
        document.removeEventListener('touchend', onTouchEnd);
        document.removeEventListener('touchcancel', onTouchEnd);
        document.removeEventListener('visibilitychange', onVisibility);
        global.removeEventListener('resize', resize);
        if (ro) ro.disconnect();
        if (observer) observer.disconnect();
        root.classList.remove('is-active');
        root.innerHTML = '';
      }
    };
  }

  global.SnakeGame = { create: create, levels: LEVELS };
})(window);
