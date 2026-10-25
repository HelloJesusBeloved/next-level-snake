require "test_helper"

# Step 10 performance regression guards. These assert the shape of the SQL the
# hot paths emit, so a future change cannot silently reintroduce the row locks,
# per-participant reloads and 10 Hz snapshot writes that made Brawls laggy.
# No test sleeps.
class MultiplayerPerformanceTest < ActiveSupport::TestCase
  T0 = Time.current.change(usec: 0)

  setup do
    @room = make_room_with_guest_host
    @rival = make_guest.first
    @seat = @room.join!(guest_session: @rival, display_name: "Rival")
    @room.start_match!
    @match = @room.live_match
    @participant = @match.match_participants.find_by(room_membership_id: @seat.id)
    MatchRunner.reset!
    # Rows from other tests are invisible inside this transaction anyway; drop
    # any operator leftovers so query-count assertions only see this match.
    Match.live.where.not(id: @match.id).delete_all
  end

  teardown do
    MatchRunner.shutdown!
    MatchRunner.reset!
  end

  def capture_sql
    statements = []
    callback = lambda do |_name, _start, _finish, _id, payload|
      next if payload[:cached] || payload[:name] == "SCHEMA" || payload[:sql].blank?

      statements << payload[:sql].squish
    end
    ActiveSupport::Notifications.subscribed(callback, "sql.active_record") { yield }
    statements
  end

  def attach_runner
    MatchRunner.tick_once(monotonic_ms: 0)
    assert_equal [@match.id], MatchRunner.supervisor.match_ids
    MatchRunner.supervisor
  end

  test "idle simulator passes take no row locks, no per-player reloads and no snapshot writes" do
    attach_runner
    MatchRunner.tick_once(monotonic_ms: 100) # first broadcast + persist are allowed

    statements = capture_sql do
      3.times { |i| MatchRunner.tick_once(monotonic_ms: 200 + i * 50) }
    end

    refute statements.any? { |sql| sql.match?(/FOR UPDATE/i) },
           "the simulator pass must not take row locks: #{statements.grep(/FOR UPDATE/).first}"
    refute statements.any? { |sql| sql.match?(/UPDATE "matches".*live_snapshot/m) },
           "snapshots are persisted on their own low-frequency cadence"
    refute statements.any? { |sql| sql.match?(/FROM "match_participants".*WHERE "match_participants"."id" =/m) },
           "no per-participant reload"
    assert_operator statements.size, :<=, 15,
                    "an idle pass should be a handful of indexed reads, was #{statements.size}: #{statements.inspect}"
  end

  test "connection reconciliation is one read while everybody is connected" do
    world = @match.build_world
    world.start! if world.pending?
    @match.update!(owner_token: "perf", lease_expires_at: T0 + 30.seconds)

    statements = capture_sql { @match.sync_connection_states!(world, now: T0) }
    refute statements.any? { |sql| sql.match?(/^\s*(UPDATE|INSERT|DELETE)/i) },
           "a clean pass must not write: #{statements.inspect}"
    assert_equal 1, statements.count { |sql| sql.include?("FROM \"match_participants\"") },
                 "participants are loaded with one query, not one per player"
    refute statements.any? { |sql| sql.match?(/FOR UPDATE/i) }
  end

  test "a keypress is accepted without a row lock or a full match reload" do
    input = Simulation::Protocol::Input.new(match_id: @match.id, seq: 1, tick: 0,
                                           direction: Simulation::Direction.parse("up"))
    statements = capture_sql do
      assert_equal :queued, @match.accept_direction!(membership: @seat, input: input, now: Time.current)
    end

    refute statements.any? { |sql| sql.match?(/FOR UPDATE/i) },
           "steering must never wait on the simulator's match lock"
    refute statements.any? { |sql| sql.match?(/SELECT .*FROM "matches"/m) && sql.include?('"matches".*') },
           "no full match row is loaded per keypress"
    assert_operator statements.size, :<=, 8, "bounded query count per keypress: #{statements.inspect}"
  end

  test "socket broadcasts run far ahead of durable writes" do
    attach_runner
    MatchRunner.tick_once(monotonic_ms: 100)

    statements = capture_sql do
      15.times { |i| MatchRunner.tick_once(monotonic_ms: 200 + i * 66) }
    end

    durable_writes = statements.count { |sql| sql.match?(/UPDATE "matches"/) && sql.include?("live_snapshot") }
    assert_operator durable_writes, :<=, 1,
                    "persisting a jsonb frame must not happen at network cadence (got #{durable_writes})"
  end

  # Snake is a discrete grid game: one authoritative frame per movement tick is
  # exactly what the client needs to draw crisp, non-smoothed motion. More
  # frames are duplicates (and an uneven frame/tick ratio reads as stutter);
  # fewer frames drop movement.
  test "exactly one snapshot frame is broadcast per movement tick" do
    attach_runner
    frames = []
    subscriber = ActiveSupport::Notifications.subscribe("broadcast.action_cable") do |_n, _s, _f, _i, payload|
      frames << payload[:message] if payload[:message].is_a?(Hash) && payload[:message]["type"] == "snapshot"
    end

    world = MatchRunner.supervisor.entries.fetch(@match.id).world
    start_tick = world.tick
    # Drive several passes faster than the tick so duplicate broadcasts would
    # show up immediately if the cadence were time-based rather than tick-based.
    40.times { |i| MatchRunner.tick_once(monotonic_ms: 100 + i * 20) }
    ActiveSupport::Notifications.unsubscribe(subscriber)

    advanced = world.tick - start_tick
    assert_operator advanced, :>, 0, "the world must actually advance"
    refute_empty frames, "the probe must observe real broadcasts"
    ticks = frames.map { |frame| frame["t"] }
    assert_equal ticks.uniq, ticks, "no tick is broadcast twice: #{ticks.inspect}"
    assert_equal ticks.sort, ticks, "frames arrive in tick order: #{ticks.inspect}"
    assert_equal advanced, frames.size,
                 "one frame per movement tick (#{frames.size} frames for #{advanced} ticks)"
    # 40 passes of 20 ms is 800 ms of wall clock; a 15 Hz time-based cadence
    # would have produced ~12 frames for these ~8 ticks.
    assert_operator frames.size, :<, 40, "frames follow ticks, not scheduler passes"
  end

  test "presence heartbeats are throttled instead of writing on every poll" do
    membership = @room.host_membership
    statements = capture_sql do
      5.times { membership.mark_seen_throttled!(at: T0 + 1.second, interval: 15) }
    end
    writes = statements.count { |sql| sql.match?(/UPDATE "room_memberships"/) }
    assert_operator writes, :<=, 1, "five polls produce at most one presence write"
  end
end

class TickBoundaryInputTest < ActiveSupport::TestCase
  setup do
    @room = make_room_with_guest_host
    @member = make_guest_membership(@room, "Rival")
    @room.start_match!
    @match = @room.live_match
    MatchRunner.reset!
    Match.live.where.not(id: @match.id).delete_all
    MatchRunner.tick_once(monotonic_ms: 0)
  end

  teardown do
    MatchRunner.shutdown!
    MatchRunner.reset!
  end

  test "a steering intent near the boundary is applied before the same tick" do
    entry = MatchRunner.supervisor.entries.fetch(@match.id)
    snake = entry.world.player(@match.match_participants.find_by(room_membership_id: @member.id).id)

    input = Simulation::Protocol::Input.new(match_id: @match.id, seq: 1, tick: 0,
                                            direction: Simulation::Direction.parse("up"))
    assert_equal :queued, @match.accept_direction!(membership: @member, input: input)
    # Another opportunistic pass just ran: the input cannot be left queued
    # until *next* tick on the strength of a 30 ms poll throttle.
    MatchRunner.input_poll_at[@match.id] = 100
    assert_equal 0, snake.last_seq, "the command still waits on the server before the boundary"

    MatchRunner.tick_once(monotonic_ms: 105)
    assert_equal 1, entry.world.tick, "the scheduler advanced one movement tick"
    assert_equal "up", snake.direction.name, "the new turn already belongs to the tick"
    assert_equal 1, snake.last_seq, "the intent was consumed before movement"
  end

  test "the inter-tick poll remains throttled and has no extra tick-time write" do
    entry = MatchRunner.supervisor.entries.fetch(@match.id)
    MatchRunner.input_poll_at[@match.id] = 100
    assert_equal true, MatchRunner.deliver_inputs(entry.world, monotonic_ms: 103)
    assert_nil @match.match_inputs.order(:id).first, "an empty queue stays empty"
    assert_equal 0, entry.world.tick, "throttling alone does not advance the world"
  end
end
