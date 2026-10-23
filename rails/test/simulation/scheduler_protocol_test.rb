require_relative "simulation_helper"

class SchedulerTest < Minitest::Test
  def test_first_advance_only_establishes_the_monotonic_baseline
    scheduler = Simulation::Scheduler.new(tick_ms: 100, now_ms: nil)
    assert_equal 0, scheduler.advance(now_ms: 5_000)
    assert_equal 0, scheduler.accumulator_ms
  end

  def test_accumulates_elapsed_time_into_discrete_ticks
    scheduler = Simulation::Scheduler.new(tick_ms: 100, now_ms: 0)
    assert_equal 0, scheduler.advance(now_ms: 0)
    assert_equal 1, scheduler.advance(now_ms: 120)
    assert_equal 20, scheduler.accumulator_ms
    assert_equal 1, scheduler.advance(now_ms: 200)
    assert_equal 0, scheduler.accumulator_ms
    assert_in_delta 200, scheduler.last_at_ms, 0.001
  end

  def test_caps_catch_up_work_and_reports_dropped_ticks
    scheduler = Simulation::Scheduler.new(tick_ms: 100, max_catchup_ticks: 3, now_ms: 0)
    scheduler.advance(now_ms: 0)
    steps = scheduler.advance(now_ms: 10_000)
    assert_equal 3, steps, "a long stall never runs an unbounded burst"
    assert_operator scheduler.dropped_ticks, :>, 90
    assert_operator scheduler.accumulator_ms, :<, 100
  end

  def test_ignores_negative_deltas_without_crediting_time
    scheduler = Simulation::Scheduler.new(tick_ms: 100, now_ms: 0)
    scheduler.advance(now_ms: 0)
    assert_equal 0, scheduler.advance(now_ms: -500)
    assert_equal 0, scheduler.accumulator_ms
    scheduler.reset!(now_ms: 500)
    assert_equal 0, scheduler.advance(now_ms: 550), "half a tick is not a tick"
    assert_equal 1, scheduler.advance(now_ms: 650)
  end

  def test_uses_the_monotonic_clock_not_wall_clock
    assert_kind_of Float, Simulation::Scheduler.monotonic_ms
    assert_operator Simulation::Scheduler.monotonic_ms, :>=, 0
    # CLOCK_MONOTONIC has no epoch relationship to Time.now on any platform.
    assert_operator Simulation::Scheduler.monotonic_ms, :<, 10**13
  end
end

class ProtocolTest < Minitest::Test
  include SimulationTestSupport

  def valid_payload
    { "v" => 1, "type" => "input", "match" => 42, "tick" => 3, "seq" => 7, "dir" => "up" }
  end

  def assert_rejected(reason, payload)
    error = assert_raises(Simulation::InvalidInput) { Simulation::Protocol.parse_input(payload) }
    assert_equal reason.to_sym, error.reason
  end

  def test_snapshot_is_compact_versioned_and_carries_tick_board_and_colors
    world = build_world(participants: 2, seed: 4)
    snapshot = world.snapshot
    assert_equal Simulation::VERSION, snapshot["v"]
    assert_equal world.tick, snapshot["t"]
    assert_equal "brawl", snapshot["r"]
    assert_equal({ "c" => 24, "r" => 18 }, snapshot["b"])
    assert_equal 2, snapshot["p"].length
    player = snapshot["p"].first
    assert player["c"].start_with?("#")
    assert_equal 3, player["b"].length
    assert player["b"].all? { |cell| cell.is_a?(Integer) }
    assert_equal world.foods.length, snapshot["f"].length
  end

  def test_parses_only_the_whitelisted_input_shape
    input = Simulation::Protocol.parse_input(valid_payload)
    assert_equal 42, input.match_id
    assert_equal 3, input.tick
    assert_equal 7, input.seq
    assert_equal "up", input.direction.name
    refute input.respond_to?(:player_id), "identity is never accepted from the client"
  end

  def test_rejects_every_attempt_to_submit_authoritative_game_state
    %w[score score_delta position positions body cells winner alive length x y player_id membership_id].each do |field|
      payload = valid_payload.merge(field => 999)
      error = assert_raises(Simulation::InvalidInput) { Simulation::Protocol.parse_input(payload) }
      assert_equal :forbidden_field, error.reason, "#{field} must never be trusted from a browser"
    end
  end

  def test_rejects_unknown_fields_and_bad_envelopes
    assert_rejected(:unknown_field, valid_payload.merge("bonus" => true))
    assert_rejected(:invalid_version, valid_payload.merge("v" => 2))
    assert_rejected(:invalid_type, valid_payload.merge("type" => "snapshot"))
    assert_rejected(:invalid_direction, valid_payload.merge("dir" => "diagonal"))
    assert_rejected(:invalid_tick, valid_payload.merge("tick" => -1))
    assert_rejected(:invalid_sequence, valid_payload.merge("seq" => 0))
    assert_rejected(:invalid_match, valid_payload.merge("match" => "abc"))
    assert_rejected(:invalid_payload, "not-a-hash")
  end

  def test_snapshot_never_contains_other_players_private_identity
    world = build_world(participants: 2)
    keys = world.snapshot["p"].flat_map(&:keys).uniq.sort
    assert_equal %w[a b c d el er i l lg n sc sv], keys
    refute_includes keys, "guest_session_id"
    refute_includes keys, "user_id"
  end
end
