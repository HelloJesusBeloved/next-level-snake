require_relative "simulation_helper"

# Step 10 standalone engine coverage. Every transition takes an explicit
# server timestamp, so the full 30-second timeline runs instantly and no test
# sleeps on a wall clock.
class ReconnectionTest < Minitest::Test
  include SimulationTestSupport

  NOW = 1_700_000_000_000
  GRACE_MS = 30_000

  def world
    @world ||= begin
      built = build_world(participants: 2, seed: 11, max_ticks: 900)
      place(built, built.snakes.first, body: [[2, 2], [1, 2], [0, 2]], direction: "right")
      place(built, built.snakes.last, body: [[10, 10], [9, 10], [8, 10]], direction: "right")
      place_food(built.snakes.first, [20, 15])
      place_food(built.snakes.last, [21, 15])
      built.server_time_ms = NOW
      built
    end
  end

  def snake
    world.snakes.first
  end

  def other
    world.snakes.last
  end

  def freeze!(until_ms: NOW + GRACE_MS)
    world.freeze_player!(snake.id, now_ms: NOW, until_ms: until_ms)
  end

  def test_disconnect_freezes_the_snake_and_preserves_every_authoritative_field
    before = { body: snake.body.map(&:dup), direction: snake.direction.name,
               score: snake.score, length: snake.length, food: snake.food.cell }
    freeze!

    assert snake.frozen?
    assert_equal "disconnected", snake.connection_state
    assert snake.alive?, "a disconnect never eliminates a snake"

    # The whole field advances; the frozen snake does not.
    other_start = other.head.dup
    5.times { world.step! }

    assert_equal before[:body], snake.body
    assert_equal before[:direction], snake.direction.name
    assert_equal before[:score], snake.score
    assert_equal before[:length], snake.length
    assert_equal before[:food], snake.food.cell
    assert_equal 0, snake.survived_ticks, "frozen time is never survival credit"
    assert_equal 5, snake.frozen_ticks
    refute_equal other_start, other.head, "everyone else keeps playing"
  end

  def test_snapshot_carries_frozen_flag_deadline_and_connection_state
    freeze!
    player = world.snapshot["p"].find { |entry| entry["i"] == snake.id }

    assert_equal true, player["fr"]
    assert_equal NOW + GRACE_MS, player["gu"]
    assert_equal "disconnected", player["cy"]
    assert_equal 0, player["fz"]
    assert_equal NOW, world.snapshot["ts"]
    assert_equal "right", player["d"]
  end

  def test_server_clock_owns_the_unfreeze_deadline
    freeze!
    world.step!

    assert_empty world.expire_freezes!(now_ms: NOW + GRACE_MS - 1)
    assert snake.frozen?, "one millisecond early is still frozen"

    assert_equal [snake.id], world.expire_freezes!(now_ms: NOW + GRACE_MS)
    refute snake.frozen?
    assert snake.alive?, "an expired grace period NEVER eliminates the snake"
    assert_equal "unattended", snake.connection_state
    assert_equal "right", snake.direction.name, "last valid direction is retained"

    head = snake.head.dup
    world.step!
    assert_equal [head[0] + 1, head[1]], snake.head, "it resumes in its last valid direction"
    assert_equal 1, snake.survived_ticks
  end

  def test_reconnect_within_grace_restores_control
    3.times { world.step! }
    freeze!
    assert snake.frozen?

    assert_equal :resumed, world.resume_player!(snake.id)
    refute snake.frozen?
    assert_nil snake.frozen_until_ms
    assert_equal "connected", snake.connection_state
    assert snake.alive?

    outcome = world.apply_input(player_id: snake.id, direction: Simulation::Direction.parse("up"),
                                tick: world.tick, seq: 1)
    assert_equal :accepted, outcome
    world.step!
    assert_equal "up", snake.direction.name
    assert_equal "connected", snake.connection_state
  end

  def test_reconnect_after_the_grace_period_while_alive_takes_control_again
    freeze!(until_ms: NOW + GRACE_MS)
    world.expire_freezes!(now_ms: NOW + GRACE_MS)
    3.times { world.step! }
    assert snake.alive?

    assert_equal :resumed, world.resume_player!(snake.id)
    assert_equal :accepted, world.apply_input(player_id: snake.id,
                                              direction: Simulation::Direction.parse("down"),
                                              tick: world.tick, seq: 2)
    world.step!
    assert_equal "down", snake.direction.name
    assert snake.alive?
  end

  def test_frozen_and_unattended_snakes_refuse_stale_input
    freeze!
    assert_equal :frozen, world.apply_input(player_id: snake.id,
                                            direction: Simulation::Direction.parse("up"),
                                            tick: world.tick, seq: 1)
    world.expire_freezes!(now_ms: NOW + GRACE_MS)
    assert_equal :disconnected, world.apply_input(player_id: snake.id,
                                                 direction: Simulation::Direction.parse("up"),
                                                 tick: world.tick, seq: 2)
    world.resume_player!(snake.id)
    assert_equal :accepted, world.apply_input(player_id: snake.id,
                                              direction: Simulation::Direction.parse("up"),
                                              tick: world.tick, seq: 3)
  end

  def test_a_snake_released_after_grace_can_still_die_by_normal_collision_rules
    # U-shaped body whose next cell (down) is its own middle: after the release
    # the next movement tick must eliminate it by the ordinary self-collision
    # rule. The timeout itself did NOT kill it.
    place(world, snake, body: [[5, 5], [4, 5], [4, 6], [5, 6], [6, 6], [6, 5]], direction: "down")
    freeze!
    world.expire_freezes!(now_ms: NOW + GRACE_MS)
    assert snake.alive?, "expiry is not elimination"

    world.step!
    refute snake.alive?
    assert_equal "self_collision", snake.elimination_reason.to_s
  end

  def test_reconnecting_after_a_natural_death_returns_an_eliminated_snake
    snake.eliminate!(at_tick: world.tick, reason: :self_collision)
    assert_equal :eliminated, world.resume_player!(snake.id)
    refute snake.frozen?
    assert_equal "connected", snake.connection_state
    refute snake.alive?
    assert_equal false, world.snapshot["p"].find { |entry| entry["i"] == snake.id }["a"]
  end

  def test_frozen_ticks_never_inflate_the_survival_tiebreaker
    world.snakes.each { |entry| entry.score = 5 }
    freeze!
    other_head = other.head
    20.times { world.step! }

    assert_equal 0, snake.survived_ticks
    assert_equal 20, other.survived_ticks
    assert_equal snake.id, world.standings.last.id,
                 "equal points -> the snake that actually played longer ranks higher"
    assert other_head != other.head
  end

  def test_checkpoint_round_trip_keeps_the_freeze_and_its_deadline
    freeze!
    state = world.to_state
    restored = Simulation::World.restore(id: world.id, config: world.config,
                                        participants: [{ id: snake.id, name: snake.name,
                                                         color_hex: snake.color_hex,
                                                         color_slot: snake.color_slot },
                                                       { id: other.id, name: other.name,
                                                         color_hex: other.color_hex,
                                                         color_slot: other.color_slot }],
                                        state: state)
    restored.server_time_ms = NOW

    restored_snake = restored.player(snake.id)
    assert restored_snake.frozen?
    assert_equal NOW + GRACE_MS, restored_snake.frozen_until_ms
    assert_equal "disconnected", restored_snake.connection_state
    assert_empty restored.expire_freezes!(now_ms: NOW + GRACE_MS - 1)
    assert_equal [snake.id], restored.expire_freezes!(now_ms: NOW + GRACE_MS)
    assert restored.player(snake.id).alive?
  end

  def test_tick_limit_does_not_bypass_a_freeze
    tiny = build_world(participants: 2, max_ticks: 10, seed: 21)
    tiny.freeze_player!(tiny.snakes.first.id, now_ms: NOW, until_ms: NOW + GRACE_MS)
    10.times { tiny.step! }
    assert_equal 10, tiny.tick
    assert tiny.completed?
    assert tiny.snakes.first.alive?
  end
end

# Step 10 (round 2): the round clock may never run down because of a browser.
class FrozenDurationTest < Minitest::Test
  include SimulationTestSupport

  NOW = 1_700_000_000_000

  def test_duration_clock_pauses_while_nobody_can_move
    world = build_world(participants: 2, max_ticks: 10, seed: 5)
    world.freeze_player!(world.snakes[0].id, now_ms: NOW, until_ms: NOW + 30_000)
    world.freeze_player!(world.snakes[1].id, now_ms: NOW, until_ms: NOW + 30_000)

    9.times { world.step! }
    assert_equal 9, world.tick, "logical ticks still advance"
    assert_equal 0, world.active_ticks, "no movement, no duration consumed"
    refute world.completed?, "an all-frozen board must never time out into a result"

    # One snake comes back: movement progress resumes, and only then does the
    # 10-tick duration start being spent again.
    world.resume_player!(world.snakes[0].id)
    10.times { world.step! }
    assert_equal 10, world.active_ticks
    assert world.completed?
    assert_equal :tick_limit, world.end_reason
    assert world.snakes.all?(&:alive?), "timeout must not kill anybody"
  end

  def test_one_moving_snake_keeps_the_round_clock_honest
    world = build_world(participants: 2, max_ticks: 10, seed: 6)
    world.freeze_player!(world.snakes[1].id, now_ms: NOW, until_ms: NOW + 30_000)
    10.times { world.step! }
    assert world.completed?, "an actively playing snake still ends on time"
    assert_equal 10, world.active_ticks
    assert world.snakes[1].alive?, "the frozen player is not punished by the ending"
  end

  def test_active_ticks_survive_a_checkpoint_round_trip
    world = build_world(participants: 2, max_ticks: 50, seed: 8)
    3.times { world.step! }
    state = world.to_state
    assert_equal 3, state["active_ticks"]
    restored = Simulation::World.restore(id: world.id, config: world.config,
                                        participants: world.snakes.map { |s|
                                          { id: s.id, name: s.name, color_hex: s.color_hex, color_slot: s.color_slot }
                                        }, state: state)
    assert_equal 3, restored.active_ticks
    assert_equal world.tick, restored.tick
  end
end
