require_relative "simulation_helper"

# Responsive Brawl relays cells the browser already entered. It does not walk
# a snake from a direction queue, and Classic does not enter this path.
class DecisiveRelayTest < Minitest::Test
  include SimulationTestSupport

  def responsive_world(participants: 1, seed: 3, growth: 1, columns: 24, rows: 18)
    config = Simulation::Config.new(columns: columns, rows: rows, seed: seed, max_ticks: 5_000,
                                    mode: :brawl, growth: growth, speed_level: 3)
    people = Array.new(participants) do |index|
      { id: index + 1, name: "P#{index + 1}", color_hex: SimulationTestSupport::COLORS[index],
        color_slot: index }
    end
    world = Simulation::World.new(id: 9, config: config, participants: people,
                                  presentation_strategy: "responsive")
    world.start!
    [world, people]
  end

  def step_into(world, snake, direction_name, seq)
    direction = Simulation::Direction.parse(direction_name)
    cell = [(snake.head[0] + direction.dx) % world.columns, (snake.head[1] + direction.dy) % world.rows]
    outcome = world.enqueue_pose!(player_id: snake.id, cell: cell, direction: direction,
                                  tick: world.tick, seq: seq)
    [outcome, cell, direction]
  end

  def test_the_duration_cap_does_not_stop_snakes_that_are_still_reporting
    world, = responsive_world(participants: 2)
    first, second = world.snakes
    place(world, first, body: [[4, 4], [3, 4], [2, 4]])
    place(world, second, body: [[4, 10], [3, 10], [2, 10]])
    world.active_ticks = world.config.max_ticks
    assert_equal :queued, step_into(world, first, "right", 1)[0]
    assert_equal :queued, step_into(world, second, "right", 1)[0]
    world.step!
    assert_equal "running", world.status.to_s
    assert_nil world.end_reason
    assert first.alive? && second.alive?
    assert_equal [5, 4], first.head
    assert_equal [5, 10], second.head
    assert_operator world.active_ticks, :>, world.config.max_ticks
  end

  def test_a_responsive_snake_holds_until_a_cell_is_reported
    world, = responsive_world
    snake = world.snakes.first
    place(world, snake, body: [[4, 4], [3, 4], [2, 4]], direction: "right")
    held = snake.head.dup
    assert_equal :accepted, world.apply_input(player_id: snake.id,
                                              direction: Simulation::Direction.parse("down"),
                                              tick: world.tick, seq: 1)
    world.step!
    assert_equal held, snake.head, "a direction must not invent the next cell"
    assert_equal "right", snake.direction.name
    assert_equal 1, world.tick
  end

  def test_one_legal_step_moves_and_a_second_pose_waits_for_the_next_tick
    world, = responsive_world
    snake = world.snakes.first
    place(world, snake, body: [[4, 4], [3, 4], [2, 4]], direction: "right")
    assert_equal :queued, step_into(world, snake, "right", 1)[0]
    assert_equal :queued, world.enqueue_pose!(player_id: snake.id, cell: [5, 5],
                                              direction: Simulation::Direction.parse("down"),
                                              tick: world.tick, seq: 2)
    world.step!
    assert_equal [5, 4], snake.head
    assert_equal "right", snake.direction.name
    assert_equal 1, snake.poses.length
    world.step!
    assert_equal [5, 5], snake.head
    assert_equal "down", snake.direction.name
    assert_empty snake.poses
  end

  def test_a_straight_skipped_cell_stays_in_the_body_and_the_stale_tail_does_not
    world, = responsive_world
    snake = world.snakes.first
    place(world, snake, body: [[4, 4], [3, 4], [2, 4]], direction: "right")
    outcome = world.enqueue_pose!(player_id: snake.id, cell: [6, 4],
                                  direction: Simulation::Direction.parse("right"),
                                  tick: world.tick, seq: 1)
    assert_equal :queued, outcome
    world.step!
    assert_equal [6, 4], snake.head
    assert_equal [[6, 4], [5, 4], [4, 4]], snake.body
    assert snake.alive?
  end

  def test_a_diagonal_skip_does_not_invent_a_corner
    world, = responsive_world
    snake = world.snakes.first
    place(world, snake, body: [[4, 4], [3, 4], [2, 4]], direction: "right")
    world.enqueue_pose!(player_id: snake.id, cell: [6, 5],
                        direction: Simulation::Direction.parse("down"),
                        tick: world.tick, seq: 1)
    world.step!
    assert_equal [6, 5], snake.head
    refute_includes snake.body, [5, 4]
    refute_includes snake.body, [5, 5]
    assert_equal 3, snake.length
  end

  def test_a_reconnect_jump_into_the_body_holds_instead_of_crashing
    world, = responsive_world
    snake = world.snakes.first
    # The reports from a dead socket never arrived. The next cell is inside
    # the body and is not a straight chase, so it must not be a crash.
    body = [[8, 8], [7, 8], [6, 8], [5, 8], [5, 7], [6, 7], [7, 7]]
    place(world, snake, body: body, direction: "right")
    world.enqueue_pose!(player_id: snake.id, cell: [6, 7],
                        direction: Simulation::Direction.parse("up"),
                        tick: world.tick, seq: 1)
    result = world.step!
    assert_nil result.eliminated[snake.id]
    assert snake.alive?
    assert_equal [8, 8], snake.head
    assert_equal body, snake.body
    assert_empty snake.poses
  end

  def test_stepping_onto_your_own_tail_while_not_growing_lives
    world, = responsive_world
    snake = world.snakes.first
    place(world, snake, body: [[5, 5], [5, 6], [4, 6], [4, 5]], direction: "left", grow: 0)
    assert_equal :queued, step_into(world, snake, "left", 1)[0]
    result = world.step!
    assert_nil result.eliminated[snake.id]
    assert snake.alive?
    assert_equal [4, 5], snake.head
    assert_equal "running", world.status.to_s
  end

  def test_a_full_height_column_survives_following_its_head_across_a_skipped_step
    world, = responsive_world
    snake = world.snakes.first
    # Score 15 on the default board is length 18, exactly the height. One
    # dropped report is two steps up, into the cell that will be the tail.
    body = (0...world.rows).map { |y| [5, y] }
    place(world, snake, body: body, direction: "up", score: 15)
    snake.food = nil
    world.enqueue_pose!(player_id: snake.id, cell: [5, world.rows - 2],
                        direction: Simulation::Direction.parse("up"),
                        tick: world.tick, seq: 1)
    result = world.step!
    assert_nil result.eliminated[snake.id]
    assert snake.alive?
    assert_equal [5, world.rows - 2], snake.head
    assert_equal world.rows, snake.length
    assert_equal [5, world.rows - 3], snake.body.last
  end

  def test_a_full_height_column_still_dies_when_it_turns_back_into_itself
    world, = responsive_world
    snake = world.snakes.first
    body = (0...world.rows).map { |y| [5, y] }
    place(world, snake, body: body, direction: "up", score: 15)
    snake.food = nil
    world.enqueue_pose!(player_id: snake.id, cell: [5, 2],
                        direction: Simulation::Direction.parse("down"),
                        tick: world.tick, seq: 1)
    result = world.step!
    assert_equal :self_collision, result.eliminated[snake.id]
    refute snake.alive?
  end

  def test_following_your_tail_for_several_laps_lives
    world, = responsive_world
    snake = world.snakes.first
    body = (0...world.rows).map { |y| [5, y] }
    place(world, snake, body: body, direction: "up", score: 15)
    snake.food = nil
    (world.rows * 3).times do |index|
      assert_equal :queued, step_into(world, snake, "up", index + 1)[0]
      result = world.step!
      assert_nil result.eliminated[snake.id], "died on step #{index}"
      assert snake.alive?
    end
    assert_equal world.rows, snake.length
    assert_equal snake.length, snake.body.uniq.length
  end

  def test_a_full_height_column_survives_a_half_board_skip_in_the_direction_it_faces
    world, = responsive_world
    snake = world.snakes.first
    body = (0...world.rows).map { |y| [5, y] }
    place(world, snake, body: body, direction: "up", score: 15)
    snake.food = nil
    # Nine steps up from y=0 on an 18-row board. Both ways are the same
    # length. Filling the wrong way overlaps the column and the next lap dies.
    target = [5, world.rows / 2]
    world.enqueue_pose!(player_id: snake.id, cell: target,
                        direction: Simulation::Direction.parse("up"),
                        tick: world.tick, seq: 1)
    result = world.step!
    assert_nil result.eliminated[snake.id]
    assert snake.alive?
    assert_equal target, snake.head
    assert_equal world.rows, snake.length
    assert_equal snake.length, snake.body.uniq.length
    # The cell just behind the head is one step further up, not back down the column.
    assert_equal [5, target[1] + 1], snake.body[1]
  end

  def test_a_stall_longer_than_half_the_board_keeps_the_facing_direction
    world, = responsive_world
    snake = world.snakes.first
    body = (0...world.rows).map { |y| [5, y] }
    place(world, snake, body: body, direction: "up", score: 15)
    snake.food = nil
    # Twelve steps up from y=0. The short way is six steps down, through the
    # column. That is the crash a lagged straight snake was charged with.
    steps = 12
    target = [5, (0 - steps) % world.rows]
    world.enqueue_pose!(player_id: snake.id, cell: target,
                        direction: Simulation::Direction.parse("up"),
                        tick: world.tick, seq: 1)
    result = world.step!
    assert_nil result.eliminated[snake.id]
    assert snake.alive?
    assert_equal target, snake.head
    assert_equal world.rows, snake.length
    assert_equal snake.length, snake.body.uniq.length
    assert_equal [5, (target[1] + 1) % world.rows], snake.body[1]
  end

  def test_a_dropped_report_on_the_corner_of_a_tail_chase_lives
    world, = responsive_world
    snake = world.snakes.first
    # The loop is full, so every step the head enters the cell the tail is
    # leaving. One missed report turns the corner: tail, then the cell after it.
    body = [[0, 6], [0, 5], [0, 4], [1, 4], [2, 4], [3, 4], [4, 4], [5, 4],
            [5, 5], [5, 6], [5, 7], [4, 7], [3, 7], [2, 7], [1, 7], [0, 7]]
    place(world, snake, body: body, direction: "down", grow: 0)
    snake.food = nil
    world.enqueue_pose!(player_id: snake.id, cell: [1, 7],
                        direction: Simulation::Direction.parse("right"),
                        tick: world.tick, seq: 1)
    result = world.step!
    assert_nil result.eliminated[snake.id]
    assert snake.alive?
    assert_equal [1, 7], snake.head
    assert_equal body.length, snake.length
    assert_equal snake.length, snake.body.uniq.length
    assert_includes snake.body, [0, 7]
  end

  def test_a_corner_into_the_neck_still_dies
    world, = responsive_world
    snake = world.snakes.first
    place(world, snake, body: [[5, 5], [4, 5], [4, 6], [4, 7]], direction: "right", grow: 0)
    world.enqueue_pose!(player_id: snake.id, cell: [4, 6],
                        direction: Simulation::Direction.parse("down"),
                        tick: world.tick, seq: 1)
    result = world.step!
    assert_equal :self_collision, result.eliminated[snake.id]
    refute snake.alive?
  end

  def test_a_second_report_of_the_cell_just_entered_does_not_kill
    world, = responsive_world
    snake = world.snakes.first
    place(world, snake, body: [[5, 5], [5, 6], [4, 6], [4, 5]], direction: "left", grow: 0)
    # Head is touching the tail. The first report steps onto it. A reload
    # reports that same cell again, which is now the head.
    assert_equal :queued, step_into(world, snake, "left", 1)[0]
    world.enqueue_pose!(player_id: snake.id, cell: [4, 5],
                        direction: Simulation::Direction.parse("left"),
                        tick: world.tick, seq: 2)
    world.step!
    assert_equal [4, 5], snake.head
    assert snake.alive?
    result = world.step!
    assert_nil result.eliminated[snake.id]
    assert snake.alive?
    assert_equal [4, 5], snake.head
    assert_empty snake.poses
    assert_equal 2, snake.last_applied_seq
  end

  def test_reporting_the_cell_already_occupied_does_not_kill_in_the_open
    world, = responsive_world
    snake = world.snakes.first
    place(world, snake, body: [[8, 8], [7, 8], [6, 8]], direction: "right", grow: 0)
    # Straight snake. The head is not on the tail. A reload still reports
    # the cell the old socket already entered.
    world.enqueue_pose!(player_id: snake.id, cell: [8, 8],
                        direction: Simulation::Direction.parse("right"),
                        tick: world.tick, seq: 1)
    result = world.step!
    assert_nil result.eliminated[snake.id]
    assert snake.alive?
    assert_equal [8, 8], snake.head
    assert_equal [[8, 8], [7, 8], [6, 8]], snake.body
  end

  def test_resume_drops_a_forward_pose_so_an_open_reload_steps_once
    world, = responsive_world
    snake = world.snakes.first
    place(world, snake, body: [[8, 8], [7, 8], [6, 8]], direction: "right", grow: 0)
    assert_equal :queued, step_into(world, snake, "right", 1)[0]
    assert_equal :frozen, world.freeze_player!(snake.id, now_ms: 1_000, until_ms: 31_000)
    assert_equal :resumed, world.resume_player!(snake.id)
    assert_empty snake.poses
    world.step!
    assert_equal [8, 8], snake.head
    assert snake.alive?
    assert_equal :queued, step_into(world, snake, "right", 2)[0]
    world.step!
    assert_equal [9, 8], snake.head
    assert snake.alive?
  end

  def test_resume_drops_poses_queued_before_the_freeze
    world, = responsive_world
    snake = world.snakes.first
    place(world, snake, body: [[5, 5], [5, 6], [4, 6], [4, 5]], direction: "left", grow: 0)
    assert_equal :queued, step_into(world, snake, "left", 1)[0]
    assert_equal :frozen, world.freeze_player!(snake.id, now_ms: 1_000, until_ms: 31_000)
    assert_equal 1, snake.poses.length
    world.step!
    assert_equal [5, 5], snake.head, "a frozen snake does not spend the queued pose"
    assert_equal :resumed, world.resume_player!(snake.id)
    assert_empty snake.poses
    assert_empty snake.queue
    held = snake.head.dup
    world.step!
    assert_equal held, snake.head
    assert snake.alive?
    assert_equal :queued, step_into(world, snake, "left", 2)[0]
    world.step!
    assert_equal [4, 5], snake.head
    assert snake.alive?
  end

  def test_entering_a_dead_snake_does_not_eliminate_or_end_the_match
    world, = responsive_world(participants: 3)
    first, second, third = world.snakes
    place(world, first, body: [[5, 5], [4, 5], [3, 5]])
    place(world, second, body: [[6, 5], [6, 6], [6, 7]], direction: "up")
    place(world, third, body: [[15, 9], [14, 9], [13, 9]])
    second.eliminate!(at_tick: 0, reason: :self_collision)
    assert_equal :queued, step_into(world, first, "right", 1)[0]
    world.enqueue_pose!(player_id: third.id, cell: [16, 9],
                        direction: Simulation::Direction.parse("right"),
                        tick: world.tick, seq: 1)
    result = world.step!
    assert_nil result.eliminated[first.id]
    assert first.alive? && third.alive?
    refute second.alive?
    assert_equal [6, 5], first.head
    assert_equal "running", world.status.to_s
  end

  def test_a_non_adjacent_report_is_still_painted
    world, = responsive_world
    snake = world.snakes.first
    place(world, snake, body: [[4, 4], [3, 4], [2, 4]], direction: "right")
    # A dropped earlier report must not freeze the snake. The cell the browser
    # is actually on is what everyone else should see.
    outcome = world.enqueue_pose!(player_id: snake.id, cell: [6, 4],
                                  direction: Simulation::Direction.parse("right"),
                                  tick: world.tick, seq: 1)
    assert_equal :queued, outcome
    assert_equal [4, 4], snake.head
    world.step!
    assert_equal [6, 4], snake.head
    assert_equal "right", snake.direction.name
  end

  def test_a_heading_that_does_not_match_the_cell_still_paints_the_cell
    world, = responsive_world
    snake = world.snakes.first
    place(world, snake, body: [[4, 4], [3, 4], [2, 4]], direction: "right")
    outcome = world.enqueue_pose!(player_id: snake.id, cell: [5, 4],
                                  direction: Simulation::Direction.parse("down"),
                                  tick: world.tick, seq: 1)
    assert_equal :queued, outcome
    world.step!
    assert_equal [5, 4], snake.head
    assert_equal "down", snake.direction.name
  end

  def test_eating_grows_scores_and_respawns
    world, = responsive_world(growth: 1)
    snake = world.snakes.first
    place(world, snake, body: [[4, 4], [3, 4], [2, 4]], direction: "right", score: 0)
    place_food(snake, [5, 4])
    assert_equal :queued, step_into(world, snake, "right", 1)[0]
    result = world.step!
    assert_equal [snake.id], result.eaten
    assert_equal 1, snake.score
    assert_equal 4, snake.length
    refute_equal [5, 4], snake.food.cell
    assert_equal [5, 4], snake.head
  end

  def test_self_collision_eliminates_without_walking_through_the_body
    world, = responsive_world
    snake = world.snakes.first
    place(world, snake, body: [[5, 5], [4, 5], [4, 4], [5, 4]], direction: "up", grow: 1)
    outcome = world.enqueue_pose!(player_id: snake.id, cell: [5, 4],
                                  direction: Simulation::Direction.parse("up"),
                                  tick: world.tick, seq: 1)
    assert_equal :queued, outcome
    result = world.step!
    assert_equal :self_collision, result.eliminated[snake.id]
    refute snake.alive?
    assert_equal [5, 5], snake.head
    assert_empty snake.poses
  end

  def test_a_wrap_is_one_legal_step
    world, = responsive_world
    snake = world.snakes.first
    place(world, snake, body: [[0, 6], [1, 6], [2, 6]], direction: "left")
    outcome = world.enqueue_pose!(player_id: snake.id, cell: [world.columns - 1, 6],
                                  direction: Simulation::Direction.parse("left"),
                                  tick: world.tick, seq: 1)
    assert_equal :queued, outcome
    world.step!
    assert_equal [world.columns - 1, 6], snake.head
    assert_equal "left", snake.direction.name
  end

  def test_a_thousand_steps_keep_the_head_delta_on_the_heading
    world, = responsive_world
    snake = world.snakes.first
    place(world, snake, body: [[8, 8], [7, 8], [6, 8]], direction: "right")
    pattern = (["right"] * 8 + ["down"] * 8 + ["left"] * 8 + ["up"] * 8)
    1000.times do |index|
      name = pattern[index % pattern.length]
      before = snake.head.dup
      outcome, cell, direction = step_into(world, snake, name, index + 1)
      assert_equal :queued, outcome
      world.step!
      assert_equal cell, snake.head
      assert_equal name, snake.direction.name
      dx = (snake.head[0] - before[0]) % world.columns
      dy = (snake.head[1] - before[1]) % world.rows
      dx -= world.columns if dx * 2 > world.columns
      dy -= world.rows if dy * 2 > world.rows
      assert_equal [direction.dx, direction.dy], [dx, dy]
    end
    assert snake.alive?
  end

  def test_unapplied_poses_survive_a_checkpoint
    world, people = responsive_world
    snake = world.snakes.first
    place(world, snake, body: [[4, 4], [3, 4], [2, 4]], direction: "right")
    assert_equal :queued, step_into(world, snake, "right", 4)[0]
    restored = Simulation::World.restore(id: world.id, config: world.config, participants: people,
                                         state: world.to_state, presentation_strategy: "responsive")
    restored_snake = restored.player(snake.id)
    assert_equal 1, restored_snake.poses.length
    assert_equal [4, 4], restored_snake.head
    restored.step!
    assert_equal [5, 4], restored_snake.head
    assert_empty restored_snake.poses
  end

  def test_classic_still_moves_from_a_direction_and_gains_no_report_keys
    world = build_world
    snake = world.snakes.first
    place(world, snake, body: [[4, 4], [3, 4], [2, 4]], direction: "right")
    assert_equal :accepted, world.apply_input(player_id: snake.id,
                                              direction: Simulation::Direction.parse("down"),
                                              tick: world.tick, seq: 1)
    world.step!
    assert_equal [4, 5], snake.head
    assert_equal "down", snake.direction.name
    encoded = Simulation::Protocol.encode(world)
    player = encoded["p"].first
    refute player.key?("poses")
    assert_equal snake.color_hex, player["c"]
    assert_equal "classic", encoded["strategy"]
    # A Classic step does not consult the pose queue even if one was smuggled in.
    snake.enqueue_pose([4, 6], Simulation::Direction.parse("down"), seq: 2, tick: world.tick)
    world.step!
    assert_equal [4, 6], snake.head
    assert_equal 1, snake.poses.length
  end

  def test_parse_report_accepts_a_cell_and_parse_input_still_rejects_one
    report = Simulation::Protocol.parse_report(
      "v" => 1, "type" => "report", "match" => 9, "tick" => 4, "seq" => 2, "dir" => "left", "c" => 30
    )
    assert_equal 9, report.match_id
    assert_equal "left", report.direction.name
    assert_equal 30, report.cell

    error = assert_raises(Simulation::InvalidInput) do
      Simulation::Protocol.parse_input(
        "v" => 1, "type" => "input", "match" => 9, "tick" => 4, "seq" => 2, "dir" => "left", "c" => 30
      )
    end
    assert_equal :unknown_field, error.reason

    forbidden = assert_raises(Simulation::InvalidInput) do
      Simulation::Protocol.parse_report(
        "v" => 1, "type" => "report", "match" => 9, "tick" => 4, "seq" => 2,
        "dir" => "left", "c" => 30, "head" => 30
      )
    end
    assert_equal :forbidden_field, forbidden.reason

    typed = assert_raises(Simulation::InvalidInput) do
      Simulation::Protocol.parse_input(
        "v" => 1, "type" => "report", "match" => 9, "tick" => 4, "seq" => 2, "dir" => "left"
      )
    end
    assert_equal :invalid_type, typed.reason
  end
end
