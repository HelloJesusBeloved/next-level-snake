require "test_helper"

class MatchRunnerTest < ActiveSupport::TestCase
  def started_room
    room = make_room_with_guest_host
    room.join!(guest_session: make_guest.first, display_name: "Rival")
    room.start_match!
    room
  end

  setup { MatchRunner.reset! }
  teardown do
    MatchRunner.shutdown!
    MatchRunner.reset!
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

  test "a match owned by another process is left untouched" do
    match = started_room.live_match
    assert match.claim_lease!(token: "someone-else", ttl_seconds: 60)

    report = MatchRunner.tick_once(monotonic_ms: 0)
    assert_empty report[:claimed]
    assert_equal "pending", match.reload.status
    assert_equal "someone-else", match.owner_token
  end

  test "an orphaned running match without a checkpoint is abandoned, never replayed" do
    match = started_room.live_match
    match.update_columns(status: "running", checkpoint: {}, checkpoint_tick: 0, owner_token: nil)

    MatchRunner.tick_once(monotonic_ms: 0)
    match.reload
    assert_equal "abandoned", match.status
    assert_equal "owner_lost", match.end_reason
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
