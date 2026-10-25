// Step 9 presentational helpers for the Brawl surface. Pure DOM + snapshot
// shaping only: no sockets, no simulation, no fetches. lobby.js wires these
// into the live page; tests import them directly for deterministic coverage.

const HEX = /^#[0-9a-f]{6}$/i;

export function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

export function formatSurvival(ticks, tickMs) {
  const totalSeconds = Math.max(0, Math.round((Number(ticks) || 0) * (Number(tickMs) || 0) / 1000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

// Order snapshot players by the server's authoritative standings (points,
// survival, longest — the server decides; this only joins the two arrays).
export function orderedPlayers(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.p)) return [];
  const byId = new Map(snapshot.p.map((player) => [player.i, player]));
  const rows = (snapshot.q || [])
    .map((entry) => ({ entry, player: byId.get(entry.i) }))
    .filter((row) => row.player);
  for (const player of snapshot.p) {
    if (!rows.some((row) => row.player.i === player.i)) {
      rows.push({ entry: { i: player.i, p: rows.length + 1, sc: player.sc }, player });
    }
  }
  return rows;
}

// Ids that transitioned alive -> dead between two snapshots.
export function newlyEliminated(previous, next) {
  if (!previous || !next) return [];
  const wasAlive = new Map((previous.p || []).map((player) => [player.i, player.a]));
  return (next.p || []).filter((player) => wasAlive.get(player.i) === true && player.a === false)
    .map((player) => player.i);
}

export function buildResultsTable(snapshot, tickMs, ownId) {
  const table = document.createElement('table');
  table.className = 'mp-results-table';
  const head = document.createElement('thead');
  head.innerHTML = '<tr><th scope="col">#</th><th scope="col">Player</th>' +
    '<th scope="col">Points</th><th scope="col">Survived</th>' +
    '<th scope="col">Longest</th><th scope="col">Status</th></tr>';
  table.append(head);
  const body = document.createElement('tbody');
  for (const { entry, player } of orderedPlayers(snapshot)) {
    const row = document.createElement('tr');
    if (player.i === ownId) row.classList.add('is-you');
    const color = HEX.test(player.c) ? player.c : '#808080';
    row.innerHTML =
      `<td>${esc(entry.p)}</td>` +
      `<td><span class="mp-identity-color" style="--player-color:${esc(color)}" aria-hidden="true"></span> ${esc(player.n)}</td>` +
      `<td><strong>${esc(entry.sc ?? player.sc)}</strong></td>` +
      `<td>${esc(formatSurvival(player.sv, tickMs))}</td>` +
      `<td>${esc(player.lg ?? player.l)}</td>` +
      `<td>${player.a ? (player.fr ? 'Frozen' : 'Survived') : 'Eliminated'}</td>`;
    body.append(row);
  }
  table.append(body);
  return table;
}

export function showEliminationOverlay(root, { name, score, placement, total }) {
  const overlay = root.querySelector('#mp-eliminated');
  if (!overlay) return false;
  root.querySelector('#mp-eliminated-name').textContent = name || 'Your snake';
  root.querySelector('#mp-eliminated-score').textContent =
    `Final score ${score ?? 0} points · ranked #${placement ?? '–'} of ${total ?? '–'}`;
  overlay.hidden = false;
  return true;
}

export function hideEliminationOverlay(root) {
  const overlay = root.querySelector('#mp-eliminated');
  if (overlay) overlay.hidden = true;
}
