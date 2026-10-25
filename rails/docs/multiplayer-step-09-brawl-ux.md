# Step 9 — Brawl scoreboards, elimination effects, and spectators

Base: `c0ab612` (step 8 review). No engine rule changes, no new tables, no
migrations. The authoritative simulation, ranking and snapshot protocol from
steps 7–8 are reused untouched; this step presents them.

## Live leaderboard

The board pane keeps the compact scoreboard (`#mp-game-scores`); the Standings
tab shows a full table built by `buildResultsTable` (shared by the final
results). Every row carries, in server-standing order:

* placement (1., 2., …) from the snapshot's `q` array — the server's
  `Simulation::Ranking` order: **points, then survival ticks, then longest
  snake, then participant id**;
* solid color dot + username (names always supplement color);
* points, snake length, survival time (`m:ss` from ticks × the match's
  `tick_ms`), and an alive/eliminated tag;
* the current player's row highlighted (`is-you`).

Eliminated players stay visible with their frozen final score. The scoreboard
rebuilds from each authoritative snapshot; clients never sort or score.

## Elimination presentation

The server marks elimination immediately (`alive=false`, final score, survival
ticks, ending body, reason) and the dead body stays in every later snapshot.
On the first snapshot where a player flips alive → dead, the renderer spawns
**pixel dust locally**: up to 64 body cells × 3 puffs, in the victim's own
color, with gravity settle and ~2.5 s fade. Particle coordinates are derived
from snapshot cells and are never transmitted. Under
`prefers-reduced-motion: reduce` no particles spawn — the dimmed body and
updated scoreboard carry the information instead.

When the viewer's own snake dies, an overlay offers **Spectate Brawl**
(dismiss, keep watching), **Return to Lobby** (client-side pane switch, seat
kept), and a disabled **Duel (soon)** entry point.

## Spectating

* Late room joiners (active members without a frozen seat) subscribe to
  `MatchChannel` as spectators: same snapshots, every direction refused
  (`spectator` reason). Spectator is a server-derived flag on each seed
  snapshot, never a client claim.
* The follow picker lists living players; choosing one ring-highlights their
  head and names them in the status line. "Whole board" clears it.
* Board / Standings / Lobby tabs and Back to Board switch panes client-side
  only: no membership, socket or simulation state changes, so navigation can
  never drop a seat.

## Final results

When the snapshot status is `completed`, the results table lists every
participant with placement, color, name, points, survival time, longest snake
and final status. The winner is placement #1 from the server — points first,
even if they died earlier.

## Tests

* `test/simulation/elimination_test.rb` (standalone, no Rails): final-stat
  freezing, same-tick simultaneous deaths ranked by points, full-tie order,
  tiebreak order, body preservation in checkpoints/snapshots.
* `test/models/final_results_test.rb`: persisted score/survival/longest/
  placement/winner and post-completion snapshot availability.
* `test/channels/match_channel_test.rb`: late-joiner spectator subscribe +
  snapshot flag + input refusal.
* `tests/browser/brawl-scoreboard.spec.mjs` (real Chromium + production
  Rails): live columns/status/rank/own-row, pane navigation without losing
  membership, dust spawn + final scores + overlay via the real modules,
  reduced-motion behavior, follow picker.
