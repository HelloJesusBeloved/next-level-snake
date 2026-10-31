require_relative "simulation_helper"

class PredictionCompactMetadataTest < Minitest::Test
  include SimulationTestSupport

  def test_compact_and_full_responsive_frames_carry_the_same_reconciliation_metadata
    world = build_world(participants: 2)
    world.instance_variable_set(:@presentation_strategy, "responsive")
    snake = world.snakes.first
    place(world, snake, body: [[5, 5], [4, 5], [3, 5]], direction: "right", grow: 2)
    assert_equal :accepted, world.apply_input(player_id: snake.id, direction: Simulation::Direction.parse("down"), tick: world.tick, seq: 1)
    assert_equal :accepted, world.apply_input(player_id: snake.id, direction: Simulation::Direction.parse("left"), tick: world.tick, seq: 2)
    3.times do
      full = Simulation::Protocol.encode(world)["p"].find { |entry| entry["i"] == snake.id }
      compact = Simulation::Protocol.encode_movement(world)["p"].find { |entry| entry["i"] == snake.id }
      assert_equal full["dq"], compact["dq"]
      assert_equal full["gr"], compact["gr"]
      assert_equal full["is"], compact["is"]
      world.step!
    end
  end
end
