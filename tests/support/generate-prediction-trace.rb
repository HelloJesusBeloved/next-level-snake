# Generates the authoritative fixtures the browser prediction tests replay.
#
# This is NOT a second implementation of the rules to compare against: it runs
# the REAL engine (rails/app/lib/simulation, the same code the leased simulator
# owner steps inside a match) and records the exact Protocol v1 snapshots a
# browser would receive, including the Step-1 fields "is"/"it" and "strategy".
# The Node tests therefore verify the browser predictor against genuine server
# output — a rule change in Ruby shows up as a failing client test.
#
#   ruby tests/support/generate-prediction-trace.rb
#
# Pure Ruby: no Rails, no database, no WebSocket.
require "json"
require_relative "../../rails/app/lib/simulation"
%w[direction config rules rng food snake ranking world protocol scheduler supervisor].each do |file|
  require_relative "../../rails/app/lib/simulation/#{file}"
end

TICK_MS = 105
COLUMNS = 24
ROWS = 18
GROWTH = 1

def build(seed:, max_ticks: 400, mode: :brawl)
  config = Simulation::Config.new(columns: COLUMNS, rows: ROWS, seed: seed, max_ticks: max_ticks,
                                  mode: mode, growth: GROWTH, speed_level: nil, tick_ms: TICK_MS)
  people = [
    { id: 1, name: "Predicted", color_hex: "#FF3355", color_slot: 0 },
    { id: 2, name: "Remote", color_hex: "#33FF55", color_slot: 1 }
  ]
  world = Simulation::World.new(id: 4242, config: config, participants: people, presentation_strategy: "responsive")
  world.start!
  world
end

# Clears food so a scenario measures movement alone; `place` fixes the bodies.
def straight!(world, bodies, directions)
  world.snakes.each { |snake| snake.food = nil }
  world.instance_variable_set(:@shared_food, [])
  world.snakes.each_with_index do |snake, index|
    cells = bodies && bodies[index] ? bodies[index] : snake.body
    directions_arr = directions || []
    snake.body.replace(cells.map { |x, y| [x, y] })
    snake.direction = Simulation::Direction.parse(directions_arr[index] || snake.direction.name)
    snake.queue.clear
    snake.grow = 0
    snake.score = index
    snake.alive = true
    snake.eliminated_at_tick = nil
    snake.longest_length = snake.body.length
  end
  world
end

def eat_food!(world, snake, cell)
  snake.food = Simulation::Food.new(x: cell[0], y: cell[1], owner_id: snake.id)
end

# Runs one scenario. `turns` are submitted by player 1 at the tick named
# `sent_at`; the durable queue applies them at the NEXT step, exactly like
# Match#apply_queued_inputs! does for a leased owner.
def scenario(name:, turns:, ticks:, seed:, mode: :brawl, bodies: nil, directions: nil,
             freeze_at: nil, kill_at: nil, food: nil, note: nil)
  world = build(seed: seed, mode: mode)
  straight!(world, bodies || [[[3, 3], [2, 3], [1, 3]]], directions || ["right"]) if bodies
  eat_food!(world, world.snakes[0], food) if food
  frames = []
  applied = []
  rejected = []
  # Tick 0 is the frame a client holds before its first movement step.
  world.server_time_ms = 0
  frames << Simulation::Protocol.encode(world)
  (0...ticks).each do |tick|
    pending = turns.select { |turn| turn[:sent_at] == tick }
    pending.each do |turn|
      outcome = world.apply_input(player_id: 1, direction: Simulation::Direction.parse(turn[:dir]),
                                 tick: tick, seq: turn[:seq], window: Simulation::World::QUEUED_INPUT_TICK_WINDOW)
      entry = { seq: turn[:seq], dir: turn[:dir], sent_at: tick, outcome: outcome.to_s, tick: world.tick + 1 }
      (outcome == :accepted ? applied : rejected) << entry
    end
    world.freeze_player!(1, now_ms: tick * TICK_MS, until_ms: tick * TICK_MS + 5_000) if freeze_at == tick
    world.resume_player!(1) if freeze_at && tick == freeze_at + 3
    if kill_at == tick
      world.remove_player!(1, reason: :self_collision, at_tick: world.tick + 1)
      rejected << { seq: nil, dir: nil, sent_at: tick, outcome: "eliminated", tick: world.tick }
      # Record the frame that carries the elimination itself: the client must be
      # able to see a=false arrive, and prediction must stop on exactly it.
      world.server_time_ms = world.tick * TICK_MS
      frames << Simulation::Protocol.encode(world)
    end
    break unless world.running?

    world.step!
    world.server_time_ms = world.tick * TICK_MS
    frames << Simulation::Protocol.encode(world)
  end
  { "name" => name, "note" => note, "ticks" => ticks, "turns" => turns.map { |t| t.transform_keys(&:to_s) },
    "applied" => applied, "rejected" => rejected, "frames" => frames }.tap { world.finish!(reason: :completed) }
end

# Latency variants of the same turn sequence.
#
# A press made while the client displays tick `client_tick` reaches the server
# UPLINK ticks later, so the server consumes it at client_tick + uplink + 1. The
# engine below applies inputs on the tick named `sent_at`, so sent_at is exactly
# that arrival tick, and `presses` records what the browser believed. This is the
# whole reason prediction can diverge, and the only honest way to test it: the
# fixture is the server's real answer to a late packet, not a guess at it.
# Timeline of one press, in the harness's clock (frame k is produced at k*TICK):
#   frame C delivered           C*TICK + one_way
#   player presses (mid-tick)   C*TICK + one_way + PRESS_PHASE*TICK
#   input reaches the server    + one_way again (a full round trip after frame C)
#   engine applies it at the loop index it is in on arrival, so the turn is
#   effective on the step to that index + 1.
# Earlier versions counted only the uplink and so let the engine turn a tick or
# two before any real server could have seen the input at 200-300 ms.
PRESS_PHASE = 0.5

def latency_variant(base_turns, one_way_ms)
  arrival_ticks = ((one_way_ms * 2 + PRESS_PHASE * TICK_MS) / TICK_MS).floor
  turns = base_turns.map { |t| t.merge(sent_at: t[:sent_at] + arrival_ticks) }
  presses = turns.map do |t|
    { seq: t[:seq], dir: t[:dir], client_tick: t[:sent_at] - arrival_ticks,
      one_way_ms: one_way_ms, uplink_ticks: arrival_ticks, press_phase: PRESS_PHASE }
  end
  [turns, presses]
end

BASE_TURNS = [{ seq: 1, dir: "down", sent_at: 1 }, { seq: 2, dir: "left", sent_at: 3 },
              { seq: 3, dir: "up", sent_at: 5 }, { seq: 4, dir: "right", sent_at: 7 }]

common = { tick_ms: TICK_MS, columns: COLUMNS, rows: ROWS, growth: GROWTH, participant_id: 1,
           latency_variants: {} }
scenarios = [
  scenario(name: "idle", note: "no input at all: the baseline that must produce zero corrections",
           ticks: 12, seed: 101, turns: []),
  scenario(name: "turns", note: "four legal turns at ticks 1,3,5,7 (queue depth 4)", ticks: 14, seed: 102,
           turns: [{ seq: 1, dir: "down", sent_at: 1 }, { seq: 2, dir: "left", sent_at: 3 },
                   { seq: 3, dir: "up", sent_at: 5 }, { seq: 4, dir: "right", sent_at: 7 }]),
  scenario(name: "illegal", note: "duplicate then 180-degree reversal then a legal turn", ticks: 8, seed: 103,
           turns: [{ seq: 1, dir: "right", sent_at: 1 }, { seq: 2, dir: "right", sent_at: 2 },
                   { seq: 3, dir: "left", sent_at: 3 }, { seq: 4, dir: "down", sent_at: 4 }]),
  scenario(name: "wrap", note: "straight ahead until both edges wrap", ticks: 30, seed: 104,
           bodies: [[[COLUMNS - 2, 5], [COLUMNS - 3, 5], [COLUMNS - 4, 5]]], directions: ["right"], turns: []),
  scenario(name: "tight_turns", note: "four turns inside four ticks (a fast mobile swipe burst)",
           ticks: 14, seed: 105,
           turns: [{ seq: 1, dir: "down", sent_at: 1 }, { seq: 2, dir: "left", sent_at: 2 },
                   { seq: 3, dir: "up", sent_at: 3 }, { seq: 4, dir: "right", sent_at: 4 }]),
  # A coil: the head's next step is its own neck, so the server eliminates on the
  # very first tick. The predictor must HOLD at the wall instead of painting a
  # death it was never given authority over, then stop when a=false arrives.
  scenario(name: "self_collision", note: "head enters own body: deterministic, but death stays server-owned",
           ticks: 6, seed: 109,
           bodies: [[[5, 5], [5, 4], [4, 4], [3, 4]]], directions: ["up"], turns: []),
  # Food sits directly on the heading path, so the browser MAY predict the
  # growth (same cell, same rule) but not the respawn or the score.
  scenario(name: "food", note: "known food ahead: growth predictable, respawn and score are not",
           ticks: 8, seed: 106, food: [16, 11], turns: []),
  scenario(name: "freeze", note: "authoritative freeze then resume; a frozen snake never advances",
           ticks: 12, seed: 107, freeze_at: 3,
           turns: [{ seq: 1, dir: "down", sent_at: 5 }, { seq: 2, dir: "up", sent_at: 8 }]),
  scenario(name: "eliminated", note: "server eliminates mid-round: prediction must stop, not replay",
           ticks: 10, seed: 108, kill_at: 5, turns: [{ seq: 1, dir: "down", sent_at: 1 }])
]

# 0 / 100 / 200 / 300 ms of one-way delay, plus jitter on top of 200 ms. The
# uplink is expressed in whole logical ticks because that is what decides which
# tick the server consumes an input on; the downlink is milliseconds because
# that is what the client's clock sees.
[0, 100, 200, 300, 260].each_with_index do |one_way, index|
  turns, presses = latency_variant(BASE_TURNS, one_way)
  uplink = presses.first[:uplink_ticks]
  jitter = one_way == 260 ? [0, 45, 130, 15, 80, 0, 150, 30] : []
  name = "latency_#{one_way}ms#{jitter.empty? ? '' : '_jitter'}"
  entry = scenario(name: name, note: "same four turns, #{one_way} ms each way (#{uplink} ticks press-to-engine)",
                   ticks: 14 + uplink, seed: 200 + index, turns: turns)
  entry["presses"] = presses
  entry["one_way_ms"] = one_way
  entry["uplink_ticks"] = uplink
  entry["jitter_ms"] = jitter
  scenarios << entry
  common[:latency_variants][name] = { "one_way_ms" => one_way, "uplink_ticks" => uplink, "jitter_ms" => jitter }
end

out = File.expand_path("../fixtures/prediction-trace.json", __dir__)
File.write(out, JSON.pretty_generate({ "generated_by" => "tests/support/generate-prediction-trace.rb",
                                       "protocol_version" => Simulation::Protocol::SNAPSHOT_VERSION,
                                       "engine" => "Simulation::World step! (rails/app/lib/simulation)",
                                       "config" => common, "scenarios" => scenarios }))
puts "wrote #{out}"
scenarios.each { |s| puts format("%-22s frames=%-3d applied=%-2d rejected=%d presses=%d",
                                 s["name"], s["frames"].length, s["applied"].length,
                                 s["rejected"].length, Array(s["presses"]).length) }
