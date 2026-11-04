# Responsive Brawl (step 11): a decisive local snake

Responsive Brawl is a **presentation strategy**, not a game mode and not a rule
set. A room's `mode` (`brawl`/`duel`) still decides food and whether snakes are
solid. Classic is unchanged: the server simulates every step from direction
inputs, and the browser paints those frames.

| | Classic Brawl (default) | Responsive Brawl |
| --- | --- | --- |
| Own snake | painted from the confirmed snapshot | **local and final**. One clock, one cell per `tick_ms`. A key changes the next cell. A packet never relocates this snake |
| Other snakes | painted from the confirmed snapshot | the cells that snake reported, played one tick behind the newest frame |
| Pellets, score, length | the confirmed snapshot | the server's pellet and score. A local bite grows and scores immediately, and is not counted twice when the server catches up |
| Wire | `{v,type,match,tick,seq,dir}` input, classic snapshot bytes | one `report` per step, and one complete snapshot per simulated tick |
| What the server decides | the whole step | that the reported cell is one orthogonal step, then food, score, and solid collisions. It does not pick a different corner |

The own snake and the server tick are **different clocks on purpose**. The
browser does not wait for the server tick, and it does not rewind when a frame
arrives. A report that is not one legal step is dropped and that snake holds.
There is no broader anti-cheat.

## Where the code lives

| Concern | File |
| --- | --- |
| Strategy as a room/match setting | `rails/app/models/room.rb`, `.../concerns/room_configuration.rb`, `rails/app/models/match.rb` |
| Local snake | `public/multiplayer/decisive.js` |
| Report intake | `MatchChannel#report`, `Match#accept_report!`, `match_inputs.head_cell` |
| Relay step | `Simulation::World#step!` when `presentation_strategy` is `responsive` |
| Food generation and eaten events | `rails/app/lib/simulation/food.rb`, `world.rb`, `protocol.rb` |
| One frame per simulated tick | `rails/app/models/match_runner.rb` |
| Remote playback | `public/multiplayer/playback.js` |
| Canvas | `public/multiplayer/game-renderer.js` |

## What you see

* Your snake seeds from the first snapshot, then steps every `tick_ms` even if
  you are not pressing a key. The next key is the next cell (no duplicate, no
  180, queue of 2), same rules as single player.
* Each step sends the cell you entered. The server paints that cell for
  everyone else on its own tick, one cell at a time. Your view is not delayed
  to match theirs.
* Pellets are the server's. When your head lands on your pellet you grow and
  score immediately. The report is how the server counts the point and
  respawns. Until that respawn arrives, the bitten cell is not drawn again,
  and a server score that catches up does not add the point a second time.
* A self-collision stops you locally and is the same cell the server eliminates
  on. A duel collision is still the server's call, so that death can show up
  one round trip later. The body you already drew is not teleported onto the
  server's copy.
* Disconnect freezes you, same as Classic. When grace expires a Responsive
  snake **holds** its last cell. It does not keep walking without you. Classic
  still does.

## What is not this

* No interpolation and no glide. Remotes are whole cells.
* No local clock that tries to land on the server's tick.
* Classic matches never receive a `report` and never relay poses. Their step
  and their snapshot bytes are the ones from before this change.

## Wire format

A Responsive step sends:

```json
{ "v": 1, "type": "report", "match": 1, "tick": 0, "seq": 1, "dir": "down", "c": 27 }
```

`c` is the board index just entered (`y * columns + x`). It is not accepted on
a Classic `input`. Unknown fields on either message are rejected.

Responsive matches broadcast `Protocol.encode` — a complete snapshot — for every
simulated tick, including each step of a catch-up. The additive fields are
`tick_ms`, `tm` (tick × tick_ms), food generation `g`, and `fe` (eaten events:
owner, generation, tick, cell). Classic snapshots do not include those keys,
and Classic food stays `{c, o}`.

`encode_movement` still exists and the Rails reconstruction test still proves a
contiguous compact chain is lossless. Responsive does not put that chain on the
wire: a compact frame cannot name which pellet generation was eaten.

**Classic matches never receive a movement frame and never receive the
Responsive fields.** Their byte stream is unchanged.

## Remote playback

Other snakes are `RemotePlayback`: confirmed frames, playhead at the newest
tick minus one, whole cells only. The own snake is not taken from that buffer.

## Tests

* `rails/test/simulation/decisive_relay_test.rb` — hold without a pose, one
  pose per tick, illegal and mismatched headings, eat, self-collision, wrap,
  1000 steps of heading-matched deltas, checkpointed poses, Classic still
  moves from a direction, `parse_report` vs `parse_input`.
* `rails/test/simulation/responsive_food_identity_test.rb` — generation
  increments once per reported eat, a catch-up keeps every tick, Classic
  snapshots gain no new keys.
* `rails/test/channels/movement_broadcast_test.rb` — Classic sends snapshots
  only; Responsive sends one complete snapshot per tick; each report moves
  only that snake.
* `tests/decisive.test.mjs` — turns at phases 0 / 0.25 / 0.5 / 0.99, straight
  steps with no packet, a snapshot that must not yank the head, food once,
  score not doubled, self-collision, reseed.
* `tests/grid-renderer.test.mjs` — own snake from the local clock, remotes from
  the confirmed tick, Classic paints the server frame.
* The older prediction module (`public/multiplayer/prediction.js`) is no longer
  what Responsive paints. Its unit tests still describe that module.

## What is NOT verifiable in a CI sandbox — please check on your server

1. Two browsers on a real link: your turn is the next cell, and your friend's
   view of you is about one tick behind and still one cell at a time.
2. A duel head-on. The server decides it, so the loser can see it a round
   trip late.
3. Physical mobile scanout. The logical step is one cell per `tick_ms`; the
   display refresh is the device's.
4. Run the new migration (`match_inputs.head_cell`) before booting the server.
