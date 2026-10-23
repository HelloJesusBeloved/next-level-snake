require_relative "simulation_helper"

# Brawl-specific authoritative rules (step 8):
#   * one independent colored snake per player
#   * one OWNED food item per player, in that player's color
#   * eating own food: +1 point, +growth segments, replacement food spawns
#   * passing through another snake: no effect
#   * touching/overlapping another player's food: no effect, it is not consumed
#   * self-collision eliminates; wrap and speed/growth preserved (world_test)
class BrawlRulesTest < Minitest::Test
  include SimulationTestSupport

  def setup
    @world = build_world(participants: 3, seed: 4242, growth: 2)
    @snakes = @world.snakes
  end

  def place_all
    positions = [[5, 4], [18, 4], [12, 13]]
    @snakes.each_with_index do |snake, index|
      place(@world, snake, body: [positions[index], [positions[index][0] - 1, positions[index][1]],
                               [positions[index][0] - 2, positions[index][1]]])
    end
  end

  def test_every_player_has_an_independent_colored_snake_and_own_food
    place_all
    colors = @snakes.map(&:color_hex)
    assert_equal 3, colors.uniq.size, "each player has their assigned solid color"
    # place_all clears food via the helper; seed deterministic owned food.
    @snakes.each_with_index do |snake, index|
      place_food(snake, [[10, 8], [3, 10], [20, 12]][index])
    end
    foods = @world.foods
    assert_equal 3, foods.size, "one food object per player"
    assert_equal @snakes.map(&:id).sort, foods.map(&:owner_id).sort, "every food is owned"
    @snakes.each do |snake|
      assert_equal snake.id, @world.foods.find { |f| f.cell == snake.food.cell }&.owner_id
    end
  end

  def test_eating_own_food_scores_grows_and_respawns_replacement_food
    place_all
    snake = @snakes.first
    place_food(snake, [6, 4]) # directly ahead (moving right)
    before = snake.food.cell

    result = @world.step!
    assert_equal [snake.id], result.eaten
    assert_equal 1, snake.score
    assert_equal 4, snake.length, "growth=2 means the tail stays on the eating tick"
    refute_equal before, snake.food.cell, "a replacement food spawned"
    refute_includes snake.body, snake.food.cell, "replacement food never spawns on a snake"
    assert_equal snake.id, @world.foods.find { |f| f.cell == snake.food.cell }&.owner_id
  end

  def test_passing_through_another_snake_has_no_effect
    place_all
    first, second = @snakes[0], @snakes[1]
    # first moves right into the column second occupies; second moves down out of the way.
    place(@world, first, body: [[10, 4], [9, 4], [8, 4]])
    place(@world, second, body: [[11, 4], [11, 5], [11, 6]], direction: "up")
    result = @world.step!
    assert_empty result.eliminated, "brawl opponents are non-solid"
    assert first.alive? && second.alive?
    assert_equal [11, 4], first.head
  end

  def test_overlapping_another_players_food_has_no_effect_and_is_not_consumed
    place_all
    first, second = @snakes[0], @snakes[1]
    place(@world, first, body: [[10, 4], [9, 4], [8, 4]])
    place(@world, second, body: [[18, 4], [17, 4], [16, 4]])
    foreign_food = Simulation::Food.new(x: 11, y: 4, owner_id: second.id)
    @world.instance_variable_set(:@shared_food, []) # brawl uses per-player food only
    second.food = foreign_food

    result = @world.step!
    assert_empty result.eliminated
    assert_empty result.eaten, "another player's food is never eaten"
    assert_equal 0, first.score
    assert_equal [11, 4], first.head
    assert_equal [11, 4], second.food.cell, "the foreign food item was not consumed or moved"
  end

  def test_another_player_cannot_score_from_your_food
    place_all
    first, second = @snakes[0], @snakes[1]
    place(@world, first, body: [[10, 4], [9, 4], [8, 4]])
    place(@world, second, body: [[11, 8], [10, 8], [9, 8]])
    # first's food sits away from first's path so it survives the whole test.
    place_food(first, [3, 15])
    place_food(second, [12, 8]) # second's own food directly ahead

    4.times { @world.step! }
    assert_operator second.score, :>=, 1, "second ate its own food"
    assert_equal first.id, @world.foods.find { |f| f.cell == [3, 15] }&.owner_id,
                 "first's food is still owned by first and was never consumed by second"
  end

  def test_self_collision_eliminates_and_final_points_still_decide
    place_all
    first, second, third = @snakes
    # Give the eventual "loser" more points than the survivor.
    place(@world, first, body: [[5, 4], [5, 5], [4, 5], [4, 4], [3, 4]], direction: "left")
    first.score = 9
    second.score = 1
    third.score = 2
    result = @world.step!
    assert_equal :self_collision, result.eliminated[first.id]
    refute first.alive?
    assert second.alive? && third.alive?

    @world.finish!(reason: :tick_limit)
    standings = @world.standings
    assert_equal first.id, standings.first.id, "final points beat survival time"
    assert_equal [1, 2, 3], standings.map(&:placement)
  end

  def test_no_unlimited_farming_after_competition_ends
    # Two players: eliminating one leaves a single living snake -> round over.
    @world = build_world(participants: 2, seed: 4242, growth: 2)
    @snakes = @world.snakes
    first, second = @snakes[0], @snakes[1]
    place(@world, first, body: [[5, 4], [5, 5], [4, 5], [4, 4], [3, 4]], direction: "left")
    place(@world, second, body: [[18, 4], [17, 4], [16, 4]])
    @world.step! # first eliminated, second still alive
    assert @world.completed?, "one living snake ends the round"
    frozen = second.body.map(&:dup)
    frozen_score = second.score
    3.times { assert_raises(Simulation::StateError) { @world.step! } }
    assert_equal frozen, second.body, "no ticks run after completion"
    assert_equal frozen_score, second.score, "no point farming after the round ends"
  end

  def test_fair_starting_positions_do_not_overlap
    10.times do |seed|
      world = build_world(participants: 8, seed: seed, columns: 24, rows: 18)
      cells = world.snakes.flat_map(&:body)
      assert_equal cells.length, cells.uniq.length, "seed #{seed}: spawned bodies never overlap"
      world.snakes.each do |snake|
        assert_equal 3, snake.length
        assert_equal "right", snake.direction.name
      end
    end
  end

  def test_food_spawn_terminates_on_a_full_board
    world = build_world(participants: 1, columns: 24, rows: 18)
    snake = world.snakes.first
    # Fill the board except one cell with the snake body is impossible at
    # length 3; instead occupy via food-owned check by placing snake over most
    # cells is not feasible — assert pick_free_cell returns nil when full.
    snake.body.replace((0...18).flat_map { |y| (0...24).map { |x| [x, y] } })
    assert_nil world.send(:pick_free_cell), "no infinite spawn loop on a full board"
  end
end
