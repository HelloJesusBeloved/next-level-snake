/*!
 * Next Level Snake — Terminal theme "Matrix rain" page background.
 * Shared by the game page (app.js) and the profile page (profile.js), on both
 * the Rails app and the preview. Vanilla JS, no dependencies.
 *
 *   window.MatrixRain.set(enable)  -> show/animate or hide the rain
 *
 * Time-based, independent of refresh rate: 8 rows/second, 20px glyphs on a
 * 22px grid. Always animates once enabled (see set()). Drawn in device pixels so it stays crisp on high-DPI phones —
 * a 1x canvas stretched by CSS turned into a faint blur on mobile, which is
 * why it used to look like the rain "wasn't there" on phones.
 */
(function (global) {
  'use strict';

  var COL = 22;
  var GLYPHS = '01ﾊﾐﾋｰｳｼﾅﾓﾆｻﾜﾂｵﾘｱﾎﾃﾏｹﾒｴｶｷﾑﾕﾗｾﾈｽ';

  var rain = {
    canvas: null, ctx: null, raf: 0, drops: [], w: 0, h: 0, dpr: 1,
    running: false, last: null, accumulator: 0, stepMs: 1000 / 8, bound: false
  };

  // Reuse the page's #matrix-rain canvas when it has one; otherwise create it.
  // Appended at the END of <body> so it never disturbs React's hydration of the
  // preview pages (set() is only ever called after hydration anyway).
  function ensureCanvas() {
    if (rain.canvas && rain.canvas.isConnected) return rain.canvas;
    var c = document.getElementById('matrix-rain');
    if (!c) {
      c = document.createElement('canvas');
      c.id = 'matrix-rain';
      c.className = 'matrix-rain';
      c.setAttribute('aria-hidden', 'true');
      document.body.appendChild(c);
    }
    rain.canvas = c;
    rain.ctx = c.getContext('2d');
    rain.drops = [];
    return c;
  }

  function size() {
    if (!rain.canvas) return;
    rain.w = global.innerWidth;
    rain.h = global.innerHeight;
    rain.dpr = Math.min(global.devicePixelRatio || 1, 2);
    rain.canvas.width = Math.round(rain.w * rain.dpr);
    rain.canvas.height = Math.round(rain.h * rain.dpr);
    if (rain.ctx) rain.ctx.setTransform(rain.dpr, 0, 0, rain.dpr, 0, 0);
    var cols = Math.ceil(rain.w / COL);
    if (rain.drops.length !== cols) {
      rain.drops = [];
      for (var i = 0; i < cols; i++) rain.drops.push(Math.floor(Math.random() * -50));
    }
    // Setting canvas.width/height wipes every pixel. Mobile browsers fire
    // resize whenever the URL bar shows or hides, so without an immediate
    // repaint the rain would blink out until the next animation step.
    prime();
  }

  // Paint enough rows that the canvas never shows up empty.
  function prime() {
    if (!rain.ctx) return;
    for (var i = 0; i < 40; i++) step();
  }

  function step() {
    var ctx = rain.ctx;
    if (!ctx) return;
    ctx.fillStyle = 'rgba(3, 7, 10, 0.13)';
    ctx.fillRect(0, 0, rain.w, rain.h);
    ctx.font = '20px "IBM Plex Mono", ui-monospace, monospace';
    ctx.fillStyle = 'rgba(49, 240, 132, 0.92)';
    for (var i = 0; i < rain.drops.length; i++) {
      var ch = GLYPHS.charAt(Math.floor(Math.random() * GLYPHS.length));
      ctx.fillText(ch, i * COL, rain.drops[i] * COL);
      if (rain.drops[i] * COL > rain.h && Math.random() > 0.975) rain.drops[i] = 0;
      rain.drops[i] += 1;
    }
  }

  function frame(t) {
    if (!rain.running) { rain.raf = 0; return; }
    rain.raf = global.requestAnimationFrame(frame);
    if (document.hidden) { rain.last = null; rain.accumulator = 0; return; }
    var dt = rain.last == null ? 0 : Math.min(t - rain.last, 250);
    rain.last = t;
    rain.accumulator += dt;
    if (rain.accumulator < rain.stepMs) return;
    rain.accumulator %= rain.stepMs;
    step();
  }

  function stop() {
    rain.running = false;
    if (rain.raf) global.cancelAnimationFrame(rain.raf);
    rain.raf = 0;
    rain.last = null;
    rain.accumulator = 0;
  }

  function set(enable) {
    var c = ensureCanvas();
    if (!c || !rain.ctx) return;
    if (!enable) {
      stop();
      c.style.display = 'none';
      return;
    }
    c.style.display = 'block';
    if (!rain.bound) {
      rain.bound = true;
      global.addEventListener('resize', size);
      global.addEventListener('orientationchange', size);
    }
    size();
    // The rain always animates. It is a background the player opted into by
    // choosing the Terminal theme, so the OS "reduce motion" setting does not
    // switch it off — that used to leave a frozen frame that then vanished on
    // the next resize, which read as "the rain disappeared" on phones.
    if (!rain.running) {
      rain.running = true;
      rain.last = null;
      rain.accumulator = 0;
      rain.raf = global.requestAnimationFrame(frame);
    }
  }

  global.MatrixRain = { set: set };
})(window);
