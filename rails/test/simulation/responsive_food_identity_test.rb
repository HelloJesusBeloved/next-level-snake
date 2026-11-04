require_relative "simulation_helper"

# Food identity and per-tick Responsive frames. Classic snapshots must stay the
# shape they had before this change: no tick_ms, no generation, no eaten list.
class ResponsiveFoodIdentityTest < Minitest::Test
  include SimulationTestSupport

  def responsive_world
    config = Simulation::Config.new(columns: 24, rows: 18, seed: 7, max_ticks: 500,
                                    mode: :brawl, growth: 1, speed_level: nil, tick_ms: 105)
    people = [
      { id: 1, name: "A", color_hex: "#FF0000", color_slot: 0 },
      { id: 2, name: "B", color_hex: "#00FF00", color_slot: 1 }
    ]
    world = Simulation::World.new(id: 9, config: config, participants: people,
                                  presentation_strategy: "responsive")
    world.start!
    world
  end

  def test_classic_snapshot_does_not_grow_new_fields
    world = build_world
    frame = Simulation::Protocol.encode(world)
    refute frame.key?("tick_ms")
    refute frame.key?("tm")
    refute frame.key?("fe")
    frame.fetch("f").each do |food|
      assert_equal %w[c o], food.keys.sort
    end
  end

  def test_responsive_snapshot_names_tick_and_food_generation
    world = responsive_world
    frame = Simulation::Protocol.encode(world)
    assert_equal 105, frame["tick_ms"]
    assert_equal 0, frame["tm"]
    assert_equal [], frame["fe"]
    assert frame["f"].all? { |food| food["g"] == 1 }
  end

  def test_generation_increments_once_when_the_pellet_is_eaten
    world = responsive_world
    snake = world.snakes.first
    snake.body.replace([[3, 3], [2, 3], [1, 3]])
    snake.direction = Simulation::Direction.parse("right")
    snake.food = Simulation::Food.new(x: 4, y: 3, owner_id: snake.id, generation: 1)
    before = snake.length
    # Responsive does not invent the step. The browser reports the cell it entered.
    assert_equal :queued, world.enqueue_pose!(
      player_id: snake.id, cell: [4, 3], direction: Simulation::Direction.parse("right"),
      tick: world.tick, seq: 1
    )
    world.step!
    frame = Simulation::Protocol.encode(world)
    event = frame["fe"].find { |entry| entry["o"] == snake.id }
    assert_equal({ "o" => snake.id, "g" => 1, "t" => 1, "c" => 3 * 24 + 4 }, event)
    assert_equal before + 1, snake.length
    assert_equal 1, snake.score
    assert_equal 2, snake.food.generation
    current = frame["f"].find { |food| food["o"] == snake.id }
    assert_equal 2, current["g"]
    refute_equal event["c"], current["c"]
  end

  def test_a_catch_up_burst_keeps_every_tick
    world = responsive_world
    world.server_time_ms = 0
    world.note_responsive_frame!
    5.times do
      world.step!
      world.server_time_ms = world.tick * 105
      world.note_responsive_frame!
    end
    frames = world.drain_responsive_frames
    assert_equal (0..5).to_a, frames.map { |frame| frame["t"] }
    assert frames.all? { |frame| frame["tick_ms"] == 105 && frame["fe"].is_a?(Array) }
  end

  def test_checkpoint_keeps_food_generation
    world = responsive_world
    snake = world.snakes.first
    snake.food = Simulation::Food.new(x: 4, y: 3, owner_id: snake.id, generation: 4)
    restored = Simulation::Food.from_state(snake.food.to_state)
    assert_equal 4, restored.generation
    assert_equal snake.food.cell, restored.cell
  end
end
