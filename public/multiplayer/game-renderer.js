// Canvas-only multiplayer renderer (step 8). It never moves a snake or decides
// a collision, score or winner; it draws only versioned server snapshots from
// Simulation::Protocol v1, which the leased simulator owns.
const HEX = /^#[0-9a-f]{6}$/i;

export class MultiplayerGameRenderer {
  constructor({ canvas, scoreboard, status, ownParticipantId }) {
    this.canvas = canvas;
    this.scoreboard = scoreboard;
    this.status = status;
    this.ownParticipantId = ownParticipantId ?? null;
    this.snapshot = null;
    // Death dust: spawned LOCALLY from the authoritative body cells of a newly
    // eliminated snake. Coordinates are never transmitted; the server only says
    // who died. Motion is skipped entirely under prefers-reduced-motion.
    this.dust = [];
    this.dustFrame = 0;
    this.followId = null;
    this.tickMs = 105;
    // Step 10: the red classic loading ring on a disconnected player's head.
    // This is presentation only — the SERVER owns the freeze and its deadline.
    this.frozenFrame = 0;
    this.serverOffsetMs = 0;
    this.reducedMotion = typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => this.draw()) : null;
    this.resizeObserver?.observe(canvas);
    this.themeObserver = new MutationObserver(() => this.draw());
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  // A new match must start from a clean renderer. Without this, the previous
  // round's snapshot made every frame of the rematch look stale and the page
  // needed a full refresh to show the new game.
  reset() {
    this.snapshot = null;
    this.dust = [];
    this.followId = null;
    this.serverOffsetMs = 0;
    if (this.dustFrame) cancelAnimationFrame(this.dustFrame);
    this.dustFrame = 0;
    this.drawScoreboard();
    this.draw();
    return this;
  }

  setOwnParticipant(id) {
    this.ownParticipantId = id == null ? null : Number(id);
    this.drawScoreboard();
    this.draw();
  }

  setTickMs(ms) {
    if (Number.isFinite(ms) && ms > 0) this.tickMs = ms;
  }

  // Spectator perspective: ring-highlight one living player's head. Purely
  // presentational; it never changes what the server sends.
  setFollow(id) {
    this.followId = id == null ? null : Number(id);
    this.draw();
  }

  static formatSurvival(ticks, tickMs) {
    const totalSeconds = Math.max(0, Math.round((Number(ticks) || 0) * (Number(tickMs) || 0) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  accept(snapshot) {
    if (!snapshot || snapshot.v !== 1 || snapshot.type !== 'snapshot' ||
        !Number.isInteger(snapshot.t) || !snapshot.b || !Array.isArray(snapshot.p) ||
        !Array.isArray(snapshot.f)) return false;
    if (this.snapshot && snapshot.m !== this.snapshot.m) return false;
    if (this.snapshot && snapshot.t < this.snapshot.t) return false; // stale/reordered
    const cols = snapshot.b.c; const rows = snapshot.b.r;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols * rows > 96 * 72) return false;
    const total = cols * rows;
    for (const player of snapshot.p) {
      if (!Number.isInteger(player.i) || !Array.isArray(player.b) || !HEX.test(player.c)) return false;
      if (player.b.some((cell) => !Number.isInteger(cell) || cell < 0 || cell >= total)) return false;
    }
    if (snapshot.f.some((food) => !Number.isInteger(food.c) || food.c < 0 || food.c >= total)) return false;
    this.spawnDustForNewlyEliminated(snapshot);
    if (Number.isFinite(snapshot.ts) && snapshot.ts > 0) {
      this.serverOffsetMs = snapshot.ts - Date.now();
    }
    this.snapshot = snapshot;
    this.drawScoreboard();
    this.draw();
    if (snapshot.p.some((player) => player.fr)) this.pumpFreezeRings();
    if (this.status) {
      const own = snapshot.p.find((player) => player.i === this.ownParticipantId);
      this.status.textContent = snapshot.s === 'completed'
        ? (own ? `Brawl finished · ${own.sc} points` : 'Brawl finished')
        : own && !own.a ? `Eliminated · ${own.sc} points (the round continues)`
          : `Tick ${snapshot.t} · ${own ? `${own.sc} points` : 'Watching the server snapshot'}`;
    }
    return true;
  }

  spawnDustForNewlyEliminated(snapshot) {
    if (this.reducedMotion || !this.snapshot) return;
    const wasAlive = new Map(this.snapshot.p.map((player) => [player.i, player.a]));
    for (const player of snapshot.p) {
      if (wasAlive.get(player.i) === true && player.a === false && Array.isArray(player.b)) {
        // One puff per body cell, capped so a giant snake cannot flood the tab.
        const cells = player.b.slice(0, 64);
        for (const index of cells) {
          const x = index % snapshot.b.c; const y = Math.floor(index / snapshot.b.c);
          for (let k = 0; k < 3; k++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 0.4 + Math.random() * 1.6;
            this.dust.push({
              x: x + 0.5, y: y + 0.5,
              vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 0.5,
              life: 1, decay: 0.012 + Math.random() * 0.02,
              size: 0.08 + Math.random() * 0.16,
              color: HEX.test(player.c) ? player.c : '#808080',
            });
          }
        }
      }
    }
    if (this.dust.length) this.pumpDust();
  }

  pumpDust() {
    if (this.dustFrame) return;
    const step = () => {
      this.dustFrame = 0;
      for (const particle of this.dust) {
        particle.x += particle.vx * 0.06;
        particle.y += particle.vy * 0.06;
        particle.vy += 0.02; // gentle settle
        particle.life -= particle.decay;
      }
      this.dust = this.dust.filter((particle) => particle.life > 0);
      this.draw();
      if (this.dust.length) this.dustFrame = requestAnimationFrame(step);
    };
    this.dustFrame = requestAnimationFrame(step);
  }

  dustCountForTests() { return this.dust.length; }

  // Remaining grace from SERVER time. Used for the label only; when this hits
  // zero the browser does nothing — the owner releases the snake and the next
  // snapshot shows it moving.
  graceSecondsLeft(player) {
    if (!Number.isFinite(player.gu)) return 0;
    return Math.max(0, Math.ceil((player.gu - (Date.now() + this.serverOffsetMs)) / 1000));
  }

  // Keeps a smooth spinner while any snake is frozen. Stops as soon as the
  // server unfreezes everyone, so an idle board never burns animation frames.
  pumpFreezeRings() {
    if (this.frozenFrame) return;
    const step = () => {
      this.frozenFrame = 0;
      this.draw();
      this.drawScoreboard();
      if (this.snapshot && this.snapshot.p.some((player) => player.fr)) {
        this.frozenFrame = requestAnimationFrame(step);
      }
    };
    this.frozenFrame = requestAnimationFrame(step);
  }

  drawScoreboard() {
    if (!this.scoreboard || !this.snapshot) return;
    this.scoreboard.replaceChildren();
    for (const standing of this.snapshot.q || []) {
      const player = this.snapshot.p.find((entry) => entry.i === standing.i);
      if (!player) continue;
      const row = document.createElement('li');
      row.className = `mp-game-score${player.i === this.ownParticipantId ? ' is-you' : ''}`;
      const color = document.createElement('span');
      color.className = 'mp-identity-color';
      color.style.setProperty('--player-color', HEX.test(player.c) ? player.c : '#808080');
      color.setAttribute('aria-hidden', 'true');
      const place = document.createElement('span'); place.className = 'mp-game-score__place';
      place.textContent = `${standing.p}.`;
      const name = document.createElement('span'); name.className = 'mp-game-score__name';
      name.textContent = player.n;
      const score = document.createElement('strong'); score.className = 'mp-game-score__points';
      score.textContent = `${standing.sc} pts`;
      const length = document.createElement('span'); length.className = 'mp-game-score__meta';
      length.textContent = `${player.l} long`;
      const survived = document.createElement('span'); survived.className = 'mp-game-score__meta';
      survived.textContent = MultiplayerGameRenderer.formatSurvival(player.sv, this.tickMs);
      row.append(color, place, name, score, length, survived);
      const tag = document.createElement('span');
      if (player.a && player.fr) {
        tag.className = 'mp-game-score__tag is-frozen';
        tag.textContent = `frozen ${this.graceSecondsLeft(player)}s`;
      } else if (player.a) {
        tag.className = 'mp-game-score__tag is-alive'; tag.textContent = 'alive';
      } else {
        tag.className = 'mp-game-score__tag'; tag.textContent = 'out';
      }
      row.append(tag);
      this.scoreboard.append(row);
    }
  }

  draw() {
    const snapshot = this.snapshot;
    const canvas = this.canvas;
    if (!snapshot || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.max(1, Math.round(rect.width * dpr));
    const pixelHeight = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth; canvas.height = pixelHeight;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    const bg = css.getPropertyValue('--ink').trim() || '#0c0e10';
    const grid = css.getPropertyValue('--line').trim() || 'rgba(255,255,255,.08)';
    ctx.fillStyle = bg; ctx.fillRect(0, 0, rect.width, rect.height);
    const cell = Math.min(rect.width / snapshot.b.c, rect.height / snapshot.b.r);
    const boardWidth = cell * snapshot.b.c; const boardHeight = cell * snapshot.b.r;
    const ox = (rect.width - boardWidth) / 2; const oy = (rect.height - boardHeight) / 2;
    ctx.strokeStyle = grid; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= snapshot.b.c; x++) { const px = ox + x * cell; ctx.moveTo(px, oy); ctx.lineTo(px, oy + boardHeight); }
    for (let y = 0; y <= snapshot.b.r; y++) { const py = oy + y * cell; ctx.moveTo(ox, py); ctx.lineTo(ox + boardWidth, py); }
    ctx.stroke();

    // Food is owner-colored in Brawl. The server's owner id is authoritative;
    // no browser-side food coordinates are generated or moved.
    const colors = new Map(snapshot.p.map((player) => [player.i, player.c]));
    for (const food of snapshot.f) {
      const x = food.c % snapshot.b.c; const y = Math.floor(food.c / snapshot.b.c);
      const color = HEX.test(colors.get(food.o)) ? colors.get(food.o) : (css.getPropertyValue('--red').trim() || '#ff3b30');
      ctx.fillStyle = color; ctx.beginPath();
      ctx.arc(ox + (x + 0.5) * cell, oy + (y + 0.5) * cell, Math.max(2, cell * 0.31), 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = Math.max(1, cell * .06); ctx.stroke();
    }

    const followAlive = this.followId != null &&
      (snapshot.p || []).some((player) => player.i === this.followId && player.a);
    for (const player of snapshot.p) {
      const color = HEX.test(player.c) ? player.c : '#808080';
      // Eliminated bodies stay on the board, dimmed; follow mode dims the rest.
      ctx.globalAlpha = (player.a ? 1 : 0.3) * ((followAlive && player.i !== this.followId) ? 0.35 : 1);
      player.b.forEach((index, part) => {
        const x = index % snapshot.b.c; const y = Math.floor(index / snapshot.b.c);
        const pad = Math.max(1, cell * .09);
        ctx.fillStyle = color;
        ctx.fillRect(ox + x * cell + pad, oy + y * cell + pad, cell - pad * 2, cell - pad * 2);
        const ringed = (player.i === this.ownParticipantId || player.i === this.followId) && part === 0;
        if (ringed) {
          // Own head gets a white + accent double outline, so color is never the
          // only way a player can spot their own snake.
          ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(2, cell * .1);
          ctx.strokeRect(ox + x * cell + pad, oy + y * cell + pad, cell - pad * 2, cell - pad * 2);
          ctx.strokeStyle = css.getPropertyValue('--green').trim() || '#35ff6b'; ctx.lineWidth = 1;
          ctx.strokeRect(ox + x * cell + pad * 2, oy + y * cell + pad * 2, cell - pad * 4, cell - pad * 4);
        }
      });
      ctx.globalAlpha = 1;
    }

    // Step 10: disconnected snakes stay exactly where the server left them,
    // with a small red classic loading circle on their head. Purely visual;
    // the server already paused the body and owns the deadline.
    for (const player of snapshot.p) {
      if (!player.a || !player.fr || !Array.isArray(player.b) || player.b.length === 0) continue;
      const index = player.b[0];
      const x = index % snapshot.b.c; const y = Math.floor(index / snapshot.b.c);
      const cx = ox + (x + 0.5) * cell;
      const cy = oy + (y + 0.5) * cell;
      const radius = Math.max(3.5, cell * 0.34);
      const phase = (performance.now() / 700) % 1;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = 'rgba(0,0,0,.65)';
      ctx.lineWidth = Math.max(2, cell * 0.16);
      ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#ff3b30';
      ctx.lineWidth = Math.max(2, cell * 0.16);
      ctx.beginPath();
      ctx.arc(cx, cy, radius, phase * Math.PI * 2, phase * Math.PI * 2 + Math.PI * 1.25);
      ctx.stroke();
      ctx.fillStyle = '#ff3b30';
      ctx.beginPath(); ctx.arc(cx, cy, Math.max(1.2, cell * 0.1), 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // Client-only death dust. Positions were derived above from the
    // authoritative body cells; nothing about particles crossed the socket.
    for (const particle of this.dust) {
      const px = ox + particle.x * cell;
      const py = oy + particle.y * cell;
      ctx.globalAlpha = Math.max(0, Math.min(1, particle.life));
      ctx.fillStyle = particle.color;
      const size = Math.max(1, particle.size * cell * particle.life);
      ctx.fillRect(px - size / 2, py - size / 2, size, size);
    }
    ctx.globalAlpha = 1;
  }

  destroy() {
    if (this.dustFrame) cancelAnimationFrame(this.dustFrame);
    if (this.frozenFrame) cancelAnimationFrame(this.frozenFrame);
    this.frozenFrame = 0;
    this.dustFrame = 0;
    this.dust = [];
    this.resizeObserver?.disconnect();
    this.themeObserver?.disconnect();
  }
}
