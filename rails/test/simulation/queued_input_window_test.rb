require_relative "simulation_helper"

# Step 8 review regression: a client can only name the tick of the last snapshot
# it received. Snapshots are broadcast at 10 Hz while the engine ticks every
# 40-1000 ms, so that tick lags the owner's in-memory tick by several ticks.
# The strict in-memory window silently deleted those directions (input loss).
class QueuedInputWindowTest < Minitest::Test
  include SimulationTestSupport

  def test_a_direction_quoted_at_a_stale_snapshot_tick_is_still_applied
    world = build_world(participants: 2, seed: 21, speed_level: 3)
    snake = world.snakes.first
    place(world, snake, body: [[10, 4], [9, 4], [8, 4]])

    12.times { world.step! } # owner advanced well past the client's frame
    lagging_tick = world.tick - 8

    outcome = world.apply_input(
      player_id: snake.id,
      direction: Simulation::Direction.parse("up"),
      tick: lagging_tick,
      seq: 1,
      window: Simulation::World::QUEUED_INPUT_TICK_WINDOW
    )

    assert_equal :accepted, outcome
    assert_equal ["up"], snake.queue.map(&:name)
    assert_equal 1, snake.last_seq
  end

  def test_the_wide_window_still_rejects_clearly_ancient_and_future_input
    world = build_world(participants: 2, seed: 22, speed_level: 3)
    snake = world.snakes.first

    60.times { world.step! }
    assert_equal :invalid_tick, world.apply_input(
      player_id: snake.id, direction: Simulation::Direction.parse("up"),
      tick: 0, seq: 1, window: Simulation::World::QUEUED_INPUT_TICK_WINDOW
    )

    assert_equal :invalid_tick, world.apply_input(
      player_id: snake.id, direction: Simulation::Direction.parse("up"),
      tick: world.tick + 500, seq: 2, window: Simulation::World::QUEUED_INPUT_TICK_WINDOW
    )
  end

  def test_the_strict_window_is_unchanged_for_direct_in_memory_calls
    world = build_world(participants: 2, seed: 23, speed_level: 3)
    snake = world.snakes.first
    6.times { world.step! }

    assert_equal :invalid_tick, world.apply_input(
      player_id: snake.id, direction: Simulation::Direction.parse("up"),
      tick: world.tick - 8, seq: 1
    )
  end

  def test_sequence_ordering_is_preserved_with_lagging_ticks
    world = build_world(participants: 2, seed: 24, speed_level: 3)
    snake = world.snakes.first
    place(world, snake, body: [[10, 4], [9, 4], [8, 4]])
    window = Simulation::World::QUEUED_INPUT_TICK_WINDOW

    assert_equal :accepted, world.apply_input(player_id: snake.id,
      direction: Simulation::Direction.parse("up"), tick: world.tick - 5, seq: 1, window: window)
    assert_equal :accepted, world.apply_input(player_id: snake.id,
      direction: Simulation::Direction.parse("left"), tick: world.tick - 9, seq: 2, window: window)

    assert_equal %w[up left], snake.queue.map(&:name),
                 "seq order, not the quoted tick, decides application order"
  end
end
