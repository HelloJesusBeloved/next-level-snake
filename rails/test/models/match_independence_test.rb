require "test_helper"

# The match must not depend on any single player's browser: not for its
# cadence, not for its recovery, and above all not for whether it ends.
class MatchIndependenceTest < ActiveSupport::TestCase
  T0 = Time.current.change(usec: 0)

  setup do
    @room = make_room_with_guest_host
    @rival = make_guest.first
    @seat = @room.join!(guest_session: @rival, display_name: "Rival")
    @room.start_match!
    @match = @room.live_match
    MatchRunner.reset!
    Match.live.where.not(id: @match.id).delete_all
  end

  teardown do
    MatchRunner.shutdown!
    MatchRunner.reset!
  end

  def participant_for(membership)
    @match.match_participants.find_by(room_membership_id: membership.id)
  end

  test "every player disconnecting freezes snakes but never finishes the round" do
    [@room.host_membership, @seat].each do |membership|
      token = "tab-#{membership.id}"
      @match.register_presence!(membership: membership, socket_token: token, now: T0)
      @match.release_presence!(socket_token: token, now: T0)
    end

    MatchRunner.tick_once(monotonic_ms: 0, now: T0)
    world = MatchRunner.supervisor.entries.fetch(@match.id).world
    assert world.snakes.all?(&:frozen?), "both snakes are frozen"

    # 200 simulated seconds of total silence: far past the 180 s duration. The
    # only clock is the one the server owns, and every snake is frozen.
    40.times do |i|
      MatchRunner.tick_once(monotonic_ms: 5_000 + i * 5_000, now: T0 + i * 5.seconds)
    end

    @match.reload
    assert_includes %w[running pending], @match.status,
                    "an all-frozen board must never time out into a result"
    assert_nil @match.end_reason
    assert_equal "in_match", @room.reload.state
    assert world.snakes.all?(&:alive?), "nobody is eliminated for being away"
  end

  test "grace expiry returns the snake to play instead of ending it" do
    token = "host-tab"
    membership = @room.host_membership
    @match.register_presence!(membership: membership, socket_token: token, now: T0)
    @match.release_presence!(socket_token: token, now: T0)
    participant = participant_for(membership)
    assert_equal "disconnected", participant.reload.connection_state

    MatchRunner.tick_once(monotonic_ms: 0, now: T0)
    world = MatchRunner.supervisor.entries.fetch(@match.id).world
    assert world.player(participant.id).frozen?

    MatchRunner.tick_once(monotonic_ms: 31_000, now: T0 + 31.seconds)
    snake = MatchRunner.supervisor.entries.fetch(@match.id).world.player(participant.id)
    refute snake.frozen?, "the server released it on its own clock"
    assert snake.alive?
    assert_equal "unattended", participant.reload.connection_state
  end

  test "seeding a reconnecting socket never blocks on the simulator mutex" do
    MatchRunner.tick_once(monotonic_ms: 0)
    held = Queue.new
    release = Queue.new
    # Simulate a slow simulator pass holding the global lock (a stalled database
    # round trip, a checkpoint, anything).
    blocker = Thread.new do
      MatchRunner.mutex.synchronize do
        held << :held
        release.pop
      end
    end
    held.pop

    begin
      frame = nil
      Timeout.timeout(2) { frame = MatchRunner.live_snapshot_for(@match.id) }
      refute_nil frame, "the owner's cached frame must be served without locking"
    ensure
      release << :go
      blocker.join(3)
    end
    assert blocker.join(3), "the blocker thread must still be running its own work"
  end

  test "a match with no recoverable progress is interrupted, never stranded" do
    MatchRunner.tick_once(monotonic_ms: 0)
    world = MatchRunner.supervisor.entries.fetch(@match.id).world
    world.start! if world.pending?
    world.step!
    # Simulate a crash after movement but before any checkpoint was written.
    @match.update_columns(checkpoint: {}, checkpoint_tick: 0, status: "running",
                          owner_token: "gone", lease_expires_at: T0 - 1.hour)
    MatchRunner.reset!

    MatchRunner.tick_once(monotonic_ms: 10_000, now: T0)
    @match.reload
    assert_equal "interrupted", @match.status
    assert_nil @match.winner_membership_id, "no winner may be invented"
    assert_equal [nil, nil], @match.standings.map(&:placement), "no fabricated standings"
    assert_not_equal "in_match", @room.reload.state,
                     "the room must not be left stuck in_match with a dead match"
  end

  test "a stranded room is healed by the server loop with no client request" do
    # Room says in_match but its match is finished: the classic stuck state.
    @match.update_columns(status: "completed", ended_at: T0, owner_token: nil,
                          lease_expires_at: nil)
    @room.update_columns(state: "in_match")

    MatchRunner.tick_once(monotonic_ms: 0, now: T0)
    20.times { |i| MatchRunner.tick_once(monotonic_ms: 1_000 * (i + 1), now: T0) }

    assert_equal "lobby", @room.reload.state
    assert @room.room_memberships.active.all? { |member| member.state != "playing" }
    assert @room.room_memberships.active.none?(&:spectator?), "everyone is seated again"
  end

  test "lobby maintenance runs on the server clock, not on a player's polling" do
    idle = make_room_with_guest_host
    idle_guest = make_guest_membership(idle, "Quiet")
    # Silence past the seat-drop window is what releases a member.
    idle_guest.update_columns(last_seen_at: T0 - Room.config.member_drop - 5)
    idle.update_columns(updated_at: T0 - Room.config.member_drop - 5)

    # Only the simulator loop runs; no HTTP request touches the room.
    MatchRunner.tick_once(monotonic_ms: 0, now: T0)
    20.times { |i| MatchRunner.tick_once(monotonic_ms: 1_000 * (i + 1), now: T0) }

    idle_guest.reload
    assert_equal "left", idle_guest.state,
                 "the silent member is released by the server, not by a peer's poll"
  end
end
