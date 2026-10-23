require_relative "simulation_helper"

class WorldMovementTest < Minitest::Test
  include SimulationTestSupport

  def test_moves_exactly_one_cell_per_tick_in_each_direction
    world = build_world
    snake = place(world, world.snakes.first, body: [[5, 5], [4, 5], [3, 5]])
    world.step!
    assert_equal [6, 5], snake.head

    place(world, snake, body: [[5, 5], [4, 5], [3, 5]], direction: "down")
    world.step!
    assert_equal [5, 6], snake.head

    place(world, snake, body: [[5, 5], [6, 5], [7, 5]], direction: "left")
    world.step!
    assert_equal [4, 5], snake.head

    place(world, snake, body: [[5, 5], [6, 5], [7, 5]], direction: "up")
    world.step!
    assert_equal [5, 4], snake.head
  end

  def test_wraps_on_every_edge_like_the_single_player_engine
    world = build_world
    snake = place(world, world.snakes.first, body: [[23, 5], [22, 5], [21, 5]])
    world.step!
    assert_equal [0, 5], snake.head, "right edge wraps to column 0"

    place(world, snake, body: [[5, 17], [5, 16], [5, 15]], direction: "down")
    world.step!
    assert_equal [5, 0], snake.head, "bottom edge wraps to row 0"

    place(world, snake, body: [[5, 0], [5, 1], [5, 2]], direction: "up")
    world.step!
    assert_equal [5, 17], snake.head, "top edge wraps to the last row"

    place(world, snake, body: [[0, 5], [1, 5], [2, 5]], direction: "left")
    world.step!
    assert_equal [23, 5], snake.head, "left edge wraps to the last column"
  end

  def test_body_follows_the_head_and_keeps_its_length
    world = build_world
    snake = place(world, world.snakes.first, body: [[5, 5], [4, 5], [3, 5]])
    world.step!
    assert_equal [[6, 5], [5, 5], [4, 5]], snake.body
    assert_equal 3, snake.length
  end

  def test_grid_is_clamped_board_dimensions_from_config
    world = build_world(columns: 30, rows: 20)
    assert_equal 30, world.columns
    assert_equal 20, world.rows
    snake = place(world, world.snakes.first, body: [[29, 3], [28, 3], [27, 3]])
    world.step!
    assert_equal [0, 3], snake.head
  end
end

class WorldFoodAndGrowthTest < Minitest::Test
  include SimulationTestSupport

  def test_eating_scores_one_point_and_grows_by_the_configured_amount
    world = build_world(growth: 2)
    snake = place(world, world.snakes.first, body: [[5, 5], [4, 5], [3, 5]])
    place_food(snake, [6, 5])

    result = world.step!
    assert_equal [snake.id], result.eaten
    assert_equal 1, snake.score
    assert_equal 1, snake.grow, "growth is consumed one segment per tick"
    assert_equal 4, snake.length, "tail stays on the eating tick"

    world.step!
    assert_equal 5, snake.length, "second growth segment lands next tick"
    world.step!
    assert_equal 5, snake.length, "growth is complete: 3 + 2"
  end

  def test_growth_of_zero_keeps_the_snake_length_constant
    world = build_world(growth: 0)
    snake = place(world, world.snakes.first, body: [[5, 5], [4, 5], [3, 5]])
    place_food(snake, [6, 5])
    world.step!
    assert_equal 1, snake.score
    assert_equal 3, snake.length
  end

  def test_only_the_owned_food_is_edible_in_a_brawl
    world = build_world(participants: 2)
    first, second = world.snakes
    place(world, first, body: [[5, 5], [4, 5], [3, 5]])
    place(world, second, body: [[15, 9], [14, 9], [13, 9]])
    place_food(second, [6, 5]) # another player's food sitting on P1's path
    world.step!
    assert_equal 0, first.score
    assert_equal [6, 5], first.head
    assert_equal 0, second.score
  end

  def test_food_respawns_on_a_free_cell_after_eating
    world = build_world
    snake = place(world, world.snakes.first, body: [[5, 5], [4, 5], [3, 5]])
    place_food(snake, [6, 5])
    world.step!
    refute_nil snake.food
    refute_equal [6, 5], snake.food.cell
    refute_includes snake.body, snake.food.cell
  end

  def test_scores_and_longest_length_are_tracked_per_player
    world = build_world(participants: 2)
    first, second = world.snakes
    place(world, first, body: [[5, 5], [4, 5], [3, 5]])
    place(world, second, body: [[15, 9], [14, 9], [13, 9]])
    place_food(first, [6, 5])
    world.step!
    assert_equal 1, first.score
    assert_equal 0, second.score
    assert_equal 4, first.longest_length
    assert_equal 3, second.longest_length
  end
end

class WorldCollisionTest < Minitest::Test
  include SimulationTestSupport

  def test_moving_into_the_middle_of_your_own_body_eliminates_you
    world = build_world
    snake = place(world, world.snakes.first,
                  body: [[5, 5], [5, 6], [4, 6], [4, 5], [4, 4]], direction: "left")
    result = world.step!
    assert_equal :self_collision, result.eliminated[snake.id]
    refute snake.alive?
    assert_equal 1, snake.eliminated_at_tick
    assert_equal 0, snake.survived_ticks
    assert_equal 0, snake.score, "no food was eaten before the crash"
  end

  def test_tail_cell_is_safe_unless_the_snake_is_growing
    world = build_world
    snake = place(world, world.snakes.first, body: [[5, 5], [5, 6], [4, 6], [4, 5]], direction: "left")
    world.step!
    assert snake.alive?, "a moving tail vacates its cell (single-player rule)"
    assert_equal [4, 5], snake.head

    world = build_world
    snake = place(world, world.snakes.first, body: [[5, 5], [5, 6], [4, 6], [4, 5]],
                  direction: "left", grow: 1)
    result = world.step!
    assert_equal :self_collision, result.eliminated[snake.id], "a growing tail still blocks"
  end

  def test_brawl_opponents_are_non_solid_and_pass_through_each_other
    world = build_world(participants: 2)
    first, second = world.snakes
    place(world, first, body: [[5, 5], [4, 5], [3, 5]])
    place(world, second, body: [[6, 5], [7, 5], [8, 5]], direction: "left")
    result = world.step!
    assert_empty result.eliminated
    assert first.alive? && second.alive?
    assert_equal [6, 5], first.head
    assert_equal [5, 5], second.head
    assert_equal first.head, second.body[1]
  end

  def test_duel_opponents_are_solid_and_head_on_hits_eliminate_both
    world = build_world(participants: 2, mode: :duel)
    first, second = world.snakes
    place(world, first, body: [[5, 5], [4, 5], [3, 5]])
    place(world, second, body: [[7, 5], [8, 5], [9, 5]], direction: "left")
    result = world.step!
    assert_equal :head_on, result.eliminated[first.id]
    assert_equal :head_on, result.eliminated[second.id]
    refute first.alive?
    refute second.alive?
    assert_equal "completed", world.status.to_s
    assert_equal :last_standing, world.end_reason
  end

  def test_duel_body_contact_eliminates_only_the_rammer
    world = build_world(participants: 2, mode: :duel)
    first, second = world.snakes
    place(world, first, body: [[5, 5], [4, 5], [3, 5]])
    place(world, second, body: [[6, 5], [6, 6], [6, 7]], direction: "up")
    result = world.step!
    assert_equal :body_collision, result.eliminated[first.id]
    refute first.alive?, "moving into a solid opponent's body eliminates the mover"
    assert second.alive?
  end

  def test_an_eliminated_snake_stops_moving_and_releases_its_cells
    world = build_world(participants: 3, mode: :duel)
    first, second, third = world.snakes
    place(world, first, body: [[5, 5], [4, 5], [3, 5]])
    place(world, second, body: [[6, 5], [6, 6], [6, 7]], direction: "up")
    place(world, third, body: [[15, 9], [14, 9], [13, 9]])
    world.step!
    refute first.alive?
    frozen = first.body.map(&:dup)
    world.step!
    assert_equal frozen, first.body
    assert_equal 1, first.eliminated_at_tick
  end
end

class WorldInputTest < Minitest::Test
  include SimulationTestSupport

  def setup
    @world = build_world
    @snake = place(@world, @world.snakes.first, body: [[5, 5], [4, 5], [3, 5]])
  end

  def down
    Simulation::Direction.parse("down")
  end

  def up
    Simulation::Direction.parse("up")
  end

  def left
    Simulation::Direction.parse("left")
  end

  def test_accepts_a_valid_turn_and_applies_it_on_the_next_tick
    assert_equal :accepted, @world.apply_input(player_id: @snake.id, direction: down, tick: 0, seq: 1)
    @world.step!
    assert_equal [5, 6], @snake.head
  end

  def test_queues_two_turns_and_applies_them_in_order
    assert_equal :accepted, @world.apply_input(player_id: @snake.id, direction: down, tick: 0, seq: 1)
    assert_equal :accepted, @world.apply_input(player_id: @snake.id, direction: left, tick: 0, seq: 2)
    assert_equal :queue_full, @world.apply_input(player_id: @snake.id, direction: up, tick: 0, seq: 3)
    @world.step!
    assert_equal [5, 6], @snake.head, "first queued turn"
    @world.step!
    assert_equal [4, 6], @snake.head, "second queued turn"
  end

  def test_rejects_immediate_180_degree_reversal
    assert_equal :reversal, @world.apply_input(player_id: @snake.id, direction: left, tick: 0, seq: 1)
    assert_empty @snake.queue
    @world.step!
    assert_equal [6, 5], @snake.head, "rejected reversal must not change movement"
  end

  def test_rejects_a_reversal_relative_to_the_last_queued_turn
    assert_equal :accepted, @world.apply_input(player_id: @snake.id, direction: down, tick: 0, seq: 1)
    assert_equal :reversal, @world.apply_input(player_id: @snake.id, direction: up, tick: 0, seq: 2)
  end

  def test_rejects_duplicate_direction_and_replayed_sequences
    assert_equal :duplicate_direction, @world.apply_input(player_id: @snake.id,
                                                          direction: Simulation::Direction.parse("right"),
                                                          tick: 0, seq: 1)
    assert_equal :accepted, @world.apply_input(player_id: @snake.id, direction: down, tick: 0, seq: 2)
    assert_equal :stale_sequence, @world.apply_input(player_id: @snake.id, direction: left, tick: 0, seq: 2)
    assert_equal :stale_sequence, @world.apply_input(player_id: @snake.id, direction: left, tick: 0, seq: 1)
  end

  # A rejected turn must still consume its sequence number. Otherwise the same
  # seq could be replayed with a different direction (input replay).
  def test_a_rejected_turn_consumes_its_sequence_number
    assert_equal :duplicate_direction, @world.apply_input(player_id: @snake.id,
                                                          direction: Simulation::Direction.parse("right"),
                                                          tick: 0, seq: 1)
    assert_equal 1, @snake.last_seq
    assert_equal :stale_sequence, @world.apply_input(player_id: @snake.id, direction: down, tick: 0, seq: 1)
    assert_empty @snake.queue, "the replayed turn must not reach the queue"
    assert_equal :accepted, @world.apply_input(player_id: @snake.id, direction: down, tick: 0, seq: 2)
  end

  def test_rejects_input_for_stale_or_future_ticks
    @world.step!
    @world.step!
    @world.step!
    assert_equal :invalid_tick, @world.apply_input(player_id: @snake.id, direction: down, tick: 0, seq: 1)
    assert_equal :accepted, @world.apply_input(player_id: @snake.id, direction: down, tick: 4, seq: 2)
    assert_equal :invalid_tick, @world.apply_input(player_id: @snake.id, direction: down, tick: 9, seq: 3)
  end

  def test_rejects_input_from_an_unknown_or_eliminated_player
    assert_equal :not_a_participant, @world.apply_input(player_id: 999, direction: down, tick: 0, seq: 1)
    @snake.eliminate!(at_tick: 0, reason: :self_collision)
    assert_equal :eliminated, @world.apply_input(player_id: @snake.id, direction: down, tick: 0, seq: 1)
  end

  def test_rejects_input_before_start_and_after_completion
    pending_world = build_world(start: false)
    pending_snake = pending_world.snakes.first
    assert_equal :match_not_running,
                 pending_world.apply_input(player_id: pending_snake.id, direction: down, tick: 0, seq: 1)

    @world.finish!(reason: :abandoned)
    assert_equal :match_not_running, @world.apply_input(player_id: @snake.id, direction: down, tick: 1, seq: 5)
  end

  def test_invalid_direction_names_are_rejected_by_the_parser
    %w[diagonal 4 0,0].each do |bad|
      error = assert_raises(Simulation::InvalidInput) { Simulation::Direction.parse(bad) }
      assert_equal :invalid_direction, error.reason
    end
  end
end

class WorldRankingAndLifecycleTest < Minitest::Test
  include SimulationTestSupport

  def test_final_points_outrank_survival_so_an_eliminated_player_can_win
    winner = Simulation::Snake.new(id: 1, name: "Eliminated", color_hex: "#FF0000", color_slot: 0,
                                   body: [[1, 1]], direction: Simulation::Direction.parse("right"),
                                   alive: false, score: 9, survived_ticks: 4, longest_length: 7,
                                   eliminated_at_tick: 4, elimination_reason: :self_collision)
    survivor = Simulation::Snake.new(id: 2, name: "Survivor", color_hex: "#00FF00", color_slot: 1,
                                     body: [[2, 2]], direction: Simulation::Direction.parse("right"),
                                     alive: true, score: 3, survived_ticks: 40, longest_length: 12)
    standings = Simulation::Ranking.rank([survivor, winner])
    assert_equal 1, standings.first.placement
    assert_equal "Eliminated", standings.first.name
    assert_equal 2, standings.last.placement
    assert_equal [1, 2], standings.map(&:placement)
  end

  def test_survival_then_longest_length_break_score_ties
    early = Simulation::Snake.new(id: 1, name: "Early", color_hex: "#FF0000", color_slot: 0,
                                  body: [[1, 1]], direction: Simulation::Direction.parse("right"),
                                  alive: false, score: 4, survived_ticks: 2, longest_length: 9)
    long = Simulation::Snake.new(id: 2, name: "Long", color_hex: "#00FF00", color_slot: 1,
                                 body: [[2, 2]], direction: Simulation::Direction.parse("right"),
                                 alive: true, score: 4, survived_ticks: 8, longest_length: 5)
    standings = Simulation::Ranking.rank([early, long])
    assert_equal %w[Long Early], standings.map(&:name), "survival is the first tiebreaker"

    standings = Simulation::Ranking.rank([long, early.dup.tap { |snake|
      snake.survived_ticks = 8
      snake.longest_length = 12
    }])
    assert_equal %w[Early Long], standings.map(&:name), "longest snake is the second"
  end

  def test_pause_freeze_resume_and_finish
    world = build_world
    world.pause!
    assert_equal :paused, world.status
    assert_raises(Simulation::StateError) { world.step! }
    world.resume!
    assert_equal :running, world.status
    world.step!
    assert_equal 1, world.tick
    world.finish!(reason: :tick_limit)
    assert_equal :completed, world.status
    assert_equal :tick_limit, world.end_reason
    assert_equal 1, world.ended_at_tick
    assert_raises(Simulation::StateError) { world.step! }
    assert_equal :completed, world.finish!(reason: :again).status, "finish is idempotent"
    assert_equal :tick_limit, world.end_reason
  end

  def test_match_completes_at_the_tick_limit_with_standings
    world = build_world(participants: 2, max_ticks: 10)
    world.snakes.each { |snake| place(world, snake, body: [[snake.id * 5, 3], [snake.id * 5 - 1, 3], [snake.id * 5 - 2, 3]]) }
    10.times { world.step! unless world.completed? }
    assert world.completed?
    assert_equal :tick_limit, world.end_reason
    assert_equal 10, world.tick
    assert_equal [1, 2], world.standings.map(&:placement)
  end

  def test_last_standing_ends_a_two_player_match
    world = build_world(participants: 2, mode: :duel)
    first, second = world.snakes
    place(world, first, body: [[5, 5], [4, 5], [3, 5]])
    place(world, second, body: [[6, 5], [6, 6], [6, 7]], direction: "up")
    world.step!
    assert world.completed?
    assert_equal :last_standing, world.end_reason
    assert_equal 1, world.alive_count
    assert_equal second.id, world.winner.id
  end

  def test_removing_a_player_freezes_their_score_and_can_complete_the_match
    world = build_world(participants: 2)
    first, second = world.snakes
    first.score = 5
    assert world.remove_player!(first.id, reason: :left)
    refute first.alive?
    assert_equal 5, first.score
    assert world.completed?
    assert_equal :last_standing, world.end_reason
    assert_equal first.id, world.winner.id, "points still decide the winner"
    refute world.remove_player!(first.id, reason: :left)
  end
end

class WorldModeAndIsolationTest < Minitest::Test
  include SimulationTestSupport

  def test_duel_food_supply_is_shared_and_shrinks_on_consumption
    world = build_world(participants: 2, mode: :duel)
    first, second = world.snakes
    place(world, first, body: [[5, 5], [4, 5], [3, 5]])
    place(world, second, body: [[15, 9], [14, 9], [13, 9]])
    shared = [Simulation::Food.new(x: 6, y: 5), Simulation::Food.new(x: 20, y: 2)]
    world.instance_variable_set(:@shared_food, shared)

    world.step!
    assert_equal 1, first.score
    assert_equal [[20, 2]], world.foods.map(&:cell), "shared food is consumed, not respawned"
  end

  def test_duel_food_supply_shrinks_over_time_but_never_below_one
    world = build_world(participants: 2, mode: :duel)
    foods = Array.new(4) { |i| Simulation::Food.new(x: i * 5, y: 1) }
    world.instance_variable_set(:@shared_food, foods)
    world.send(:shrink_food!, 119)
    assert_equal 4, world.foods.size
    world.send(:shrink_food!, 120)
    assert_equal 3, world.foods.size
    world.instance_variable_set(:@shared_food, [Simulation::Food.new(x: 1, y: 1)])
    world.send(:shrink_food!, 240)
    assert_equal 1, world.foods.size, "the final item is never removed"
  end

  def test_independent_matches_do_not_share_state
    first = build_world(id: 1, participants: 2, seed: 11)
    second = build_world(id: 2, participants: 2, seed: 11)
    first.step!
    first.step!
    assert_equal 2, first.tick
    assert_equal 0, second.tick
    refute_equal first.object_id, second.object_id
    assert_equal first.snakes.length, second.snakes.length
    assert_equal second.snakes.map(&:head), second.snakes.map(&:head)
  end

  def test_a_roster_that_cannot_fit_on_the_board_raises_capacity_error
    config = Simulation::Config.new(columns: 24, rows: 18, seed: 3, max_ticks: 50)
    participants = Array.new(200) do |index|
      { id: index + 1, name: "P#{index}", color_hex: "#FFFFFF", color_slot: index % 96 }
    end
    assert_raises(Simulation::CapacityError) do
      Simulation::World.new(id: 1, config: config, participants: participants)
    end
  end

  def test_same_seed_and_actions_produce_identical_snapshots
    first = build_world(id: 5, participants: 3, seed: 1234)
    second = build_world(id: 5, participants: 3, seed: 1234)
    assert_equal first.snapshot, second.snapshot
    5.times do
      first.step!
      second.step!
    end
    assert_equal first.snapshot, second.snapshot
  end

  def test_checkpoint_state_restores_an_identical_match
    world = build_world(participants: 2, seed: 99, max_ticks: 400)
    world.step!
    world.step!
    world.apply_input(player_id: world.snakes.first.id,
                      direction: Simulation::Direction.parse("down"), tick: world.tick, seq: 1)
    state = world.to_state
    restored = Simulation::World.restore(id: world.id, config: world.config,
                                        participants: world.snakes.map do |snake|
                                          { id: snake.id, name: snake.name,
                                            color_hex: snake.color_hex, color_slot: snake.color_slot }
                                        end, state: state)
    assert_equal world.snapshot, restored.snapshot
    assert_equal world.snakes.first.queue.map(&:name), restored.snakes.first.queue.map(&:name)

    world.step!
    restored.step!
    assert_equal world.snapshot, restored.snapshot
  end
end
