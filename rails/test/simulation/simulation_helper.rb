# Standalone engine test support. This file intentionally does NOT load Rails:
#   ruby -Itest test/simulation/world_test.rb
# must work with no database, no server and no WebSocket.
require "minitest/autorun"
require "json"
require_relative "../../app/lib/simulation"
%w[direction config rules rng food snake ranking world protocol scheduler supervisor].each do |file|
  require_relative "../../app/lib/simulation/#{file}"
end

module SimulationTestSupport
  COLORS = %w[#FF0000 #00FF00 #0000FF #FFFF00 #FF00FF #00FFFF].freeze

  def build_world(participants: 1, seed: 7, max_ticks: 500, mode: :brawl,
                  columns: 24, rows: 18, growth: 1, speed_level: 3, id: 42, start: true)
    config = Simulation::Config.new(columns: columns, rows: rows, seed: seed,
                                    max_ticks: max_ticks, mode: mode, growth: growth,
                                    speed_level: speed_level)
    people = Array.new(participants) do |index|
      { id: index + 1, name: "P#{index + 1}", color_hex: COLORS[index % COLORS.size],
        color_slot: index }
    end
    world = Simulation::World.new(id: id, config: config, participants: people)
    world.start! if start
    world
  end

  # Deterministically position a snake and clear all food. Call for every snake
  # FIRST, then place food, so one `place` does not wipe another's meal.
  def place(world, snake, body:, direction: "right", grow: 0, score: 0)
    snake.body.replace(body.map { |cell| [cell[0], cell[1]] })
    snake.direction = Simulation::Direction.parse(direction)
    snake.queue.clear
    snake.grow = grow
    snake.score = score
    snake.alive = true
    snake.eliminated_at_tick = nil
    snake.survived_ticks = 0
    snake.longest_length = snake.body.length
    snake.food = nil
    snake
  end

  def place_food(snake, cell)
    snake.food = Simulation::Food.new(x: cell[0], y: cell[1], owner_id: snake.id)
  end
end
