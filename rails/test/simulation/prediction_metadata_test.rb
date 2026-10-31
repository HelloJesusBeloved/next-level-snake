require_relative "simulation_helper"

class PredictionMetadataTest < Minitest::Test
  include SimulationTestSupport

  def test_responsive_frame_carries_authoritative_turn_queue_and_growth
    world = build_world(participants: 2)
    world.instance_variable_set(:@presentation_strategy, "responsive")
    snake = world.snakes.first
    place(world, snake, body: [[5, 5], [4, 5], [3, 5]], direction: "right", grow: 2)
    assert_equal :accepted, world.apply_input(player_id: snake.id, direction: Simulation::Direction.parse("down"), tick: world.tick, seq: 1)
    assert_equal :accepted, world.apply_input(player_id: snake.id, direction: Simulation::Direction.parse("left"), tick: world.tick, seq: 2)
    player = Simulation::Protocol.encode(world)["p"].find { |entry| entry["i"] == snake.id }
    assert_equal ["down", "left"], player["dq"]
    assert_equal 2, player["gr"]
    world.step!
    player = Simulation::Protocol.encode(world)["p"].find { |entry| entry["i"] == snake.id }
    assert_equal "down", player["d"]
    assert_equal ["left"], player["dq"]
    assert_equal 1, player["gr"]
    assert_equal 2, player["is"], "accepted sequence is not the same as both turns having moved"
  end

  def test_classic_snapshot_has_no_new_presentation_fields
    world = build_world(participants: 2)
    player = Simulation::Protocol.encode(world)["p"].first
    refute player.key?("dq")
    refute player.key?("gr")
  end
end
