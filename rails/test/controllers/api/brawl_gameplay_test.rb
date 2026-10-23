require "test_helper"

# Step 8: the host starts a real server-authoritative Brawl; direction intents
# are queued durably; only the leased owner applies them; snapshots publish at
# network cadence; completion finalizes point-first standings and the room.
class Api::BrawlGameplayTest < ActionDispatch::IntegrationTest
  setup do
    MatchRunner.reset!
    @host = browser
    @created = post_json(@host, "/api/rooms", display_name: "Ada")
    @code = @created.dig(:room, :code)
    @guest = browser
    @joined = post_json(@guest, "/api/rooms/#{@code}/join", display_name: "Grace")
    @started = post_json(@host, "/api/rooms/#{@code}/start")
    @match = Room.find_by_invitation_code(@code).live_match
  end

  teardown do
    MatchRunner.shutdown!
    MatchRunner.reset!
  end

  def membership_for(session)
    membership_id = get_json(session, "/api/rooms/current").dig(:member, :id)
    RoomMembership.find(membership_id)
  end

  def participant_for(session)
    @match.match_participants.find_by(room_membership_id: membership_for(session).id)
  end

  def make_membership
    room = Room.create_with_host!(guest_session: GuestSession.issue.first, display_name: "Stray")
    room.host_membership
  end

  test "host start freezes board, colors and participants into a durable match" do
    assert_equal 201, status(@host)
    assert_equal true, @started[:started]
    room = Room.find_by_invitation_code(@code)
    assert_equal "in_match", room.state
    assert_equal 2, room.match_configuration["participants"].size
    assert_equal 2, @match.match_participants.count
    colors = @match.match_participants.pluck(:color_hex)
    assert_equal 2, colors.uniq.size
    assert_equal [24, 18], [@match.columns, @match.rows]
    assert_equal "pending", @match.status
  end

  test "non-host and stranger cannot start" do
    stranger = browser
    post_json(stranger, "/api/rooms/#{@code}/start")
    assert_equal 403, status(stranger), "a stranger cannot start a room they never joined"
    assert_equal "not_a_member", body(stranger)[:code]

    post_json(@guest, "/api/rooms/#{@code}/start")
    assert_equal 403, status(@guest), "a non-host member cannot start"
    assert_equal "forbidden", body(@guest)[:code]
    assert_equal 1, Match.where(room_id: Room.find_by_invitation_code(@code).id).count
  end

  test "direction commands are queued with monotonic sequences and reject replays" do
    host_participant = participant_for(@host)
    input = Simulation::Protocol::Input.new(match_id: @match.id,
                                           direction: Simulation::Direction.parse("up"),
                                           tick: 0, seq: 1)
    assert_equal :queued, @match.accept_direction!(membership: membership_for(@host), input: input)
    assert_equal 1, host_participant.reload.last_input_seq
    assert_equal 1, @match.match_inputs.count

    # Replay / regression of the same sequence is rejected.
    assert_equal :stale_sequence, @match.accept_direction!(membership: membership_for(@host), input: input)
    assert_equal :stale_sequence, @match.accept_direction!(membership: membership_for(@host),
                                                          input: input.dup.tap { |i| i.seq = 0 })
    # A membership from another room can never queue into this match.
    assert_equal :not_a_participant, @match.accept_direction!(membership: make_membership,
                                                              input: input.dup.tap { |i| i.seq = 5 })
  end

  test "clients cannot submit positions, scores, bodies or winners as input" do
    participant = participant_for(@host)
    %w[position score body winner player_id cells].each do |field|
      payload = { "v" => 1, "type" => "input", "match" => @match.id,
                  "tick" => 0, "seq" => 50, "dir" => "up", field => 1 }
      assert_raises(Simulation::InvalidInput) { Simulation::Protocol.parse_input(payload) }
    end
    assert_equal 0, @match.match_inputs.count
    assert_equal 0, participant.reload.last_input_seq
  end

  test "the leased owner drains queued directions before a tick and checkpoints acknowledge them" do
    participant = participant_for(@host)
    input = Simulation::Protocol::Input.new(match_id: @match.id,
                                           direction: Simulation::Direction.parse("up"),
                                           tick: 0, seq: 1)
    assert_equal :queued, @match.accept_direction!(membership: membership_for(@host), input: input)

    MatchRunner.tick_once(monotonic_ms: 0) # claims + starts the match
    assert_equal MatchRunner.token, @match.reload.owner_token
    world = MatchRunner.supervisor.entries.fetch(@match.id).world
    assert_equal "running", world.status.to_s

    MatchRunner.tick_once(monotonic_ms: @match.tick_ms + 10)
    snake = world.snakes.find { |s| s.id == participant.id }
    # The queued "up" was consumed into the engine at tick time.
    assert_equal 1, snake.last_seq
    assert_equal 1, @match.match_inputs.reload.count,
                 "applied rows persist until the checkpoint that includes their seq"

    # Advance to the 20-tick checkpoint: the acknowledgement commits atomically
    # with the checkpoint, so a crash replays rather than drops the input.
    20.times { |i| MatchRunner.tick_once(monotonic_ms: @match.tick_ms * (i + 2)) }
    assert_operator @match.reload.checkpoint_tick, :>=, 20
    assert_equal 0, @match.match_inputs.count, "acknowledged after checkpoint"
  end

  test "snapshots publish at network cadence with tick, colors, food and standings" do
    MatchRunner.tick_once(monotonic_ms: 0)
    MatchRunner.tick_once(monotonic_ms: 250)
    MatchRunner.tick_once(monotonic_ms: 500)

    @match.reload
    snapshot = @match.live_snapshot
    assert snapshot, "a complete snapshot is persisted at broadcast cadence"
    assert_equal "snapshot", snapshot["type"]
    assert_equal 1, snapshot["v"]
    assert_operator snapshot["t"], :>=, 0
    assert_equal 2, snapshot["p"].size
    assert_equal 2, snapshot["p"].map { |p| p["c"] }.uniq.size
    assert_equal 2, snapshot["f"].size, "one owned food per player"
    assert_equal 2, snapshot["q"].size, "standings are included"
    assert_operator @match.snapshot_tick, :>=, 0
  end

  test "completion finalizes point-first standings and returns the room to results" do
    MatchRunner.tick_once(monotonic_ms: 0)
    world = MatchRunner.supervisor.entries.fetch(@match.id).world
    eliminated, survivor = world.snakes
    eliminated.score = 9
    eliminated.eliminate!(at_tick: 1, reason: :self_collision)
    survivor.score = 2
    world.finish!(reason: :tick_limit)

    # The next owner pass finalizes the already-completed world.
    MatchRunner.tick_once(monotonic_ms: 1_000)

    @match.reload
    assert_equal "completed", @match.status
    assert_equal "tick_limit", @match.end_reason
    winner = @match.match_participants.find(eliminated.id)
    runner_up = @match.match_participants.find(survivor.id)
    assert_equal 1, winner.placement
    assert_equal 9, winner.final_score
    assert_equal 2, runner_up.placement, "the last survivor is NOT automatically first"
    assert_equal winner.room_membership_id, @match.winner_membership_id
    assert_equal "finished", @match.room.reload.state, "the room returns to results"
    final = @match.live_snapshot
    assert_equal "completed", final["s"]
    assert_equal eliminated.id, final["w"]
  end

  test "one player refreshing or sending garbage cannot corrupt the shared simulation" do
    MatchRunner.tick_once(monotonic_ms: 0)
    world = MatchRunner.supervisor.entries.fetch(@match.id).world
    before = world.snapshot

    # Garbage envelopes are rejected before touching the world.
    assert_raises(Simulation::InvalidInput) do
      Simulation::Protocol.parse_input({ "v" => 1, "type" => "input", "match" => @match.id,
                                         "tick" => 0, "seq" => 1, "dir" => "up", "score" => 999 })
    end
    # Reconnect-style refresh is idempotent: current seat resolves the same room.
    again = get_json(@guest, "/api/rooms/current")
    assert_equal @code, again.dig(:room, :code)

    MatchRunner.tick_once(monotonic_ms: 2_000)
    after = world.snapshot
    assert_equal before["m"], after["m"]
    assert_equal 2, after["p"].size, "the roster is unchanged by the invalid input"
  end
end
