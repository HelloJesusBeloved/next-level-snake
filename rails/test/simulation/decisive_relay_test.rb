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
