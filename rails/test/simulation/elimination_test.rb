require_relative "simulation_helper"

# Step 9: elimination records final stats, simultaneous deaths share a tick,
# and final ranking stays points-first with a deterministic tie policy.
class EliminationTest < Minitest::Test
  include SimulationTestSupport

  def test_elimination_freezes_final_score_survival_body_and_reason
    world = build_world(participants: 2, seed: 31)
    snake = world.snakes.first
    place(world, snake, body: [[5, 5], [5, 6], [4, 6], [4, 5], [4, 4]], direction: "left")
    snake.score = 7
    frozen_body = snake.body.map(&:dup)

    result = world.step!

    assert_equal :self_collision, result.eliminated[snake.id]
    refute snake.alive?
    assert_equal 7, snake.score, "final score is frozen, not reset"
    assert_equal world.tick, snake.eliminated_at_tick
    assert_equal :self_collision, snake.elimination_reason
    assert_equal frozen_body, snake.body, "the ending position is preserved for results"
    assert_equal 5, snake.longest_length
  end

  def test_simultaneous_duel_deaths_share_a_tick_and_rank_by_points
    world = build_world(participants: 2, mode: :duel, seed: 32)
    first, second = world.snakes
    place(world, first, body: [[5, 5], [4, 5], [3, 5]])
    place(world, second, body: [[7, 5], [8, 5], [9, 5]], direction: "left")
    first.score = 2
    second.score = 6

    result = world.step!

    assert_equal :head_on, result.eliminated[first.id]
    assert_equal :head_on, result.eliminated[second.id]
    assert_equal first.eliminated_at_tick, second.eliminated_at_tick
    assert world.completed?
    standings = world.standings
    assert_equal second.id, standings.first.id, "points decide between same-tick deaths"
    assert_equal [1, 2], standings.map(&:placement)
  end

  def test_full_tie_falls_back_to_deterministic_participant_order
    world = build_world(participants: 3, seed: 33)
    world.snakes.each do |snake|
      snake.score = 4
      snake.survived_ticks = 9
      snake.longest_length = 6
    end
    standings = world.standings
    assert_equal world.snakes.map(&:id).sort, standings.map(&:id)
    assert_equal [1, 2, 3], standings.map(&:placement)
  end

  def test_survival_then_longest_break_point_ties_in_order
    world = build_world(participants: 3, seed: 34)
    short_lived, long_snake, brief = world.snakes
    short_lived.score = 5; short_lived.survived_ticks = 3; short_lived.longest_length = 12
    long_snake.score = 5; long_snake.survived_ticks = 8; long_snake.longest_length = 4
    brief.score = 5; brief.survived_ticks = 8; brief.longest_length = 9
    standings = world.standings
    assert_equal [brief.id, long_snake.id, short_lived.id], standings.map(&:id)
  end

  def test_eliminated_snake_keeps_its_body_in_checkpoints_and_snapshots
    world = build_world(participants: 2, seed: 35)
    snake = world.snakes.first
    place(world, snake, body: [[5, 5], [5, 6], [4, 6], [4, 5]], direction: "down")
    world.step!
    refute snake.alive?
    assert_equal snake.body.length, world.to_state["snakes"].first["body"].length
    assert_equal snake.body.length, world.snapshot["p"].first["b"].length,
                 "the final body stays visible on the board"
  end
end
