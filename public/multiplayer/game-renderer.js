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
    this.resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => this.draw()) : null;
    this.resizeObserver?.observe(canvas);
    this.themeObserver = new MutationObserver(() => this.draw());
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  setOwnParticipant(id) {
    this.ownParticipantId = id == null ? null : Number(id);
    this.drawScoreboard();
    this.draw();
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
    this.snapshot = snapshot;
    this.drawScoreboard();
    this.draw();
    if (this.status) {
      const own = snapshot.p.find((player) => player.i === this.ownParticipantId);
      this.status.textContent = snapshot.s === 'completed'
        ? (own ? `Brawl finished · ${own.sc} points` : 'Brawl finished')
        : own && !own.a ? `Eliminated · ${own.sc} points (the round continues)`
          : `Tick ${snapshot.t} · ${own ? `${own.sc} points` : 'Watching the server snapshot'}`;
    }
    return true;
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
      row.append(color, place, name, score);
      if (!player.a) {
        const out = document.createElement('span'); out.className = 'mp-game-score__tag'; out.textContent = 'out';
        row.append(out);
      }
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

    for (const player of snapshot.p) {
      const color = HEX.test(player.c) ? player.c : '#808080';
      player.b.forEach((index, part) => {
        const x = index % snapshot.b.c; const y = Math.floor(index / snapshot.b.c);
        const pad = Math.max(1, cell * .09);
        ctx.fillStyle = color;
        ctx.fillRect(ox + x * cell + pad, oy + y * cell + pad, cell - pad * 2, cell - pad * 2);
        if (player.i === this.ownParticipantId && part === 0) {
          // Own head gets a white + accent double outline, so color is never the
          // only way a player can spot their own snake.
          ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(2, cell * .1);
          ctx.strokeRect(ox + x * cell + pad, oy + y * cell + pad, cell - pad * 2, cell - pad * 2);
          ctx.strokeStyle = css.getPropertyValue('--green').trim() || '#35ff6b'; ctx.lineWidth = 1;
          ctx.strokeRect(ox + x * cell + pad * 2, oy + y * cell + pad * 2, cell - pad * 4, cell - pad * 4);
        }
      });
    }
  }

  destroy() {
    this.resizeObserver?.disconnect();
    this.themeObserver?.disconnect();
  }
}
