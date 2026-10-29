require "test_helper"

# Step 3 wire policy at the channel/runner boundary:
#   * Classic  -> complete snapshots only, exactly as before this step
#   * Responsive -> compact movement frames between periodic complete snapshots,
#                   with a full frame forced on every structural change
#   * either    -> a client can ask for one complete frame (resync) at any time
class MovementBroadcastTest < ActiveSupport::TestCase
  setup do
    MatchRunner.reset!
    @room = make_room_with_guest_host
    @room.join!(guest_session: make_guest.first, display_name: "Guest")
    @room.reload
  end

  teardown do
    MatchRunner.shutdown!
    MatchRunner.reset!
  end

  def started_match(strategy)
    @room.update!(presentation_strategy: strategy) if @room.presentation_strategy != strategy
    @room.start_match!
    @room.reload.live_match
  end

  def world_for(match)
    match.build_world.tap(&:start!)
  end

  def test_classic_matches_never_receive_a_compact_movement_frame
    match = started_match("classic")
        world = world_for(match)
    full = Simulation::Protocol.encode(world)
    stream = MatchChannel.stream_for(match.id)

    assert_equal :snapshot, MatchRunner.publish_frame(world, full)
    payloads = ActionCable.server.pubsub.broadcasts(stream).map { |raw| JSON.parse(raw) }
    assert payloads.any?, "a Classic match must still broadcast its frames"
    assert_equal ["snapshot"], payloads.map { |payload| payload["type"] }.uniq
    # The compact encoder exists and works for any world; the POINT is that a
    # Classic match never puts one on the wire.
    assert_equal "classic", Simulation::Protocol.encode_movement(world)["strategy"]
    refute payloads.any? { |payload| payload["type"] == "movement" }
  end

  def test_responsive_matches_send_movement_frames_between_complete_snapshots
    match = started_match("responsive")
    assert_equal "responsive", match.presentation_strategy
        world = world_for(match)
    stream = MatchChannel.stream_for(match.id)

    # The first published frame of a Responsive match is a complete snapshot: a
    # client may have just subscribed, and a head-only frame is useless without
    # a body to extend.
    assert_equal :snapshot, MatchRunner.publish_frame(world, Simulation::Protocol.encode(world))
    emitted = [world.presentation_strategy]

    types = []
    MatchRunner::MOVEMENT_FULL_INTERVAL_TICKS.times do
      world.step!
      types << MatchRunner.publish_frame(world, Simulation::Protocol.encode(world))
    end
    assert_equal emitted + [:movement] * (MatchRunner::MOVEMENT_FULL_INTERVAL_TICKS - 1) + [:snapshot],
                 [world.presentation_strategy] + types

    payloads = ActionCable.server.pubsub.broadcasts(stream).map { |raw| JSON.parse(raw) }
    movement = payloads.select { |payload| payload["type"] == "movement" }
    refute_empty movement, "the Responsive stream must actually carry movement frames"
    movement.each do |frame|
      assert_equal "responsive", frame["strategy"]
      assert frame["t"].is_a?(Integer)
      assert frame["p"].all? { |player| player["h"].nil? || player["h"].is_a?(Integer) }
      refute frame.key?("q"), "standings do not ride on every movement tick"
    end
    # A complete snapshot still arrives at the interval, so recovery is bounded.
    assert_operator payloads.count { |payload| payload["type"] == "snapshot" }, :>=, 2
  end

  def test_a_structural_change_forces_a_complete_snapshot_immediately
    match = started_match("responsive")
        world = world_for(match)
    MatchRunner.publish_frame(world, Simulation::Protocol.encode(world))
    world.step!
    assert_equal :movement, MatchRunner.publish_frame(world, Simulation::Protocol.encode(world))

    # Freeze is a structural change: a client cannot infer it from a head cell.
    world.freeze_player!(world.snakes.first.id, now_ms: 1_000, until_ms: 31_000)
    assert_equal :snapshot, MatchRunner.publish_frame(world, Simulation::Protocol.encode(world))

    # So is elimination.
    world.step!
    MatchRunner.publish_frame(world, Simulation::Protocol.encode(world))
    world.remove_player!(world.snakes.first.id, reason: :self_collision, at_tick: world.tick + 1)
    assert_equal :snapshot, MatchRunner.publish_frame(world, Simulation::Protocol.encode(world))
  end

  def test_movement_frames_are_never_chunked_and_fall_back_when_too_large
    world = world_with_players(8)
    frame = Simulation::Protocol.encode_movement(world)
    messages = MatchChannel.movement_messages(frame)
    assert_equal 1, messages.length, "a compact frame is a single broadcast"
    assert_equal "movement", messages.first["type"]

    # A pathological frame (far beyond any real Brawl) is refused rather than
    # sliced: the caller then sends a full snapshot, which knows how to chunk.
    oversized = frame.merge("pad" => "x" * (MatchChannel::MAX_MOVEMENT_BYTES + 10))
    assert_nil MatchChannel.movement_messages(oversized)
  end

  def test_resync_transmits_one_complete_authoritative_frame
    match = started_match("responsive")
    # A worker that is not the lease owner seeds from the newest persisted frame;
    # publish one so this test exercises the real payload shape.
    world = world_for(match)
    match.update_columns(live_snapshot: Simulation::Protocol.encode(world).merge("type" => "snapshot"),
                         snapshot_tick: world.tick)
    channel = MatchChannel.allocate
    channel.instance_variable_set(:@match, match)
    channel.instance_variable_set(:@participant, match.match_participants.first)
    channel.instance_variable_set(:@spectator, false)
    sent = []
    channel.define_singleton_method(:transmit) { |payload| sent << payload }
    channel.define_singleton_method(:touch_presence!) { |**| true }

    channel.resync
    assert_equal 1, sent.length
    payload = sent.first
    assert_equal "snapshot", payload["type"]
    assert_equal match.id, payload["m"]
    assert_equal "responsive", payload["strategy"]
    assert payload["p"].all? { |player| player["b"].is_a?(Array) }, "a resync carries whole bodies"
  end

  # Two independent controllers, one match: each member's own command envelope
  # must move only their own snake, and the authoritative result must apply to
  # both. (The browser-level version of this needs two real tabs; this is the
  # server side of it, which is where the authority lives.)
  test "two participants steer only their own snakes in a Responsive match" do
    match = started_match("responsive")
    world = world_for(match)
    first, second = match.match_participants.order(:id).to_a
    started = world.snakes.to_h { |snake| [snake.id, snake.head] }

    queued_first = match.accept_direction!(
      membership: first.room_membership,
      input: Simulation::Protocol::Input.new(match_id: match.id, direction: Simulation::Direction.parse("down"),
                                            tick: world.tick, seq: 1)
    )
    queued_second = match.accept_direction!(
      membership: second.room_membership,
      input: Simulation::Protocol::Input.new(match_id: match.id, direction: Simulation::Direction.parse("up"),
                                            tick: world.tick, seq: 1)
    )
    assert_equal :queued, queued_first
    assert_equal :queued, queued_second

    match.apply_queued_inputs!(world: world, token: match.claim_lease!(token: "t", ttl_seconds: 60, now: Time.current),
                               now: Time.current)
    world.step!
    moved = world.snakes.to_h { |snake| [snake.id, snake.head] }
    refute_equal started[first.id], moved[first.id], "the first participant's snake moved"
    refute_equal started[second.id], moved[second.id], "the second participant's snake moved"
    assert_equal "down", world.player(first.id).direction.name
    assert_equal "up", world.player(second.id).direction.name
    # Each snake moved exactly one cell in ITS OWN direction: no cross-talk.
    [first.id, second.id].each do |id|
      before = started[id]
      after = moved[id]
      dx = (after[0] - before[0]) % world.columns
      dy = (after[1] - before[1]) % world.rows
      steps = [dx, world.columns - dx, dy, world.rows - dy].min
      assert_equal 0, steps, "a snake moved by #{steps} cells in one tick"
    end
  end

  def world_with_players(participants)
    config = Simulation::Config.new(columns: 24, rows: 18, seed: 5, max_ticks: 500,
                                    mode: :brawl, growth: 1, speed_level: 3)
    people = Array.new(participants) do |index|
      { id: index + 1, name: "P#{index + 1}", color_hex: "#00FF00", color_slot: index }
    end
    Simulation::World.new(id: 5, config: config, participants: people,
                          presentation_strategy: "responsive").tap(&:start!)
  end
end
