/*!
 * Multiplayer lobby (step 3) — plain HTTP against /api/rooms/*.
 *
 * Real-time over Action Cable (/cable): one socket per room, sharing the
 * session / guest cookie the server already trusts. Rendering, confirmations
 * and auth wiring survive the transport; the polling loop below is the
 * fallback when the socket is down.
 *
 * Identity is never handled here. The server reads the signed-in session or
 * the httpOnly guest cookie it issued; the page only ever says what it wants
 * to do, never who it is.
 */

import { createConsumer, ConnectionMonitor } from './actioncable.esm.js';
import { mountConfiguration } from './configuration.js?v=step10-mobile3';
import { MultiplayerGameRenderer } from './game-renderer.js?v=step10-mobile4';
import { SnapshotChunks } from './snapshot-chunks.js?v=step10-mobile4';
import { responsivePredictionEnabled } from './prediction.js?v=step2-prediction';
import { SwipeSteering } from './swipe-steering.js?v=step10-mobile4';
import { createPlayBudget, text } from './play-budget.js?v=step10-mobile4';
import { newlyEliminated, buildResultsTable, showEliminationOverlay, hideEliminationOverlay } from './game-ui.js?v=step10-mobile4';

// Action Cable's ConnectionMonitor already reconnects with exponential
// backoff and jitter: each attempt waits
// staleThreshold * (1 + rate)^attempts seconds, plus a random 0..rate
// multiplier (0..1 on the first try). First retry lands ~4 s, ~1.35x growth
// per attempt after, up to ~50 % extra jitter — a server restart is never
// hammered, and a single tab gives up fast enough to notice. Attempts are
// surfaced in the connection chip.
ConnectionMonitor.staleThreshold = 4;
ConnectionMonitor.reconnectionBackoffRate = 0.35;

const NAME_KEY = 'snake.multiplayer.name.v1';
const CODE_PATTERN = /[^A-Z0-9]/g;

function $(id) { return document.getElementById(id); }

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function store(key, value) {
  try { window.localStorage.setItem(key, value); } catch (err) { /* private mode */ }
}
function recall(key) {
  try { return window.localStorage.getItem(key) || ''; } catch (err) { return ''; }
}

function api(url, options) {
  const opts = options || {};
  const headers = { Accept: 'application/json' };
  if (opts.method && opts.method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    if (opts.body === undefined) opts.body = '{}';
  }
  opts.headers = headers;
  opts.credentials = 'same-origin';
  return fetch(url, opts).then((res) => res.json().then(
    (json) => ({ ok: res.ok, status: res.status, json: json || {} }),
    () => ({ ok: res.ok, status: res.status, json: {} }),
  ));
}

export function mountLobby(root) {
  if (!root) return;

  const el = {
    flash: $('mp-flash'),
    entry: $('mp-entry'),
    room: $('mp-room'),
    name: $('mp-name'),
    code: $('mp-code'),
    codePreview: $('mp-code-preview'),
    create: $('mp-create'),
    join: $('mp-join'),
    identityNote: $('mp-identity-note'),
    authActions: $('mp-auth-actions'),
    headerAuth: $('mp-header-auth'),
    signIn: $('mp-signin'),
    createAccount: $('mp-create-account'),
    signInTop: $('mp-signin-top'),
    createTop: $('mp-create-top'),
    themes: $('mp-themes'),
    conn: $('mp-conn'),
    connText: $('mp-conn-text'),
    roomCode: $('mp-room-code'),
    roomState: $('mp-room-state'),
    copyCode: $('mp-copy-code'),
    copyLink: $('mp-copy-link'),
    inviteUrl: $('mp-invite-url'),
    shareBtn: $('mp-share-room'),
    shareFeedback: $('mp-share-feedback'),
    qrToggle: $('mp-qr-toggle'),
    qrBox: $('mp-qr'),
    qrCanvas: $('mp-qr-canvas'),
    scanOpen: $('mp-scan-open'),
    scanOpenRoom: $('mp-scan-open-room'),
    scanDlg: $('mp-scan'),
    scanStage: $('mp-scan-stage'),
    scanVideo: $('mp-scan-video'),
    scanStatus: $('mp-scan-status'),
    scanCancel: $('mp-scan-cancel'),
    scanClose: $('mp-scan-close'),
    count: $('mp-count'),
    readyCount: $('mp-ready-count'),
    startState: $('mp-start-state'),
    roster: $('mp-roster'),
    game: $('mp-game'),
    gameCanvas: $('mp-game-canvas'),
    gameScores: $('mp-game-scores'),
    gameStatus: $('mp-game-status'),
    movementDetails: $('mp-movement-diagnostics'),
    movementMetrics: $('mp-movement-metrics'),
    movementPacing: $('mp-movement-pacing'),
    brawlConn: $('mp-brawl-conn'),
    brawlConnText: $('mp-brawl-conn-text'),
    gameTick: $('mp-game-tick'),
    gameInputStatus: $('mp-game-input-status'),
    gameTabs: $('mp-game-tabs'),
    gameBoardPane: $('mp-board-pane'),
    gameStandingsPane: $('mp-standings-pane'),
    followSelect: $('mp-follow'),
    followRow: $('mp-follow-row'),
    results: $('mp-results'),
    resultsTable: $('mp-results-table'),
    eliminated: $('mp-eliminated'),
    spectateBtn: $('mp-spectate'),
    lobbyViewBtn: $('mp-lobby-view'),
    duelBtn: $('mp-duel-entry'),
    boardViewBtn: $('mp-board-view'),
    readyToggle: $('mp-ready-toggle'),
    start: $('mp-start'),
    again: $('mp-again'),
    disband: $('mp-disband'),
    leave: $('mp-leave'),
    hostNote: $('mp-host-note'),
    confirm: $('mp-confirm'),
    confirmBody: $('mp-confirm-body'),
    confirmOk: $('mp-confirm-ok'),
    confirmCancel: $('mp-confirm-cancel'),
    confirmClose: $('mp-confirm-close'),
    authDialog: $('auth-dialog'),
  };

  const state = {
    room: null, member: null, viewer: null, invite: '', pending: null, cancelled: null,
    // Live-transport state. `version` is the snapshot's sequence number;
    // `synced` is false between a (re)connect and the first authoritative
    // snapshot, during which incoming events are buffered, never applied.
    version: 0,
    synced: false,
    // Server-configured public origin (config.origin): one half of the
    // scanned-QR allowlist; the page's own origin is the other.
    configOrigin: null,
    match: null,
    gameSnapshot: null,
    inputSeq: 0,
    // Step 3 diagnostics: measured input round trips (see noteRoundTrip).
    inputSentAt: new Map(),
    rttMs: null,
    rttSamples: [],
    buffered: [],
    cable: { status: 'idle', reason: null },
    // Step 10: presentation-only mirror of the server's connection state.
    matchLink: 'idle',
    freezeTimer: null,
    resumedTimer: null,
    rosterSignature: '',
    standingsSignature: '',
    resultsSignature: '',
    liveHudBudget: createPlayBudget(),
    gamePane: 'board',
    frozenDeadline: '',
    controls: null,
  };
  let consumer = null;
  let subscription = null;
  let cableCode = null;
  let matchSubscription = null;
  let matchSubscriptionId = null;
  let heartbeatTimer = null;
  let matchHeartbeatTimer = null;
  let movementDiagnosticsTimer = null;
  let refreshTimer = null;
  const pollInterval = Math.max(2, parseInt(root.dataset.pollInterval, 10) || 5) * 1000;
  let timer = null;
  const configuration = mountConfiguration({ api, apply, getState: () => state });
  const snapshotChunks = new SnapshotChunks();
  const gameRenderer = el.gameCanvas ? new MultiplayerGameRenderer({
    onResyncNeeded: (reason) => requestMatchResync(reason),
    canvas: el.gameCanvas,
    scoreboard: el.gameScores,
    status: el.gameStatus,
    ownParticipantId: null,
  }) : null;

  // ---- helpers --------------------------------------------------------------

  function flash(message, kind) {
    if (!el.flash) return;
    if (!message) { el.flash.hidden = true; el.flash.textContent = ''; return; }
    el.flash.hidden = false;
    el.flash.textContent = message;
    el.flash.setAttribute('data-kind', kind || 'info');
  }

  function cleanCode(value) {
    return String(value || '').toUpperCase().replace(CODE_PATTERN, '');
  }

  function desiredName() {
    return (el.name && el.name.value.trim()) || '';
  }

  function busy(on) {
    [el.create, el.join, el.readyToggle, el.start, el.disband, el.leave].forEach((button) => {
      if (button) button.disabled = !!on;
    });
  }

  // ---- rendering ------------------------------------------------------------

  // ---- server-owned connection state (step 10) ------------------------------
  //
  // The browser renders labels and a countdown only. It NEVER starts, extends
  // or ends the freeze; every transition arrives as an authoritative
  // MatchChannel event or snapshot from the leased simulator owner.
  function setBrawlConn(kind, label) {
    state.matchLink = kind;
    if (el.brawlConn && el.brawlConn.dataset.state !== kind) el.brawlConn.dataset.state = kind;
    text(el.brawlConnText, label);
  }

  function stopFreezeCountdown() {
    if (state.freezeTimer) { window.clearInterval(state.freezeTimer); state.freezeTimer = null; }
    state.frozenDeadline = '';
  }

  function stopResumedTimer() {
    if (state.resumedTimer) { window.clearTimeout(state.resumedTimer); state.resumedTimer = null; }
  }

  function showGraceCountdown(deadlineIso) {
    if (state.frozenDeadline === deadlineIso && state.freezeTimer) return;
    stopFreezeCountdown();
    state.frozenDeadline = deadlineIso || '';
    const deadline = Date.parse(deadlineIso || '');
    const tick = () => {
      if (!Number.isFinite(deadline)) {
        setBrawlConn('lost', 'Connection lost — your snake is frozen while we reconnect…');
        return;
      }
      const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setBrawlConn('lost', `Connection lost — snake frozen, ${seconds}s grace left. Reconnecting…`);
      if (seconds <= 0) {
        stopFreezeCountdown();
        setBrawlConn('warn', 'Grace expired — your snake keeps moving on its own. Reconnecting…');
      }
    };
    tick();
    state.freezeTimer = window.setInterval(tick, 1000);
  }

  function markResumed() {
    stopFreezeCountdown();
    stopResumedTimer();
    setBrawlConn('live', 'Resumed — authoritative state restored, controls live.');
    state.resumedTimer = window.setTimeout(() => {
      if (state.matchLink === 'live') setBrawlConn('live', 'Live');
    }, 5000);
  }

  function markSpectating() {
    stopFreezeCountdown();
    setBrawlConn('spectating', 'Spectating — your snake is out; the Brawl continues.');
  }

  // Local-only measurements: no new HTTP polling, analytics or authority.
  // Sample only while the player has explicitly opened the details panel.
  // Step 2: what prediction actually did, in numbers. Printed only while the
  // panel is open (the existing 1 Hz HUD budget), never per animation frame.
  function predictionDiagnosticLines(pr) {
    if (!pr) return ['Prediction: unavailable in this build'];
    if (!pr.enabled) {
      return [`Prediction: off (server strategy ${state.match?.presentation_strategy || 'classic'} — Classic Brawl paints server frames only)`];
    }
    const pct = (pr.correctionRate * 100).toFixed(1);
    const lines = [
      `Prediction: ${pr.mode} · painted ${pr.painted ? 'LOCAL' : 'server frame'} · armed by ${pr.mode === 'test override' ? 'TEST OVERRIDE (not a Responsive match)' : 'server strategy'}`,
      `Confirmed tick ${pr.confirmedTick ?? '–'} → predicted ${pr.predictedTick ?? '–'} (lead ${pr.lead}/${pr.limits.maxLeadTicks}) · pending seq [${pr.pendingSeqs.join(', ') || '–'}]`,
      `Inputs: submitted ${pr.submitted} · queued-ack ${pr.queuedAcks} · applied ${pr.appliedAcks} · rejected ${pr.rejectedAcks} · refused locally ${pr.refused}`,
      `Reconciliation: ${pr.reconciliations} frames · ${pr.corrections} corrections (${pct}% of frames) · largest ${pr.maxCorrectionCells} cells · stale/dup ignored ${pr.staleFrames}/${pr.duplicateFrames}`,
      `Boundaries: lead stalls ${pr.leadStalls} · horizon refusals ${pr.horizonRefusals} · pending overflow ${pr.droppedPending} · catch-up discarded ${pr.catchupDiscards} · other-tab sequences ${pr.foreignApplied}`
    ];
    if (pr.predictedFood || pr.predictedGrowths) {
      lines.push(`Food: ${pr.predictedFood} eaten locally (score and respawn stay server-confirmed)`);
    }
    if (pr.frozenPauses || pr.blockedTurns) {
      lines.push(`Authority: frozen pauses ${pr.frozenPauses} · blocked/holding turns ${pr.blockedTurns}`);
    }
    return lines;
  }

  // Step 3: remote playback, split into what this browser MEASURED and what it
  // ESTIMATED from tick cadence. Nothing here is sent anywhere; the whole block
  // is only produced while the details panel is open (the existing 1 Hz HUD
  // budget), never per animation frame.
  function playbackDiagnosticLines(pb) {
    if (!pb) return ['Remote playback: unavailable in this build'];
    if (!pb.enabled) {
      return ['Remote playback: off (Classic Brawl paints each confirmed frame as it arrives)'];
    }
    return [
      `Remote playback: ${pb.reason} · ${pb.painted ? 'interpolating' : 'holding at confirmed tick'}` +
        ` · delay ${pb.delayMs}ms measured (target ${pb.targetDelayMs}ms estimated)`,
      `Remote buffer: ${pb.buffered}/${pb.maxBufferTicks} confirmed ticks` +
        ` (${pb.oldestTick ?? '–'}–${pb.newestTick ?? '–'}) · playhead ${pb.playheadTick ?? '–'}` +
        ` · arrival jitter ${pb.jitterMs}ms estimated`,
      `Remote gaps: ${pb.missingTicks} missing ticks (${pb.gaps} gaps) · buffer underruns ${pb.underruns}` +
        ` · resyncs ${pb.resyncs} · stale discards ${pb.staleDrops}`,
      `Remote intake: ${pb.snapshotFrames} full / ${pb.movementFrames} compact frames` +
        ` · bodies rebuilt ${pb.reconstructed} · refused ${pb.reconstructRejects}` +
        ` · duplicates ${pb.duplicates} · out-of-order ${pb.outOfOrder}`,
      `Remote wrap frames ${pb.wrapSegments} · interpolated ${pb.interpolatedFrames}` +
        ` · held ${pb.heldFrames} · canvas ${pb.playbackDrawCostMs}ms over ${pb.playbackDraws} playback draws`,
    ];
  }

  // Measured network numbers, clearly separated from estimates: the RTT is a
  // real input round trip, the tick lag is derived from ticks and the local
  // clock.
  function networkDiagnosticLines() {
    const rtt = state.rttMs === null ? null : Math.round(state.rttMs);
    const jitter = rttJitter();
    const d = gameRenderer?.movementDiagnostics();
    const confirmed = d?.prediction?.confirmedTick ?? null;
    const predicted = d?.prediction?.predictedTick ?? null;
    return [
      `Network RTT: ${rtt === null ? 'no sample yet' : `${rtt}ms measured (input round trip)${jitter === null ? '' : ` · spread ${jitter}ms`}`}` +
        ` · propagation to this board ≈ ${rtt === null ? '–' : `${Math.round(rtt / 2)}ms estimated`}`,
      `Ticks: predicted ${predicted ?? '–'} vs confirmed ${confirmed ?? '–'}` +
        ` · remote playhead ${d?.playback?.lastSample?.tick ?? '–'}` +
        ` · strategy ${state.match?.presentation_strategy || 'classic'} (server-locked)`,
    ];
  }

  function renderMovementDiagnostics() {
    if (!el.movementDetails?.open || !gameRenderer) return;
    const d = gameRenderer.movementDiagnostics();
    const stat = (v) => `p50 ${v.p50} · p95 ${v.p95} · max ${v.max} ms`;
    text(el.movementMetrics, [
      `Presentation strategy: ${state.match?.presentation_strategy || state.room?.presentation_strategy || 'classic'}` +
        `${state.match?.presentation_strategy === 'responsive' ? ' (active: local prediction + buffered remote playback)' : ' (active: every frame painted as it arrives)'}`,
      `Client release: ${d.release}`,
      `Received tick ${d.receivedTick ?? '–'} · displayed ${d.displayedTick ?? '–'}`,
      `Last snapshot: ${d.lastSnapshotAgeMs ?? '–'} ms ago`,
      `Server tick interval: ${stat(d.serverTickMs)}`,
      `Snapshot arrival gaps: ${stat(d.arrivalGapMs)}`,
      `Delivery variation: ${stat(d.deliveryVariationMs)}`,
      `Canvas draw cost: ${stat(d.drawCostMs)}`,
      `Receive → draw: ${stat(d.receiveToPaintMs)}`,
      `Adaptive hold: ${d.cadenceEnabled ? 'on' : 'off'} (limit ${d.maxHoldMs} ms + one display refresh)`,
      `Queue ${d.queued}/3 · coalesced ${d.coalesced} · buffered tick gaps ${d.skippedServerTicks}`,
      `Authoritative snapshots: missing ${d.missingSnapshots} · duplicate ${d.duplicateSnapshots} · stale/out-of-order ${d.staleSnapshots}`,
      ...predictionDiagnosticLines(d.prediction),
      ...playbackDiagnosticLines(d.playback),
      ...networkDiagnosticLines(),
      `Delayed display callbacks bypassed: ${d.displayWatchdog}`,
      'Browser timing only; physical scanout and true one-way network latency are not measurable here.',
    ].join('\n'));
  }

  function render() {
    const inRoom = !!state.room;
    if (el.entry) el.entry.hidden = inRoom;
    if (el.room) el.room.hidden = !inRoom;
    renderViewer();
    if (inRoom) renderRoom();
    renderGame();
    configuration.render(state.room, state.member);
  }

  function renderViewer() {
    const viewer = state.viewer || {};
    if (el.identityNote) {
      el.identityNote.textContent = viewer.signed_in
        ? `Signed in as ${viewer.username}. Your room name can differ from your account name.`
        : 'Guests can play straight away — no account needed.';
    }
    if (el.authActions) el.authActions.hidden = !!viewer.signed_in;
    if (el.headerAuth) el.headerAuth.hidden = !!viewer.signed_in;
    if (el.name && !el.name.value) {
      el.name.value = viewer.signed_in ? viewer.username || '' : recall(NAME_KEY);
    }
  }

  function renderRoom() {
    const room = state.room;
    const me = state.member || {};
    const counts = room.counts || {};
    const start = room.start || {};
    const amHost = !!me.host;

    if (el.roomCode) el.roomCode.textContent = room.code;
    if (el.roomState) el.roomState.textContent = room.state;
    if (el.count) {
      el.count.textContent = `${counts.members} / ${counts.capacity} players`;
    }
    if (el.readyCount) {
      el.readyCount.textContent = `${counts.ready} ready`;
    }
    if (el.startState) {
      el.startState.textContent = start.eligible
        ? `Enough players to start · ${start.presentation_strategy === 'responsive' ? 'Responsive' : 'Classic'} Brawl`
        : `Needs ${start.minimum_players} connected players`;
    }

    if (el.roster) {
      // PERFORMANCE: the roster used to be rebuilt with innerHTML on every
      // poll and every room event (including 1 Hz heartbeats on 8-player
      // lobbies). It now repaints only when something visible changed.
      const rosterSignature = JSON.stringify((room.members || []).map((member) => [
        member.id, member.display_name, member.online, member.host, member.ready,
        member.spectator, member.you, member.color?.hex,
      ]));
      if (rosterSignature !== state.rosterSignature) {
        state.rosterSignature = rosterSignature;
        el.roster.innerHTML = (room.members || []).map((member) => {
        const tags = [];
        if (member.you) tags.push('<span class="mp-player__tag">you</span>');
        if (!member.online) tags.push('<span class="mp-player__tag">away</span>');
        if (member.spectator) tags.push('<span class="mp-player__tag">spectating</span>');
        return [
          `<li class="mp-player${member.you ? ' is-you' : ''}" data-member-id="${member.id}">`,
          `<span class="mp-identity-color" style="--player-color:${/^#[0-9A-F]{6}$/i.test(member.color?.hex) ? member.color.hex : '#808080'}" role="img" aria-label="${esc(member.color?.label || 'Player color')}"></span>`,
          `<span class="mp-dot${member.online ? ' is-online' : ''}" aria-hidden="true"></span>`,
          member.host
            ? '<span class="mp-crown" role="img" aria-label="Host">👑</span>'
            : '',
          `<span class="mp-player__name">${esc(member.display_name)}</span>`,
          tags.join(''),
          '<span class="mp-player__spacer"></span>',
          `<span class="mp-badge${member.ready ? ' is-ready' : ''}">${member.ready ? 'Ready' : 'Not ready'}</span>`,
          '</li>',
        ].join('');
        }).join('');
      }
    }

    if (el.readyToggle) {
      el.readyToggle.textContent = me.spectator ? 'Spectating this match' : me.ready ? 'Not ready' : "I'm ready";
      el.readyToggle.disabled = !!me.spectator || room.state === 'in_match';
    }
    const responsiveUnavailable = room.presentation_strategy === 'responsive';
    if (el.start) {
      el.start.hidden = !amHost || room.state !== 'lobby';
      el.start.disabled = responsiveUnavailable;
      el.start.title = responsiveUnavailable
        ? 'Responsive Brawl is unavailable until Step 3. Choose Classic Brawl to start.' : '';
    }
    if (el.again) {
      el.again.hidden = !amHost || room.state !== 'finished';
      el.again.disabled = responsiveUnavailable;
      el.again.title = responsiveUnavailable
        ? 'Responsive Brawl is unavailable until Step 3. Choose Classic Brawl to start.' : '';
    }
    if (el.disband) el.disband.hidden = !amHost;
    if (el.hostNote) el.hostNote.hidden = !amHost;
    state.invite = room.invite_url || '';
    if (el.inviteUrl) el.inviteUrl.textContent = state.invite;
    // Web Share is progressive enhancement; Copy Link is always present.
    if (el.shareBtn) el.shareBtn.hidden = !(state.invite && typeof navigator.share === 'function');
    connectMatchCable(state.match);
  }

  function renderGame() {
    const match = state.match;
    const relevant = match && ['pending', 'running', 'paused', 'completed'].includes(match.status);
    if (el.game) el.game.hidden = !relevant;
    if (!relevant) {
      gameRenderer?.setOwnParticipant(null);
      hideEliminationOverlay(document);
      if (el.results) el.results.hidden = true;
      if (el.gameInputStatus) el.gameInputStatus.textContent = '';
      return;
    }
    const participantId = state.member?.match_participant_id;
    gameRenderer?.setOwnParticipant(participantId);
    gameRenderer?.setActive(state.gamePane === 'board');
    state.liveHudBudget.start();
    gameRenderer?.setTickMs(match.tick_ms);
    // Step 2: Responsive Brawl arms local prediction; Classic does not, and
    // cannot be nudged into it by a query string on a real game. The strategy is
    // read off the LOCKED match record (`presentation_strategy`), never off the
    // lobby preference, so the client can never predict a match the server is
    // presenting some other way. `testOnly` is the one deliberate exception and
    // it announces itself in Movement diagnostics.
    const prediction = responsivePredictionEnabled({
      strategy: match.presentation_strategy,
      search: window.location.search,
      storage: window.sessionStorage
    });
    if (gameRenderer?.setPredictionMode(prediction, match)) {
      if (prediction.active) {
        state.inputSeq = Math.max(state.inputSeq, Number(state.member?.last_input_seq || 0));
        gameRenderer.noteInputSequence(Number(state.member?.last_input_seq || 0));
        flash(prediction.testOnly
          ? 'TEST MODE: local prediction is armed for measurement while the server still presents this Brawl as classic. Remote snakes and every result stay server-authoritative.'
          : 'Responsive Brawl: your own snake moves on your key press; the server still owns everything else.', 'info');
      }
    }
    if (el.gameTick && state.gameSnapshot) text(el.gameTick, `Tick ${state.gameSnapshot.t}`);
    // Roster/palette/board are lobby-only, and must not schedule any
    // background work on a moving snake. A match's controls already do not
    // depend on the lobby host's tab.
    if (state.room) {
      window.MatrixRain?.set(false);
    }
    renderFollowOptions();
    if (state.gameSnapshot) renderStandingsTable();
    if (match.status === 'completed' && state.gameSnapshot) renderResults();
    else if (el.results) el.results.hidden = true;
  }

  // Board / Standings / Lobby switcher. Purely presentational: membership,
  // sockets and the simulation are untouched, so nothing here can drop a seat.
  function showGamePane(name) {
    state.gamePane = name;
    gameRenderer?.setActive(name === 'board');
    if (el.gameBoardPane) el.gameBoardPane.hidden = name !== 'board';
    if (el.gameStandingsPane) el.gameStandingsPane.hidden = name !== 'standings';
    const backRow = document.getElementById('mp-back-to-board-row');
    if (backRow) backRow.hidden = !(name === 'lobby' && state.match);
    if (el.gameTabs) {
      el.gameTabs.querySelectorAll('[data-game-pane]').forEach((button) => {
        button.setAttribute('aria-pressed', String(button.dataset.gamePane === name));
      });
    }
    if (name === 'standings') renderStandingsTable(true);
    if (name === 'lobby' && el.room) {
      el.game.hidden = true;
      el.room.scrollIntoView({ block: 'nearest' });
    } else if (el.game && state.match) {
      el.game.hidden = false;
    }
  }

  // Spectator perspective picker: follow one living player (ring highlight +
  // their name in the status line), or watch the whole board.
  function renderFollowOptions() {
    const select = el.followSelect;
    if (!select || !state.gameSnapshot) return;
    const living = (state.gameSnapshot.p || []).filter((player) => player.a);
    const current = [...select.options].map((option) => option.value);
    const wanted = ['', ...living.map((player) => String(player.i))];
    if (current.join() !== wanted.join()) {
      select.replaceChildren();
      const all = document.createElement('option');
      all.value = '';
      all.textContent = 'Whole board';
      select.append(all);
      for (const player of living) {
        const option = document.createElement('option');
        option.value = String(player.i);
        option.textContent = `Follow ${player.n}`;
        select.append(option);
      }
    }
    if (el.followRow) el.followRow.hidden = living.length === 0;
  }

  // PERFORMANCE: both tables are diffed by signature and skipped while their
  // pane is hidden. The old code rebuilt a full <table> for every 10 Hz
  // snapshot even when the Standings tab was not visible.
  function standingsSignature() {
    const snapshot = state.gameSnapshot;
    if (!snapshot) return '';
    // Built by concatenation: this runs on every authoritative frame and a
    // JSON.stringify of two arrays per tick is measurable on a phone.
    let signature = `${snapshot.t}:${state.match?.tick_ms}:${state.member?.match_participant_id}`;
    for (const row of snapshot.q || []) signature += `|${row.i}:${row.p}:${row.sc}`;
    for (const player of snapshot.p || []) signature += `#${player.i}:${player.a ? 1 : 0}${player.fr ? 1 : 0}:${player.l}:${player.sv}`;
    return signature;
  }

  function renderStandingsTable(force = false) {
    const container = document.getElementById('mp-standings-table');
    if (!container || !state.gameSnapshot) return;
    if (el.gameStandingsPane?.hidden && !force) return;
    const signature = standingsSignature();
    if (!force && signature === state.standingsSignature) return;
    state.standingsSignature = signature;
    container.replaceChildren();
    container.append(buildResultsTable(state.gameSnapshot, state.match?.tick_ms,
      state.member?.match_participant_id));
  }

  function renderResults() {
    const container = el.resultsTable;
    if (!container || !state.gameSnapshot) return;
    const signature = `results:${standingsSignature()}`;
    if (signature === state.resultsSignature) {
      if (el.results) el.results.hidden = false;
      return;
    }
    state.resultsSignature = signature;
    container.replaceChildren();
    container.append(buildResultsTable(state.gameSnapshot, state.match?.tick_ms,
      state.member?.match_participant_id));
    if (el.results) el.results.hidden = false;
  }

  // ---- server conversation ---------------------------------------------------

  function apply(out) {
    const incoming = out.json?.room;
    // A slow capabilities/settings response must not roll a newer live
    // snapshot backwards. Version numbers apply to HTTP snapshots too.
    if (incoming?.code === state.room?.code && typeof incoming?.version === 'number' && incoming.version < state.version) return out;
    if (out.json && Object.prototype.hasOwnProperty.call(out.json, 'room')) {
      const previousCode = state.room?.code;
      const previousMatchId = state.match?.id;
      state.room = out.json.room && out.json.room.members ? out.json.room : null;
      state.member = out.json.member || null;
      state.match = out.json.match || state.room?.match || null;
      if (!state.room || state.room.code !== previousCode) {
        state.gameSnapshot = null;
        state.inputSeq = 0;
      }
      if (state.match && state.match.id !== previousMatchId) {
        snapshotChunks.reset();
        // A rematch is a new tick/sequence space: drop every unconfirmed
        // prediction instead of replaying it into a different match.
        gameRenderer?.resetPrediction();
        swipes.cancel();
        // A rematch is a NEW round. Reset every piece of round-local state in
        // the browser (renderer, results, banners, sequence mirror) so the
        // server's new snapshots render immediately — no page refresh.
        state.gameSnapshot = null;
        state.controls = null;
        state.inputSeq = Number(state.member?.last_input_seq || 0);
        // The server's per-player sequence mirror is the tie-breaker between
        // tabs: one identity has ONE counter that only the server advances, so
        // the newest snapshot's applied sequence always outranks a local buffer.
        gameRenderer?.noteInputSequence(state.inputSeq);
        state.standingsSignature = '';
        state.resultsSignature = '';
        gameRenderer?.reset();
        hideEliminationOverlay(document);
        stopFreezeCountdown();
        stopResumedTimer();
        setBrawlConn('live', state.match.spectator ? 'Spectating the live Brawl.' : 'Live');
        if (el.results) el.results.hidden = true;
        if (el.gameInputStatus) { el.gameInputStatus.textContent = ''; el.gameInputStatus.removeAttribute('data-kind'); }
      }
      if (!state.match) {
        state.gameSnapshot = null;
        gameRenderer?.reset();
        if (el.results) el.results.hidden = true;
        setBrawlConn('live', 'Waiting for the next Brawl…');
        disconnectMatchCable();
      }
      if (state.room && typeof out.json.room.version === 'number') {
        // Snapshots are authoritative: adopting their version is what makes
        // older buffered events stale (and therefore droppable) instantly.
        state.version = out.json.room.version;
      }
    }
    if (out.json && out.json.viewer) state.viewer = out.json.viewer;
    if (out.json && out.json.config && out.json.config.origin) state.configOrigin = out.json.config.origin;
    if (out.json && out.json.notice) flash(out.json.notice, 'info');
    render();
    // One socket per room, closed the moment there is no room to watch.
    if (state.room) connectCable(state.room.code);
    else disconnectCable();
    return out;
  }

  function refresh() {
    return api('/api/rooms/current').then((out) => {
      if (!out.ok) return out;
      apply(out);
      return out;
    }).catch(() => null);
  }

  // While the socket is live it delivers events *and* presence (heartbeat),
  // so HTTP polling drops to a slow safety net. While it is down, polling is
  // the fallback that keeps the lobby correct without a refresh — and it still
  // acts as the presence heartbeat through the HTTP API. When hidden and the
  // socket is down there is nothing to do; skip until visible again.
  function poll() {
    window.clearTimeout(timer);
    const live = state.cable.status === 'live';
    timer = window.setTimeout(function tick() {
      const socketUp = state.cable.status === 'live';
      if (document.visibilityState === 'hidden' && !socketUp) { poll(); return; }
      refresh().then(drainBuffered);
      if (state.cable.status === 'reconnecting') renderConn();
      poll();
    }, live ? 90000 : pollInterval);
  }

  // Requirement 12: never silently abandon a room. Ask, then retry.
  function confirmSwitch(message, retry, onCancel) {
    if (!el.confirm || !el.confirm.showModal) {
      if (window.confirm(message)) retry();
      else if (onCancel) onCancel();
      return;
    }
    if (el.confirmBody) el.confirmBody.textContent = message;
    state.pending = retry;
    state.cancelled = onCancel || null;
    el.confirm.showModal();
  }

  function handleFailure(out, retry) {
    const code = out.json && out.json.code;
    const message = (out.json && out.json.error) || 'Something went wrong';
    if (code === 'in_other_room') {
      const current = (out.json && out.json.current) || {};
      confirmSwitch(
        `You are already in room ${current.code}. Leave it and join this one?`,
        () => retry(true),
      );
      return;
    }
    flash(message, 'error');
  }

  function createRoom(leaveCurrent) {
    const name = desiredName();
    if (!name && !(state.viewer && state.viewer.signed_in)) {
      flash('Enter a name to play as.', 'error');
      if (el.name) el.name.focus();
      return;
    }
    if (name) store(NAME_KEY, name);
    busy(true);
    api('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({
        display_name: name,
        leave_current: !!leaveCurrent,
      }),
    }).then((out) => {
      busy(false);
      if (!out.ok) return handleFailure(out, createRoom);
      flash('Room ready — share the code or the invite link.', 'info');
      apply(out);
      history.replaceState({}, '', `/multiplayer/${out.json.room.code}`);
    }).catch(() => { busy(false); flash('Network error — try again', 'error'); });
  }

  function joinCode(code, leaveCurrent) {
    if (el.code) el.code.value = code;
    joinRoom(leaveCurrent);
  }

  function joinRoom(leaveCurrent) {
    const code = cleanCode(el.code && el.code.value);
    if (!code) { flash('Enter an invitation code.', 'error'); return; }
    const name = desiredName();
    if (name) store(NAME_KEY, name);
    busy(true);
    api(`/api/rooms/${code}/join`, {
      method: 'POST',
      body: JSON.stringify({ display_name: name, leave_current: !!leaveCurrent }),
    }).then((out) => {
      busy(false);
      if (!out.ok) return handleFailure(out, joinRoom);
      flash('', null);
      apply(out);
      history.replaceState({}, '', `/multiplayer/${code}`);
    }).catch(() => { busy(false); flash('Network error — try again', 'error'); });
  }

  function roomAction(path, body) {
    if (!state.room) return Promise.resolve(null);
    busy(true);
    return api(`/api/rooms/${state.room.code}/${path}`, {
      method: 'POST',
      body: JSON.stringify(body || {}),
    }).then((out) => {
      busy(false);
      if (!out.ok) { flash((out.json && out.json.error) || 'Something went wrong', 'error'); return out; }
      apply(out);
      return out;
    }).catch(() => { busy(false); flash('Network error — try again', 'error'); return null; });
  }

  // Looks a code up before anyone commits to it, so invalid, disbanded and
  // expired invitations explain themselves straight away.
  function previewCode(code) {
    if (!el.codePreview) return;
    if (!code || code.length < 4) { el.codePreview.hidden = true; return; }
    api(`/api/rooms/${code}`).then((out) => {
      el.codePreview.hidden = false;
      if (!out.ok) { el.codePreview.textContent = (out.json && out.json.error) || 'That code did not work.'; return; }
      if (out.json.room && out.json.room.members) { el.codePreview.hidden = true; return; } // already a member
      const preview = out.json.room || {};
      const counts = preview.counts || {};
      el.codePreview.textContent = preview.joinable
        ? `${preview.state === 'in_match' ? 'Spectate this Brawl · ' : ''}${preview.host_name || 'Someone'}'s room · ${counts.members}/${counts.capacity} players`
        : 'That room is not open for joining right now.';
    }).catch(() => { el.codePreview.hidden = true; });
  }

  // navigator.clipboard only exists in secure contexts, so on a plain HTTP
  // self-host it must fall back to the selection trick — which is why "Copy"
  // used to look dead before this existed.
  // Clipboard with honest, visible feedback (step 5): the sharing panel's
  // status line reports success, and on failure shows exactly what to copy by
  // hand instead of failing silently. Two paths: the async Clipboard API in
  // secure contexts, then the selection trick for plain-HTTP self-hosts.
  async function copyText(text) {
    if (!text) return false;
    if (window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (err) { /* fall through to the selection trick */ }
    }
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.left = '-9999px';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(area);
      return ok === true;
    } catch (err) {
      return false;
    }
  }

  function copyWithFeedback(text, button, label) {
    copyText(text).then((ok) => {
      if (button) {
        const original = button.textContent;
        button.textContent = ok ? label : 'Copy failed';
        window.setTimeout(() => { button.textContent = original; }, 1800);
      }
      if (ok) shareFeedback(`${label} — copied to the clipboard.`, 'ok');
      else shareFeedback(`Automatic copy failed — select and copy: ${text}`, 'error');
    });
  }

  // ---- accounts (reuses the shared auth dialog markup) ------------------------

  function setAuthMode(mode) {
    const login = mode !== 'create';
    const tabLogin = $('auth-tab-login');
    const tabCreate = $('auth-tab-create');
    const formLogin = $('form-login');
    const formCreate = $('form-create');
    if (tabLogin) tabLogin.setAttribute('aria-selected', String(login));
    if (tabCreate) tabCreate.setAttribute('aria-selected', String(!login));
    if (formLogin) formLogin.hidden = !login;
    if (formCreate) formCreate.hidden = login;
  }

  function openAuth(mode) {
    if (!el.authDialog || !el.authDialog.showModal) return;
    setAuthMode(mode);
    if (!el.authDialog.open) el.authDialog.showModal();
  }

  // Signing in from inside a room keeps the seat: the server attaches this
  // browser's verified guest membership to the account (step 2's claim).
  function afterAuth() {
    const hadGuestRoom = !!state.room && !!state.member && state.member.guest;
    const finish = () => refresh().then(() => {
      if (el.authDialog && el.authDialog.open) el.authDialog.close();
    });
    if (!hadGuestRoom) return finish();
    return api('/api/rooms/claim', { method: 'POST' }).then((out) => {
      if (out.ok) {
        apply(out);
        flash('Your seat is now linked to your account.', 'info');
        reconnectCable(); // new credential (account session) carries the socket
      }
      return finish();
    }).catch(finish);
  }

  function submitAuth(url, form, errorId) {
    const errEl = $(errorId);
    if (errEl) errEl.textContent = '';
    const username = form.elements.username ? form.elements.username.value : '';
    const password = form.elements.password ? form.elements.password.value : '';
    const confirmField = form.elements['confirm-password'];
    if (confirmField && confirmField.value !== password) {
      if (errEl) errEl.textContent = 'Passwords do not match';
      return;
    }
    api(url, { method: 'POST', body: JSON.stringify({ username, password }) }).then((out) => {
      if (!out.ok) {
        if (errEl) errEl.textContent = (out.json && out.json.error) || 'Something went wrong';
        return;
      }
      afterAuth();
    }).catch(() => { if (errEl) errEl.textContent = 'Network error — try again'; });
  }

  // ---- theme picker (same segmented control as the game page settings) -------

  function savedSettings() {
    try { return JSON.parse(window.localStorage.getItem('snake.settings.v1') || '{}') || {}; }
    catch (err) { return {}; }
  }

  function markThemes() {
    if (!el.themes) return;
    const active = document.documentElement.dataset.theme || 'classic';
    el.themes.querySelectorAll('button[data-theme]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.theme === active));
    });
  }

  function pickTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    // Merge into the saved settings instead of replacing them, so the game
    // page's speed/growth/custom choices are never lost from here.
    const settings = savedSettings();
    settings.theme = theme;
    try { window.localStorage.setItem('snake.settings.v1', JSON.stringify(settings)); } catch (err) { /* blocked */ }
    window.MatrixRain?.set(theme === 'terminal' && !state.match);
    markThemes();
  }

  // ---- Action Cable transport ---------------------------------------------------
  //
  // One socket per room. Protocol (server: RoomChannel, docs:
  // rails/docs/multiplayer-transport.md):
  //   * every event = { code, event, v } — never a roster; v is rooms.version
  //   * apply an event only while snapshot-synced AND v > snapshot version;
  //     anything older is a stale replay (other tab, out-of-order, our own
  //     echo) and is dropped without touching the DOM
  //   * on every (re)connect the authoritative snapshot is fetched FIRST and
  //     events that arrived meanwhile stay buffered until it lands; the moment
  //     the snapshot's version is adopted, buffered older events are droppable
  //   * a gap (v > snapshot + 1) means we missed something -> snapshot again

  function renderConn() {
    const chip = el.conn;
    if (!chip) return;
    const attempts = (consumer && consumer.connection && consumer.connection.monitor)
      ? (consumer.connection.monitor.reconnectAttempts || 0)
      : 0;
    const labels = {
      idle: ['idle', ''],
      connecting: ['connecting', 'Connecting\u2026'],
      live: ['live', 'Live'],
      reconnecting: ['reconnecting', attempts ? `Reconnecting\u2026 (${attempts})` : 'Reconnecting\u2026'],
      rejected: ['offline', 'Disconnected'],
    };
    const [cls, text] = labels[state.cable.status] || labels.idle;
    chip.setAttribute('data-state', cls);
    if (el.connText) el.connText.textContent = text;
  }

  function startHeartbeat() {
    stopHeartbeat();
    // Keeps last_seen_at moving while HTTP polling is throttled back, so
    // presence (and the host's crown) survives a long-lived idle lobby.
    heartbeatTimer = window.setInterval(() => {
      if (state.cable.status === 'live' && subscription) subscription.perform('heartbeat');
    }, 25000);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) { window.clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }

  function connectCable(code) {
    // Same room already attached (or rejected — never hammer a rejected
    // subscription; the user's next join/leave re-arms it via disconnect).
    if (consumer && cableCode === code) return;
    disconnectCable();
    cableCode = code;
    state.cable.status = 'connecting';
    state.cable.reason = null;
    state.synced = false;
    state.buffered = [];
    renderConn();
    consumer = createConsumer('/cable'); // relative -> wss:// behind any proxy
    subscription = consumer.subscriptions.create(
      { channel: 'RoomChannel', code: code },
      {
        connected() {
          // Snapshot first, events second — always, on every reconnect.
          state.synced = false;
          state.buffered = [];
          state.cable.status = 'live';
          state.cable.reason = null;
          renderConn();
          refresh().then(drainBuffered);
          startHeartbeat();
        },
        disconnected() {
          stopHeartbeat();
          if (state.cable.status === 'rejected') return;
          state.cable.status = 'reconnecting';
          state.synced = false;
          renderConn();
        },
        rejected() {
          stopHeartbeat();
          state.cable.status = 'rejected';
          renderConn();
          explainRejection(code);
        },
        received(message) { onCableMessage(message); },
      },
    );
  }

  function disconnectCable() {
    disconnectMatchCable();
    stopMatchHeartbeat();
    stopHeartbeat();
    if (consumer) { try { consumer.disconnect(); } catch (err) { /* closing anyway */ } }
    consumer = null;
    subscription = null;
    cableCode = null;
    state.synced = false;
    state.buffered = [];
    if (state.cable.status !== 'rejected') state.cable.status = 'idle';
    renderConn();
  }

  // After signing in (or claiming a seat) the cookie that identifies this
  // socket has changed: reconnect so the server re-derives identity from the
  // new credential instead of trusting the old one.
  function reconnectCable() {
    if (!state.room) { disconnectCable(); return; }
    const code = state.room.code;
    disconnectCable();
    state.cable.status = 'idle';
    connectCable(code);
  }

  function connectMatchCable(match) {
    const matchId = match && match.id;
    // Participants AND late-joining spectators subscribe: the server marks
    // spectators itself and refuses their direction intents.
    if (!matchId || !consumer || !state.room || !state.member) {
      disconnectMatchCable();
      return;
    }
    if (matchSubscription && matchSubscriptionId === matchId) return;
    disconnectMatchCable();
    matchSubscriptionId = matchId;
    // A fresh subscription is always seeded with a complete snapshot; drop any
    // frame from a previous round so its match id cannot shadow the new one.
    gameRenderer?.reset();
    state.gameSnapshot = null;
    if (el.results) el.results.hidden = true;
    matchSubscription = consumer.subscriptions.create(
      { channel: 'MatchChannel', match: matchId },
      {
        connected() {
          renderGame();
          startMatchHeartbeat();
          // The seed snapshot follows immediately; this also refreshes the
          // server-side input sequence mirror after a gap.
          refresh();
        },
        disconnected() {
          gameRenderer?.discardPendingFrames();
          stopMatchHeartbeat();
          setBrawlConn('lost', 'Connection lost — reconnecting… your snake may be frozen for up to 30s.');
        },
        rejected() {
          stopMatchHeartbeat();
          setBrawlConn('warn', 'This Brawl is no longer available.');
        },
        received(message) { onMatchMessage(message); },
      },
    );
  }

  // One heartbeat per tab. Several tabs therefore keep the player connected as
  // long as ANY of them beats; only all-tabs-silent starts the server grace.
  function startMatchHeartbeat() {
    state.liveHudBudget.start();
    stopMatchHeartbeat();
    matchHeartbeatTimer = window.setInterval(() => {
      if (matchSubscription && consumer?.connection?.isOpen?.()) {
        matchSubscription.perform('heartbeat');
      }
    }, 10_000);
  }

  function stopMatchHeartbeat() {
    if (matchHeartbeatTimer) { window.clearInterval(matchHeartbeatTimer); matchHeartbeatTimer = null; }
  }

  function disconnectMatchCable() {
    snapshotChunks.reset();
    gameRenderer?.setActive(false);
    gameRenderer?.discardPendingFrames();
    state.liveHudBudget.stop();
    stopMatchHeartbeat();
    stopFreezeCountdown();
    if (matchSubscription) {
      try { matchSubscription.unsubscribe(); } catch (err) { /* room teardown */ }
    }
    matchSubscription = null;
    matchSubscriptionId = null;
  }

  // Step 3: ask for one complete authoritative frame when remote playback loses
  // its tick chain. Throttled on the renderer side; sent over the existing
  // socket action, so no new endpoint or transport is introduced.
  function requestMatchResync(reason) {
    if (!matchSubscription) return;
    matchSubscription.perform('resync');
    if (el.gameInputStatus) {
      text(el.gameInputStatus, `Remote history gap (${reason}) — re-synchronised from the server.`);
      el.gameInputStatus.dataset.kind = 'warn';
    }
  }

  function onMatchMessage(message) {
    if (!message || Number(message.m || message.match) !== Number(state.match && state.match.id)) return;
    if (message.type === 'movement') {
      // Compact tick-ordered movement: heads, lengths and scalars only. The
      // renderer rebuilds each body from its own confirmed history, so a wrong
      // or missing link is refused there and recovered with a full snapshot
      // rather than rendered.
      gameRenderer?.acceptMovement(message);
      return;
    }
    if (message.type === 'snapshot_chunk') {
      const full = snapshotChunks.receive(message, Number(state.match.id), state.gameSnapshot?.t ?? -1);
      if (full) onMatchMessage(full); // one complete authoritative frame only
      return;
    }
    if (message.type === 'snapshot') snapshotChunks.reset();
    if (message.type === 'connection') {
      const ownId = state.member?.match_participant_id;
      if (!ownId || Number(message.participant) !== Number(ownId)) return;
      if (message.spectator) { markSpectating(); return; }
      if (message.state === 'frozen' || message.state === 'disconnected') {
        showGraceCountdown(message.grace_deadline_at);
      } else if (message.state === 'resumed' || message.state === 'connected') {
        markResumed();
        refresh(); // re-read the authoritative sequence mirror
      } else if (message.state === 'unattended') {
        stopFreezeCountdown();
        setBrawlConn('warn', 'Grace expired — your snake keeps moving on its own. Reconnect to take control.');
        refresh();
      }
      return;
    }
    if (message.type === 'interrupted') {
      stopFreezeCountdown();
      setBrawlConn('warn', 'This Brawl was interrupted — no result was recorded. The room is back in the lobby.');
      refresh();
      return;
    }
    if (message.type === 'snapshot') {
      const prior = state.gameSnapshot;
      if (typeof message.spectator === 'boolean') {
        state.match = { ...(state.match || {}), spectator: message.spectator };
      }
      if (!gameRenderer || !gameRenderer.accept(message)) return;
      const died = newlyEliminated(prior, message);
      state.gameSnapshot = message;
      state.match = { ...(state.match || {}), id: Number(message.m), status: message.s,
                      tick: message.t, columns: message.b?.c, rows: message.b?.r };
      state.liveHudBudget.add('movement-metrics', renderMovementDiagnostics);
      state.liveHudBudget.add('tick', () => {
      text(el.gameTick, `Tick ${state.gameSnapshot?.t}`);
      // No aria-live announcement of every tick. The board is visible and
      // the state is authoritative; only connection changes need speech.
    });
      if (el.game) el.game.hidden = false;
      // Authoritative own-state mirror: useful when debugging a live client
      // (and in tests). Never used to steer or to compute game state.
      const own = message.p?.find((player) => player.i === state.member?.match_participant_id);
      // SAME field names as the snapshot player (a, fr, d). An earlier cache
      // used alive/frozen/direction, so the send guard's `!own.a` never matched
      // and every steering intent was dropped client-side.
      state.controls = own ? { id: own.i, a: own.a, fr: own.fr, d: own.d } : null;
      if (el.gameStatus && !state.match?.spectator && message.s === 'running') {
        if (!own?.a) text(el.gameStatus, 'Eliminated · watching the Brawl');
        else if (own.fr) text(el.gameStatus, 'Your snake is frozen · reconnecting');
        else text(el.gameStatus, 'Live · your snake is controlled by the server');
      }
      if (el.game && own) {
        // Read-only diagnostics do not need a new DOM mutation per frame. Only
        // meaningfully changed own state may touch a data attribute.
        if (el.game.dataset.ownDirection !== own.d) el.game.dataset.ownDirection = own.d;
        if (el.game.dataset.ownScore !== String(own.sc)) el.game.dataset.ownScore = String(own.sc);
        if (el.game.dataset.ownAlive !== String(own.a)) el.game.dataset.ownAlive = String(own.a);
      }
      el.game?.setAttribute('data-tick', String(message.t));
      const ownId = state.member?.match_participant_id;
      // Mirror the SERVER's frozen/spectator state on the non-blocking banner.
      if (own) {
        if (!own.a) {
          markSpectating();
        } else if (own.fr) {
          showGraceCountdown(Number.isFinite(own.gu) ? new Date(own.gu).toISOString() : null);
        } else if (state.matchLink === 'lost' || state.matchLink === 'warn') {
          markResumed();
        } else if (!state.match?.spectator) {
          setBrawlConn('live', 'Live');
        }
      }
      if (died.includes(ownId)) {
        const entry = message.q?.find((row) => row.i === ownId);
        showEliminationOverlay(document, {
          name: 'Your snake',
          score: entry?.sc,
          placement: entry?.p,
          total: message.q?.length,
        });
      }
      if (el.gameStatus && message.s === 'completed') {
        state.liveHudBudget.flush('tick');
        const placement = message.q?.find((entry) => entry.i === ownId)?.p;
        text(el.gameStatus, placement ? `Brawl finished · place ${placement}` : 'Brawl finished');
        renderResults();
      } else if (el.gameStatus && state.match?.spectator) {
        text(el.gameStatus, 'Spectating the live Brawl.');
      }
      return;
    }
    if (message.type === 'waiting') {
      if (el.gameStatus) el.gameStatus.textContent = 'Starting the authoritative Brawl…';
      return;
    }
    if (message.type === 'input_ack') {
      if (Number(message.participant) !== Number(state.member?.match_participant_id)) return;
      // An ack only ever means QUEUED. The predictor keeps the envelope pending
      // until input_applied or a frame whose "is" covers it retires it, so a
      // round trip can never be mistaken for server confirmation.
      if (message.accepted) gameRenderer?.noteInputQueued(Number(message.seq));
      else gameRenderer?.noteInputRejected(Number(message.seq), message.reason);
      if (message.accepted) {
        if (el.gameInputStatus) {
          text(el.gameInputStatus, `Direction queued (sequence ${message.seq ?? '–'}).`);
          if (el.gameInputStatus.dataset.kind) el.gameInputStatus.removeAttribute('data-kind');
        }
      } else if (el.gameInputStatus) {
        el.gameInputStatus.textContent = `Direction not accepted (${message.reason || 'resync'}).`;
        el.gameInputStatus.dataset.kind = 'error';
        // A command that raced the disconnect is discarded by the server; the
        // banner explains why instead of silently dropping input.
        if (message.reason === 'frozen' || message.reason === 'disconnected') {
          setBrawlConn('lost', 'Connection lost — input paused until the server sees you again.');
        }
      }
      return;
    }
    if (message.type === 'input_applied' &&
        Number(message.participant) === Number(state.member?.match_participant_id)) {
      if (Number.isInteger(message.seq)) state.inputSeq = Math.max(state.inputSeq, message.seq);
      noteRoundTrip(message.seq);
      gameRenderer?.noteInputApplied(Number(message.seq), Number(message.tick));
      if (el.gameInputStatus) {
        text(el.gameInputStatus, `Direction applied to the server queue for tick ${message.tick} (sequence ${message.seq}).`);
        if (el.gameInputStatus.dataset.kind) el.gameInputStatus.removeAttribute('data-kind');
      }
      return;
    }
    if (message.type === 'input_rejected' &&
        Number(message.participant) === Number(state.member?.match_participant_id)) {
      if (Number.isInteger(message.seq)) state.inputSeq = Math.max(state.inputSeq, message.seq);
      noteRoundTrip(message.seq);
      gameRenderer?.noteInputRejected(Number(message.seq), message.reason);
      if (el.gameInputStatus) {
        el.gameInputStatus.textContent = `Direction not accepted (${message.reason}).`;
        el.gameInputStatus.dataset.kind = 'error';
      }
    }
  }

  // Only a direction name leaves the browser. The server resolves identity,
  // validates the tick/seq envelope, and the simulator applies it before a tick.
  // Measured RTT (input round trip) with a light EWMA, plus the spread of recent
  // samples as a jitter estimate. Both are labelled "measured" in diagnostics;
  // the playback buffer's own jitter figure is derived from arrival spacing and
  // is labelled as an estimate.
  function noteRoundTrip(seq) {
    const sentAt = state.inputSentAt.get(Number(seq));
    if (sentAt === undefined) return;
    state.inputSentAt.delete(Number(seq));
    const rtt = Math.max(0, performance.now() - sentAt);
    state.rttMs = state.rttMs === null ? rtt : state.rttMs * 0.8 + rtt * 0.2;
    state.rttSamples.push(rtt);
    if (state.rttSamples.length > 12) state.rttSamples.shift();
  }

  function rttJitter() {
    if (state.rttSamples.length < 2) return null;
    const sorted = state.rttSamples.slice().sort((a, b) => a - b);
    return Math.round(sorted[sorted.length - 1] - sorted[0]);
  }

  function sendDirection(direction) {
    const snapshot = state.gameSnapshot;
    const ownId = state.member?.match_participant_id;
    const own = state.controls && state.controls.id === ownId
      ? state.controls : snapshot?.p?.find((player) => player.i === ownId);
    if (!matchSubscription || !ownId || !snapshot || snapshot.s !== 'running' || !own?.a) return;
    // Frozen/dead/spectating snakes never send: the server would reject these
    // anyway, and any pre-disconnect command still in flight is discarded on
    // the server when the socket is released.
    if (own.fr || state.match?.spectator) return;
    // Every intent is sent. The server de-duplicates the direction queue
    // itself and the input path no longer takes a lock, so swallowing a
    // keypress here could only ever lose a real turn.
    gameRenderer?.expedite(); // display pacing never waits on a local turn
    state.inputSeq = Math.max(state.inputSeq, Number(state.member.last_input_seq || 0)) + 1;
    const seq = state.inputSeq;
    // 1-3. Capture immediately, assign the unique sequence, and hand it to the
    //      predictor, which associates it with the tick it intends to move on
    //      (never a confirmed one) and tells us what it decided.
    const prediction = gameRenderer?.predict(direction, seq) || null;
    // A real, measured round trip: this is the only place the browser learns how
    // long the server actually took to answer one of its own packets. It is
    // reported in diagnostics as measured, never as a guess.
    state.inputSentAt.set(seq, performance.now());
    while (state.inputSentAt.size > 24) state.inputSentAt.delete(state.inputSentAt.keys().next().value);
    // 4. Send. Sent regardless of the local verdict: a locally refused
    //    duplicate/reversal is still the server's call, and a horizon refusal is
    //    a PIXEL policy, not an input policy.
    matchSubscription.perform('input', {
      v: 1, type: 'input', match: state.match.id,
      tick: Number(snapshot.t), seq, dir: direction,
    });
    // 5-6. The predicted tick is already in the local queue, so the next paint
    //      shows it — no network wait. Only say "predicted" when it is true.
    if (el.gameInputStatus && prediction && !prediction.rejectedReason) {
      text(el.gameInputStatus,
        `Predicted ${direction} on tick ${prediction.scheduledTick} (sequence ${seq}) — awaiting the server.`);
      if (el.gameInputStatus.dataset.kind) el.gameInputStatus.removeAttribute('data-kind');
    }
  }

  function onGameKeydown(event) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target;
    if (target?.closest?.('input,textarea,select,button,[contenteditable="true"],dialog,[role="dialog"]')) return;
    const directions = { ArrowUp: 'up', w: 'up', W: 'up', ArrowDown: 'down', s: 'down', S: 'down',
                         ArrowLeft: 'left', a: 'left', A: 'left', ArrowRight: 'right', d: 'right', D: 'right' };
    const direction = directions[event.key];
    if (!direction || !state.match || state.match.status !== 'running') return;
    event.preventDefault();
    sendDirection(direction);
  }

  function onCableMessage(message) {
    if (!message) return;
    if (typeof message.v !== 'number') {
      // A pre-rejection explanation from RoomChannel#reject_with.
      if (message.error) { state.cable.reason = message.message || message.error; }
      return;
    }
    if (!state.synced) { // window between (re)connect and authoritative snapshot
      state.buffered.push(message);
      if (state.buffered.length > 50) state.buffered.shift();
      return;
    }
    if (message.v <= state.version) return; // stale replay — rejected by version
    scheduleRefresh(); // next event or a gap: snapshot is the source of truth
  }

  // One refresh at a time: a burst of events collapses into a single request.
  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      refresh().then(drainBuffered);
    }, 100);
  }

  function drainBuffered() {
    state.synced = true;
    const buffered = state.buffered;
    state.buffered = [];
    const newer = buffered.filter((message) => message.v > state.version);
    if (newer.length) scheduleRefresh(); // we were behind; the snapshot heals it
  }

  // The server refused this subscription (unknown code, disbanded room, seat
  // gone). RoomChannel transmits the reason first; ask the HTTP API too so the
  // message is right even if that transmit raced the rejection.
  function explainRejection(code) {
    api(`/api/rooms/${code}`).then((out) => {
      const reason = state.cable.reason
        || (out.json && out.json.error)
        || 'This room is unavailable right now.';
      const stillMember = out.ok && out.json.room && out.json.room.members;
      if (stillMember) return; // race resolved in our favour; stay put
      flash(reason, 'error');
      state.room = null;
      state.member = null;
      state.version = 0;
      render();
      history.replaceState({}, '', '/multiplayer');
    }).catch(() => flash('Lost contact with the room.', 'error'));
  }

  // ---- sharing panel: share, copy, locally drawn QR (step 5) ------------------

  function shareFeedback(message, kind) {
    if (!el.shareFeedback) return;
    el.shareFeedback.textContent = message || '';
    el.shareFeedback.setAttribute('data-kind', kind || 'info');
  }

  // Native Web Share (progressive enhancement — the button only shows when
  // the browser offers it). Copy Link remains for everyone else.
  async function shareRoom() {
    if (!state.invite) return;
    try {
      await navigator.share({
        title: 'Join my Next Level Snake room',
        text: state.room ? `Room ${state.room.code}` : 'Next Level Snake',
        url: state.invite,
      });
      shareFeedback('Shared — choose where to send it.', 'ok');
    } catch (err) {
      if (err && err.name === 'AbortError') shareFeedback('Share canceled.', 'info');
      else shareFeedback("Couldn't open the share sheet — use Copy Link instead.", 'error');
    }
  }

  // Draws the invitation QR straight onto a canvas with window.qrcode
  // (qrcode-generator, vendored). Fully local: the URL never leaves the page.
  // White ground and near-black modules are deliberate — scanners need that
  // contrast, so the QR stays theme-independent while the rest of the panel
  // follows the active theme.
  function renderQr() {
    const url = state.invite;
    if (!url || !el.qrCanvas) return false;
    if (typeof window.qrcode !== 'function') {
      shareFeedback('The QR generator is unavailable — use Copy Link instead.', 'error');
      return false;
    }
    try {
      const qr = window.qrcode(0, 'M'); // 0 = pick the smallest version that fits
      qr.addData(url);
      qr.make();
      const quiet = 4;                  // QR-spec quiet zone, in modules
      const count = qr.getModuleCount();
      const cell = Math.max(2, Math.floor(224 / (count + quiet * 2)));
      const size = cell * (count + quiet * 2);
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const canvas = el.qrCanvas;
      const ctx = canvas.getContext('2d');
      if (!ctx) return false;
      canvas.width = size * dpr;
      canvas.height = size * dpr;
      canvas.style.width = `${size}px`;
      canvas.style.height = `${size}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#0b0d0f';
      for (let row = 0; row < count; row += 1) {
        for (let col = 0; col < count; col += 1) {
          if (qr.isDark(row, col)) {
            ctx.fillRect((col + quiet) * cell, (row + quiet) * cell, cell, cell);
          }
        }
      }
      return true;
    } catch (err) {
      shareFeedback('Could not draw the QR code — the link is still copyable.', 'error');
      return false;
    }
  }

  function toggleQr() {
    if (!el.qrBox || !el.qrToggle) return;
    const showing = el.qrBox.hidden;
    if (showing && !renderQr()) return;
    el.qrBox.hidden = !showing;
    el.qrToggle.setAttribute('aria-expanded', String(showing));
    el.qrToggle.textContent = showing ? 'Hide QR' : 'Show QR';
    shareFeedback(showing ? 'QR code ready — scan it with a camera.' : '', showing ? 'info' : '');
  }

  // ---- built-in QR scanner (step 5) ------------------------------------------
  //
  // Camera frames are decoded on this device: native BarcodeDetector when the
  // browser has it, the vendored jsQR fallback otherwise. Nothing is uploaded.
  //
  // Every exit path releases the camera: success (before navigating), decode
  // failures keep scanning until the user cancels, and cancel/close/Escape all
  // funnel through the dialog's close event -> stopScanner().
  const scanner = { stream: null, raf: 0, last: 0, busy: false, closed: true, decoder: null, canvas: null, ctx: null };

  function scanStatus(message, kind) {
    if (!el.scanStatus) return;
    el.scanStatus.textContent = message;
    el.scanStatus.setAttribute('data-kind', kind || 'info');
  }

  function openScanner() {
    if (!el.scanDlg) return;
    stopScanner(); // never stack a second camera session
    scanStatus('Starting camera…', 'info');
    if (el.scanStage) el.scanStage.hidden = true;
    if (el.scanDlg.showModal && !el.scanDlg.open) el.scanDlg.showModal();
    startCamera();
  }

  function closeScanner() {
    // Release synchronously: a dialog's close event fires asynchronously, and
    // a camera should die the instant the user cancels. The 'close' listener
    // below still covers Escape (which never goes through here) — stopScanner
    // is idempotent, so running twice is intended.
    stopScanner();
    if (el.scanDlg && el.scanDlg.open) el.scanDlg.close();
  }

  function stopScanner() {
    scanner.closed = true;
    if (scanner.raf) { window.cancelAnimationFrame(scanner.raf); scanner.raf = 0; }
    if (scanner.stream) {
      scanner.stream.getTracks().forEach((track) => {
        try { track.stop(); } catch (err) { /* already ended */ }
      });
      scanner.stream = null;
    }
    if (el.scanVideo) {
      try { el.scanVideo.srcObject = null; } catch (err) { /* detached */ }
    }
    if (el.scanStage) el.scanStage.hidden = true;
    scanner.busy = false;
    scanner.decoder = null;
  }

  async function startCamera() {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      scanStatus(window.isSecureContext === false
        ? 'The camera needs a secure (https) connection. Open this page over https, or paste the code instead.'
        : "This browser can't open a camera from this page. Paste the invitation code instead.", 'error');
      return;
    }
    try {
      scanner.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
    } catch (err) {
      scanner.stream = null;
      const name = err && err.name;
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
        scanStatus('Camera permission denied. Allow camera access in your browser settings, or paste the invitation code instead.', 'error');
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
        scanStatus('No camera found on this device. Paste the invitation code instead.', 'error');
      } else {
        scanStatus("Couldn't open the camera. Paste the invitation code instead.", 'error');
      }
      return;
    }
    pickDecoder();
    if (!scanner.decoder) return; // status already set by pickDecoder

    el.scanVideo.srcObject = scanner.stream;
    try { await el.scanVideo.play(); } catch (err) { /* autoplay muted video is allowed; if not, frames still flow once playing */ }
    if (el.scanStage) el.scanStage.hidden = false;
    scanStatus('Point the camera at a QR code…', 'info');
    scanner.closed = false;
    scanner.last = 0;
    scanner.raf = window.requestAnimationFrame(scanLoop);
  }

  function pickDecoder() {
    if (typeof window.BarcodeDetector === 'function') {
      try {
        scanner.decoder = { kind: 'native', api: new window.BarcodeDetector({ formats: ['qr_code'] }) };
        return;
      } catch (err) { /* partial implementation -> fall through to jsQR */ }
    }
    if (typeof window.jsQR === 'function') {
      scanner.canvas = scanner.canvas || document.createElement('canvas');
      scanner.ctx = scanner.canvas.getContext('2d', { willReadFrequently: true });
      if (scanner.ctx) {
        scanner.decoder = { kind: 'jsqr' };
        scanStatus('Point the camera at a QR code…', 'info');
        return;
      }
    }
    scanner.decoder = null;
    scanStatus('No QR reader is available in this browser. Paste the invitation code instead.', 'error');
  }

  function scanLoop(now) {
    if (scanner.closed) return;
    scanner.raf = window.requestAnimationFrame(scanLoop);
    if (!scanner.decoder || scanner.busy) return;
    if (now - scanner.last < 120) return; // ~8 checks per second is plenty
    scanner.last = now;
    const video = el.scanVideo;
    if (!video || video.readyState < 2) return;
    scanner.busy = true;
    decodeFrame(video).then((raw) => {
      scanner.busy = false;
      if (raw) handleScanned(raw);
    }).catch(() => { scanner.busy = false; });
  }

  async function decodeFrame(video) {
    if (scanner.decoder.kind === 'native') {
      try {
        const codes = await scanner.decoder.api.detect(video);
        return codes && codes.length ? (codes[0].rawValue || null) : null;
      } catch (err) {
        // This browser advertises the API but refuses to use it: degrade to jsQR.
        pickDecoder();
        if (scanner.decoder && scanner.decoder.kind === 'jsqr') return decodeFrame(video);
        throw err;
      }
    }
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return null;
    const scale = Math.min(1, 640 / width); // cap decode cost on phones
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    scanner.canvas.width = w;
    scanner.canvas.height = h;
    scanner.ctx.drawImage(video, 0, 0, w, h);
    const frame = scanner.ctx.getImageData(0, 0, w, h);
    const found = window.jsQR(frame.data, w, h);
    return found ? found.data : null;
  }

  // Allowlist for scanned payloads: only this application's room routes on the
  // page's own origin or the server's configured public origin. Anything else
  // (other sites, javascript:, data:, look-alike paths) is rejected outright.
  function roomUrlFor(raw) {
    if (typeof raw !== 'string') return null;
    let url;
    try { url = new URL(raw.trim()); } catch (err) { return null; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

    const allowed = new Set([window.location.origin]);
    if (state.configOrigin && /^https?:\/\//.test(state.configOrigin)) {
      allowed.add(state.configOrigin.replace(/\/+$/, ''));
    }
    const origin = url.origin;
    if (!allowed.has(origin)) return null;

    const path = url.pathname.replace(/\/+$/, '');
    if (path === '/multiplayer') return origin === window.location.origin ? path : origin + path;
    if (/^\/multiplayer\/[A-Za-z0-9-]{4,24}$/.test(path)) {
      return origin === window.location.origin ? path : origin + path;
    }
    return null;
  }

  function handleScanned(raw) {
    const target = roomUrlFor(raw);
    if (!target) {
      scanStatus("That QR code isn't a Next Level Snake invitation.", 'error');
      return; // keep the camera running so they can aim at the right code
    }
    const here = window.location.pathname.replace(/\/+$/, '') || '/';
    if (target === window.location.origin + here || target === here) {
      closeScanner();
      shareFeedback("That's this room's own code.", 'info');
      return;
    }
    stopScanner(); // release the camera before navigating away
    if (el.scanDlg && el.scanDlg.open) el.scanDlg.close();
    window.location.assign(target); // SAME tab, never window.open
  }

  // ---- wiring -----------------------------------------------------------------

  function on(node, event, handler) { if (node) node.addEventListener(event, handler); }

  if (el.movementPacing && gameRenderer) {
    el.movementPacing.checked = gameRenderer.cadence.enabled;
    el.movementPacing.addEventListener('change', () => {
      gameRenderer.setCadenceEnabled(el.movementPacing.checked);
      renderMovementDiagnostics();
    });
  }
  el.movementDetails?.addEventListener('toggle', () => {
    if (movementDiagnosticsTimer) clearInterval(movementDiagnosticsTimer);
    movementDiagnosticsTimer = null;
    renderMovementDiagnostics();
    // Also samples during a transport stall; this never pings the server.
    if (el.movementDetails.open) movementDiagnosticsTimer = setInterval(() => {
      if (!document.hidden) renderMovementDiagnostics();
    }, 1000);
  });
  window.addEventListener('pagehide', () => {
    if (movementDiagnosticsTimer) clearInterval(movementDiagnosticsTimer);
  });

  document.addEventListener('keydown', onGameKeydown);
  // Mobile steering. Two latency sources are removed here:
  //   * a swipe turns the snake as SOON AS the drag crosses the threshold,
  //     instead of waiting for the finger to lift (and a lift can be delayed by
  //     the browser gesture recognizer, a scroll, or a cancelled pointer);
  //   * the steering pad fires on pointerdown, not click, so a tap is not
  //     held back by tap-delay/double-tap-zoom heuristics.
  // touchmove is registered non-passive on the canvas only, so a swipe never
  // scrolls the page; everywhere else the page still scrolls normally.
  // The steering geometry lives in swipe-steering.js so the exact finger path
  // is testable. The essential property: the origin is re-anchored after every
  // emitted turn, so a fast L-shaped swipe (down then left) commits BOTH turns
  // instead of waiting for the second leg to out-travel the first.
  const swipes = new SwipeSteering({ send: (direction) => sendDirection(direction) });

  on(el.gameCanvas, 'pointerdown', (event) => {
    if (event.pointerType === 'mouse') return;
    swipes.begin({ x: event.clientX, y: event.clientY });
    if (el.gameCanvas.setPointerCapture) { try { el.gameCanvas.setPointerCapture(event.pointerId); } catch (err) { /* unsupported */ } }
  });
  on(el.gameCanvas, 'pointermove', (event) => {
    if (event.pointerType === 'mouse') return;
    swipes.move({ x: event.clientX, y: event.clientY });
  });
  on(el.gameCanvas, 'pointerup', (event) => {
    // A short flick that never crossed the threshold mid-drag still counts, and
    // so does the second leg of a very fast L-swipe.
    swipes.end({ x: event.clientX, y: event.clientY });
  });
  on(el.gameCanvas, 'pointercancel', () => { swipes.cancel(); });
  if (el.gameCanvas) {
    // iOS Safari without touch-action support still needs a preventDefault to
    // stop the arena swipe from scrolling/zooming the page.
    el.gameCanvas.addEventListener('touchmove', (event) => { if (swipes.active) event.preventDefault(); }, { passive: false });
  }

  document.querySelectorAll('[data-game-dir]').forEach((button) => {
    // pointerdown: instant on touch. click is kept for keyboard/AT activation.
    button.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse') return;
      event.preventDefault();
      sendDirection(button.dataset.gameDir);
    });
    button.addEventListener('click', (event) => {
      if (event.detail === 0) sendDirection(button.dataset.gameDir); // keyboard Enter/Space
    });
  });

  on(el.create, 'click', () => createRoom(false));
  on(el.join, 'click', () => joinRoom(false));
  on(el.readyToggle, 'click', () => roomAction('ready', { ready: !(state.member && state.member.ready) }));
  on(el.leave, 'click', () => {
    roomAction('leave').then(() => {
      flash('You left the room. Your seat is kept for a while if you come back.', 'info');
      history.replaceState({}, '', '/multiplayer');
    });
  });
  on(el.disband, 'click', () => {
    if (!window.confirm('Disband this room for everyone?')) return;
    roomAction('disband').then(() => {
      flash('Room disbanded.', 'info');
      history.replaceState({}, '', '/multiplayer');
    });
  });
  el.gameTabs?.querySelectorAll('[data-game-pane]').forEach((button) => {
    button.addEventListener('click', () => showGamePane(button.dataset.gamePane));
  });
  on(el.boardViewBtn, 'click', () => { if (el.game) el.game.hidden = false; showGamePane('board'); });
  on(el.followSelect, 'change', () => {
    const value = el.followSelect.value ? Number(el.followSelect.value) : null;
    gameRenderer?.setFollow(value);
    const player = state.gameSnapshot?.p?.find((entry) => entry.i === value);
    if (el.gameStatus && player) el.gameStatus.textContent = `Following ${player.n} · ${player.sc} points`;
  });
  on(el.spectateBtn, 'click', () => {
    // Stay on the board as a spectator: keep the socket, stop steering UI.
    hideEliminationOverlay(document);
    showGamePane('board');
    if (el.gameStatus) el.gameStatus.textContent = 'Spectating the live Brawl.';
  });
  on(el.lobbyViewBtn, 'click', () => showGamePane('lobby'));
  on(el.start, 'click', () => {
    roomAction('start').then((out) => {
      if (out && out.ok) flash(out.json.notice || 'Ready to start.', 'info');
    });
  });
  on(el.again, 'click', () => {
    // Step 10 fix: ONE server action returns the finished room to lobby
    // semantics and freezes the next match in the same lock. Every client
    // switches because the room snapshot's match id changed — no refresh.
    roomAction('start').then((out) => {
      if (out && out.ok) flash(out.json.notice || 'Next Brawl started.', 'info');
    });
  });

  // A tab returning to the foreground proves life immediately (and is also a
  // chance to re-subscribe if the tunnel dropped while hidden).
  // A phone suspends timers and can silently drop the WebSocket while a tab is
  // backgrounded; some browsers never fire the close handler. On return, prove
  // life immediately and rebuild whatever socket actually died, so a player who
  // tabbed away resumes instead of watching a stale board.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const socketDead = !consumer || !consumer.connection || !consumer.connection.isOpen?.();
    if (socketDead) {
      if (state.room) connectCable(state.room.code); // re-derives identity server-side
      refresh();
      return;
    }
    if (subscription) subscription.perform('heartbeat');
    if (matchSubscription) matchSubscription.perform('heartbeat');
    refresh();
  });

  // Sharing panel (step 5): native share, always-available copy with visible
  // feedback, and a locally drawn QR code.
  on(el.shareBtn, 'click', () => shareRoom());
  on(el.copyCode, 'click', () => {
    if (state.room) copyWithFeedback(state.room.code, el.copyCode, 'Code copied.');
  });
  on(el.copyLink, 'click', () => {
    if (state.invite) copyWithFeedback(state.invite, el.copyLink, 'Link copied.');
  });
  on(el.qrToggle, 'click', () => toggleQr());

  // QR scanner: both entry points (landing card and share panel).
  on(el.scanOpen, 'click', () => openScanner());
  on(el.scanOpenRoom, 'click', () => openScanner());
  on(el.scanCancel, 'click', () => closeScanner());
  on(el.scanClose, 'click', () => closeScanner());
  if (el.scanDlg) {
    // Escape / any programmatic close releases the camera — this single event
    // covers every dismiss path the dialog offers.
    el.scanDlg.addEventListener('close', () => stopScanner());
  }

  // Typing a code and pressing Enter joins, like every other form on the site.
  on(el.code, 'keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); joinRoom(false); }
  });

  on(el.code, 'input', () => {
    const cleaned = cleanCode(el.code.value);
    if (el.code.value !== cleaned) el.code.value = cleaned;
    previewCode(cleaned);
  });
  on(el.name, 'change', () => store(NAME_KEY, desiredName()));

  on(el.signIn, 'click', () => openAuth('login'));
  on(el.createAccount, 'click', () => openAuth('create'));
  on(el.signInTop, 'click', () => openAuth('login'));
  on(el.createTop, 'click', () => openAuth('create'));
  if (el.themes) {
    el.themes.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-theme]');
      if (button) pickTheme(button.dataset.theme);
    });
  }
  markThemes();
  on($('auth-tab-login'), 'click', () => setAuthMode('login'));
  on($('auth-tab-create'), 'click', () => setAuthMode('create'));
  on($('auth-close'), 'click', () => el.authDialog && el.authDialog.close());
  on($('form-login'), 'submit', (event) => {
    event.preventDefault();
    submitAuth('/api/auth/login', event.target, 'auth-error-login');
  });
  on($('form-create'), 'submit', (event) => {
    event.preventDefault();
    submitAuth('/api/auth/signup', event.target, 'auth-error-create');
  });

  const closeConfirm = (cancelled) => {
    const onCancel = state.cancelled;
    state.pending = null;
    state.cancelled = null;
    if (el.confirm && el.confirm.open) el.confirm.close();
    if (cancelled && onCancel) onCancel();
  };
  on(el.confirmOk, 'click', () => {
    const retry = state.pending;
    closeConfirm(false);
    if (retry) retry();
  });
  on(el.confirmCancel, 'click', () => closeConfirm(true));
  on(el.confirmClose, 'click', () => closeConfirm(true));

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      state.liveHudBudget.start();
      if (state.room) {
        window.MatrixRain?.set(false);
        refresh();
      }
    } else {
      state.liveHudBudget.stop();
    }
  });

  // ---- boot --------------------------------------------------------------------
  // A normal refresh lands here: ask the server what room this browser is in,
  // and only fall back to the code in the URL when it is in none.
  refresh().then(() => {
    const code = cleanCode(root.dataset.roomCode);
    if (state.room) {
      // Already seated, and someone sent a link to a *different* room: ask
      // before giving up the seat (requirement 12), and keep the URL honest.
      if (code && code !== state.room.code) {
        confirmSwitch(
          `You are in room ${state.room.code}. Leave it and join ${code}?`,
          () => joinCode(code, true),
          () => history.replaceState({}, '', `/multiplayer/${state.room.code}`),
        );
      }
    } else if (code) {
      if (el.code) el.code.value = code;
      previewCode(code);
      flash('Enter a name, then join this room.', 'info');
      if (el.name && !el.name.value) el.name.focus();
    }
    poll();
  });
}
