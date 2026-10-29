require "test_helper"

class MatchRunnerTest < ActiveSupport::TestCase
  def started_room
    room = make_room_with_guest_host
    room.join!(guest_session: make_guest.first, display_name: "Rival")
    room.start_match!
    room
  end

  setup do
    MatchRunner.reset!
    # This suite claims every free match in the database. Ignore rows left
    # behind by an operator-run simulator or a crashed previous run so results
    # depend only on the matches each test creates (rolled back afterwards).
    Match.live.delete_all
  end
  teardown do
    MatchRunner.shutdown!
    MatchRunner.reset!
  end

  test "queued input is later marked applied or rejected at an authoritative tick" do
    room = started_room
    match = room.live_match
    membership = room.host_membership
    participant = match.match_participants.find_by!(room_membership_id: membership.id)
    MatchRunner.tick_once(monotonic_ms: 0)
    world = MatchRunner.supervisor.entries.fetch(match.id).world
    snake = world.player(participant.id)
    direction = %w[up down left right].map { |name| Simulation::Direction.parse(name) }
                        .find { |candidate| !candidate.same_as?(snake.direction) && !candidate.reverse_of?(snake.direction) }
    stream = MatchChannel.stream_for(match.id)

    input = Simulation::Protocol::Input.new(match_id: match.id, direction: direction, tick: 0, seq: 1)
    assert_equal :queued, match.accept_direction!(membership: membership, input: input)
    before = ActionCable.server.pubsub.broadcasts(stream).length
    assert MatchRunner.deliver_inputs(world, force: true)
    applied = ActionCable.server.pubsub.broadcasts(stream).drop(before).map { |raw| JSON.parse(raw) }
                              .find { |event| event["type"] == "input_applied" }
    assert_equal({ "type" => "input_applied", "v" => 1, "match" => match.id,
                   "participant" => participant.id, "seq" => 1, "status" => "applied", "tick" => 1 }, applied)

    snapshot = Simulation::Protocol.encode(world)
    player = snapshot.fetch("p").find { |entry| entry["i"] == participant.id }
    assert_equal 0, snapshot["t"], "the state version remains the server simulation tick"
    assert_equal 1, player["is"], "the snapshot carries the applied input sequence"
    assert_equal 1, player["it"], "the snapshot names its movement tick"

    duplicate = Simulation::Protocol::Input.new(match_id: match.id, direction: direction, tick: 0, seq: 2)
    assert_equal :queued, match.accept_direction!(membership: membership, input: duplicate)
    before = ActionCable.server.pubsub.broadcasts(stream).length
    assert MatchRunner.deliver_inputs(world, monotonic_ms: 31, force: true)
    rejected = ActionCable.server.pubsub.broadcasts(stream).drop(before).map { |raw| JSON.parse(raw) }
                               .find { |event| event["type"] == "input_rejected" }
    assert_equal "input_rejected", rejected["type"]
    assert_equal "rejected", rejected["status"]
    assert_equal match.id, rejected["match"]
    assert_equal participant.id, rejected["participant"]
    assert_equal 2, rejected["seq"]
    assert_equal "duplicate_direction", rejected["reason"]
    assert_equal 0, rejected["tick"]
    assert_not MatchInput.exists?(match_participant_id: participant.id, input_seq: 2)
  end

  test "claims a pending match, establishes the baseline, then advances on monotonic time" do
    match = started_room.live_match

    report = MatchRunner.tick_once(monotonic_ms: 0)
    assert_equal [match.id], report[:claimed]
    match.reload
    assert_equal "running", match.status
    assert_equal 0, match.tick
    assert match.owner_token.present?, "the runner owns the lease"
    assert_equal MatchRunner.token, match.owner_token

    world = MatchRunner.supervisor.entries.fetch(match.id).world
    assert_equal 0, world.tick
    MatchRunner.tick_once(monotonic_ms: match.tick_ms)
    assert_equal 1, world.tick, "the in-memory world advances every scheduler pass"
    MatchRunner.tick_once(monotonic_ms: match.tick_ms * 2)
    assert_equal 2, world.tick
    # PostgreSQL is not written on every tick: DB tick only moves on checkpoints.
    assert_equal 0, match.reload.tick
  end

  test "runs to the tick limit and persists standings once" do
    match = started_room.live_match
    match.update!(max_ticks: 10, columns: 96, rows: 72)
    MatchRunner.tick_once(monotonic_ms: 0)
    6.times { |call| MatchRunner.tick_once(monotonic_ms: match.tick_ms * 2 * (call + 1)) }

    match.reload
    assert_equal "completed", match.status
    assert_equal 10, match.tick
    assert_equal [1, 2], match.match_participants.order(:placement).pluck(:placement)
    assert_nil match.owner_token, "completion frees the lease"
    assert_empty MatchRunner.supervisor.match_ids
  end

  test "writes a periodic checkpoint without touching the database every tick" do
    match = started_room.live_match
    match.update!(columns: 96, rows: 72)
    MatchRunner.tick_once(monotonic_ms: 0)
    checkpoints = []
    4.times do |call|
      MatchRunner.tick_once(monotonic_ms: match.tick_ms * 5 * (call + 1))
      checkpoints << match.reload.checkpoint_tick
    end
    assert_operator checkpoints.uniq.length, :<, match.tick + 1,
                    "checkpoints are periodic, not per tick"
    assert_operator match.checkpoint_tick, :>, 0
  end

  # End-to-end guard for the renewal bug: twenty passes over ten simulated
  # seconds is longer than the six-second lease TTL, so a simulator that failed
  # to renew would lose the match. Ownership must survive and stay unstealable.
  test "keeps ownership across many scheduler passes past the lease TTL" do
    match = started_room.live_match
    MatchRunner.tick_once(monotonic_ms: 0)
    assert_equal MatchRunner.token, match.reload.owner_token

    20.times { |pass| MatchRunner.tick_once(monotonic_ms: 500 * (pass + 1)) }

    match.reload
    assert_equal MatchRunner.token, match.owner_token
    assert MatchRunner.supervisor.attach?(match.id), "the match is still simulated by this process"
    assert_operator match.lease_expires_at, :>, Time.current, "the lease was renewed, not left to expire"
    refute match.claim_lease!(token: "thief", ttl_seconds: 30), "a renewed lease cannot be stolen"
  end

  test "shutdown releases leases so a takeover is immediate, not expiry-based" do
    match = started_room.live_match
    MatchRunner.tick_once(monotonic_ms: 0)
    assert_equal MatchRunner.token, match.reload.owner_token

    MatchRunner.shutdown!

    assert_nil match.reload.owner_token, "orderly shutdown gives the lease back"
    assert_nil match.lease_expires_at
    assert_empty MatchRunner.supervisor.match_ids
    assert match.claim_lease!(token: "next-process", ttl_seconds: 30)
  end

  test "a checkpoint that already completed is finalized instead of attached forever" do
    match = started_room.live_match
    world = match.build_world
    world.start!
    world.finish!(reason: :tick_limit)
    match.update_columns(status: "running", checkpoint: world.to_state,
                         checkpoint_tick: world.tick, tick: world.tick,
                         owner_token: nil, lease_expires_at: nil)

    MatchRunner.tick_once(monotonic_ms: 0)

    match.reload
    assert_equal "completed", match.status
    assert_equal "tick_limit", match.end_reason
    refute MatchRunner.supervisor.attach?(match.id)
  end

  test "one corrupt match does not block claiming a healthy match" do
    healthy = started_room.live_match
    bad = started_room.live_match
    bad.update_columns(status: "running", checkpoint: { "snakes" => [{ "id" => 999_999 }] },
                       checkpoint_tick: 1, tick: 1)

    report = MatchRunner.tick_once(monotonic_ms: 0)

    assert_includes report[:claimed], healthy.id
    refute MatchRunner.supervisor.attach?(bad.id)
    assert_equal "abandoned", bad.reload.status
    assert_equal "invalid_state", bad.end_reason
  end

  test "a match owned by another process is left untouched" do
    match = started_room.live_match
    assert match.claim_lease!(token: "someone-else", ttl_seconds: 60)

    report = MatchRunner.tick_once(monotonic_ms: 0)
    assert_empty report[:claimed]
    assert_equal "pending", match.reload.status
    assert_equal "someone-else", match.owner_token
  end

  # Step 10 (round 2): an unrecoverable orphan is INTERRUPTED rather than
  # abandoned, because abandoning leaves the room stuck in_match with no match
  # to follow — which is what "the game froze and ended" looks like to players.
  test "an orphaned running match without a checkpoint is interrupted, never replayed" do
    room = started_room
    match = room.live_match
    match.update_columns(status: "running", checkpoint: {}, checkpoint_tick: 0, owner_token: nil)

    MatchRunner.tick_once(monotonic_ms: 0)
    match.reload
    assert_equal "interrupted", match.status
    assert_equal "owner_lost", match.end_reason
    assert_equal [nil], match.match_participants.pluck(:placement).uniq,
                 "an orphan with no checkpoint has no authoritative result"
    assert_nil match.winner_membership_id, "no winner may be invented for it"
    assert_not_equal "in_match", room.reload.state,
                     "the room is returned to the players instead of stranded"
  end

  test "an expired lease with a checkpoint is resumed by a new owner" do
    match = started_room.live_match
    match.update_columns(status: "running", checkpoint: {}, checkpoint_tick: 0,
                         owner_token: "dead-process", lease_expires_at: 1.minute.ago)
    world = match.build_world
    world.start!
    world.step!
    match.update_columns(checkpoint: world.to_state, checkpoint_tick: world.tick, tick: world.tick)

    MatchRunner.tick_once(monotonic_ms: 0)
    match.reload
    assert_equal MatchRunner.token, match.owner_token
    assert_equal "running", match.status
    assert_equal world.tick, match.tick
    assert MatchRunner.supervisor.attach?(match.id)
  end
end
