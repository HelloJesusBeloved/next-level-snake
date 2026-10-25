require "test_helper"

# Step 10 integration coverage for server-owned Brawl disconnections. All
# timelines use injected timestamps (`now:`) — nothing sleeps for 30 seconds.
class BrawlReconnectionTest < ActiveSupport::TestCase
  # A fixed, test-owned origin for every freeze deadline. It is anchored to the
  # real clock only so the PostgreSQL match lease (which uses Time.current) is
  # valid; no assertion ever sleeps or depends on wall-clock progress.
  T0 = Time.current.change(usec: 0)

  setup do
    @room = make_room_with_guest_host
    @rival_guest, _token = make_guest
    @rival_member = @room.join!(guest_session: @rival_guest, display_name: "Rival")
    @room.start_match!
    @match = @room.live_match
    @host_member = @room.host_membership
    @host_participant = @match.match_participants.find_by(room_membership_id: @host_member.id)
    @rival_participant = @match.match_participants.find_by(room_membership_id: @rival_member.id)
    @token = "tab-#{SecureRandom.hex(4)}"
  end

  def connect(member = @rival_member, token: @token, at: T0)
    @match.register_presence!(membership: member, socket_token: token, now: at)
  end

  def disconnect(token: @token, at: T0)
    @match.release_presence!(socket_token: token, now: at)
  end

  def world
    @world ||= begin
      built = @match.build_world
      built.start! if built.pending?
      built
    end
  end

  def rival_snake
    world.player(@rival_participant.id)
  end

  def test_a_disconnect_freezes_only_after_the_last_tab_is_gone
    connect(token: "tab-one")
    connect(token: "tab-two")

    assert_equal :still_connected, disconnect(token: "tab-one")
    @rival_participant.reload
    assert_equal "connected", @rival_participant.connection_state
    assert_nil @rival_participant.freeze_deadline_at

    assert_equal :frozen, disconnect(token: "tab-two", at: T0 + 1.second)
    @rival_participant.reload
    assert_equal "disconnected", @rival_participant.connection_state
    assert_equal T0 + 1.second + Match.freeze_grace_seconds, @rival_participant.freeze_deadline_at
    assert_equal 1, @rival_participant.freeze_windows_used

    # The owner applies the freeze before the next movement tick, preserving
    # the authoritative body/score/direction.
    @match.sync_connection_states!(world, now: T0 + 1.second)
    snake = rival_snake
    assert snake.frozen?
    body = snake.body.map(&:dup)
    score = snake.score
    5.times { world.step! }
    assert_equal body, snake.body
    assert_equal score, snake.score
    assert_equal 0, snake.survived_ticks, "frozen time is never survival credit"
    assert_equal 5, snake.frozen_ticks
    assert snake.alive?
  end

  def test_reconnecting_within_the_grace_window_restores_play
    connect
    disconnect
    @match.sync_connection_states!(world, now: T0 + 5.seconds)
    assert rival_snake.frozen?

    connect(token: "tab-again", at: T0 + 20.seconds)
    @rival_participant.reload
    assert_equal "connected", @rival_participant.connection_state
    assert_nil @rival_participant.freeze_deadline_at

    @match.sync_connection_states!(world, now: T0 + 20.seconds)
    refute rival_snake.frozen?
    assert_equal "connected", rival_snake.connection_state
    assert rival_snake.alive?

    input = Simulation::Protocol::Input.new(match_id: @match.id, seq: 1, tick: 0,
                                            direction: Simulation::Direction.parse("up"))
    assert_equal :queued, @match.accept_direction!(membership: @rival_member, input: input,
                                                   now: T0 + 20.seconds)
  end

  def test_grace_expiry_unfreezes_the_snake_without_eliminating_it
    connect
    disconnect
    @match.sync_connection_states!(world, now: T0)

    # 29.999 s: still the same frozen body.
    @match.sync_connection_states!(world, now: T0 + 29.999.seconds)
    assert rival_snake.frozen?

    # Exactly 30 s: the owner's clock releases it. No client timer is involved.
    @match.sync_connection_states!(world, now: T0 + 30.seconds)
    refute rival_snake.frozen?
    assert rival_snake.alive?
    assert_equal "unattended", @rival_participant.reload.connection_state
    assert_nil @rival_participant.freeze_deadline_at

    head = rival_snake.head.dup
    direction = rival_snake.direction
    world.step!
    expected = [(head[0] + direction.dx) % world.columns,
                (head[1] + direction.dy) % world.rows]
    assert_equal expected, rival_snake.head
    assert rival_snake.alive?, "failing to reconnect must not eliminate anybody"
    assert_equal "unattended", rival_snake.connection_state
  end

  def test_a_late_reconnect_while_alive_takes_control_again
    connect
    disconnect
    @match.sync_connection_states!(world, now: T0 + 30.seconds)
    3.times { world.step! }
    assert rival_snake.alive?

    connect(token: "late-tab", at: T0 + 90.seconds)
    @match.sync_connection_states!(world, now: T0 + 90.seconds)
    assert_equal "connected", @rival_participant.reload.connection_state
    assert_equal "connected", rival_snake.connection_state
    refute rival_snake.frozen?

    input = Simulation::Protocol::Input.new(match_id: @match.id, seq: 4, tick: 0,
                                            direction: Simulation::Direction.parse("left"))
    assert_equal :queued, @match.accept_direction!(membership: @rival_member, input: input,
                                                   now: T0 + 90.seconds)
  end

  def test_repeated_drops_cannot_mint_unlimited_freezes
    connect
    assert_equal :frozen, disconnect
    @rival_participant.reload
    assert_equal 1, @rival_participant.freeze_windows_used

    # Back immediately, drop again inside the cooldown: no second free freeze.
    connect(token: "tab-b", at: T0 + 5.seconds)
    assert_equal :unattended, disconnect(token: "tab-b", at: T0 + 10.seconds)
    @rival_participant.reload
    assert_equal "unattended", @rival_participant.connection_state
    assert_nil @rival_participant.freeze_deadline_at
    assert_equal 1, @rival_participant.freeze_windows_used

    # After the cooldown one more window exists, then the budget is exhausted.
    connect(token: "tab-c", at: T0 + 71.seconds)
    assert_equal :frozen, disconnect(token: "tab-c", at: T0 + 72.seconds)
    assert_equal 2, @rival_participant.reload.freeze_windows_used

    connect(token: "tab-d", at: T0 + 200.seconds)
    assert_equal :unattended, disconnect(token: "tab-d", at: T0 + 201.seconds)
    @rival_participant.reload
    assert_equal 2, @rival_participant.freeze_windows_used
    assert_equal "unattended", @rival_participant.connection_state
  end

  def test_silent_sockets_are_reaped_and_start_the_grace_window
    connect(token: "ghost-tab")
    stale_time = T0 - Match.presence_stale_seconds - 1
    MatchPresence.where(socket_token: "ghost-tab").update_all(last_seen_at: stale_time)

    @match.reconcile_presence!(now: T0)
    @rival_participant.reload
    assert_equal "disconnected", @rival_participant.connection_state
    assert @rival_participant.freeze_deadline_at.present?
    @match.sync_connection_states!(world, now: T0)
    assert rival_snake.frozen?
  end

  def test_a_fresh_tab_prevents_a_stale_sibling_from_freezing_the_player
    connect(token: "stale-tab")
    connect(token: "live-tab", at: T0 - 1.second)
    MatchPresence.where(socket_token: "stale-tab")
                 .update_all(last_seen_at: T0 - Match.presence_stale_seconds - 5)

    @match.reconcile_presence!(now: T0)
    assert_equal "connected", @rival_participant.reload.connection_state
    @match.sync_connection_states!(world, now: T0)
    refute rival_snake.frozen?
  end

  def test_stale_commands_are_discarded_and_cannot_replay_after_resume
    connect
    input = Simulation::Protocol::Input.new(match_id: @match.id, seq: 5, tick: 0,
                                            direction: Simulation::Direction.parse("up"))
    assert_equal :queued, @match.accept_direction!(membership: @rival_member, input: input, now: T0)
    assert_equal 1, @match.match_inputs.where(match_participant_id: @rival_participant.id).count

    assert_equal :frozen, disconnect
    assert_equal 0, @match.match_inputs.where(match_participant_id: @rival_participant.id).count,
                 "commands queued for the lost connection must be discarded"
    assert_equal :disconnected, @match.accept_direction!(membership: @rival_member, input: input,
                                                         now: T0 + 1.second)

    connect(token: "resumed-tab", at: T0 + 4.seconds)
    replay = Simulation::Protocol::Input.new(match_id: @match.id, seq: 5, tick: 0,
                                            direction: Simulation::Direction.parse("down"))
    assert_equal :stale_sequence, @match.accept_direction!(membership: @rival_member,
                                                           input: replay, now: T0 + 5.seconds)
    fresh = Simulation::Protocol::Input.new(match_id: @match.id, seq: 6, tick: 0,
                                            direction: Simulation::Direction.parse("left"))
    assert_equal :queued, @match.accept_direction!(membership: @rival_member, input: fresh,
                                                   now: T0 + 6.seconds)
  end

  def test_reconnect_after_a_natural_death_restores_an_eliminated_spectator
    connect
    disconnect
    @match.sync_connection_states!(world, now: T0 + 30.seconds)
    rival_snake.eliminate!(at_tick: world.tick, reason: :self_collision)
    @rival_participant.update_columns(status: "eliminated")

    connect(token: "after-death", at: T0 + 60.seconds)
    @match.sync_connection_states!(world, now: T0 + 60.seconds)
    @rival_participant.reload
    assert @rival_participant.spectator?
    assert_equal "connected", @rival_participant.connection_state
    refute rival_snake.alive?
    assert_equal :eliminated, world.resume_player!(@rival_participant.id)
    snapshot = world.snapshot["p"].find { |entry| entry["i"] == @rival_participant.id }
    assert_equal false, snapshot["a"]
    assert_equal false, snapshot["fr"]
  end

  def test_match_runner_freezes_and_releases_using_injected_server_time
    MatchRunner.reset!
    @match.update!(columns: 96, rows: 72)
    MatchRunner.tick_once(monotonic_ms: 0)
    assert_equal [@match.id], MatchRunner.supervisor.match_ids,
                 "only the match under test may be attached"

    # A socket went silent before this pass: the runner's own sweep starts the
    # freeze, with no client involvement.
    connect(token: "runner-tab", at: T0)
    MatchPresence.where(socket_token: "runner-tab")
                 .update_all(last_seen_at: T0 - Match.presence_stale_seconds - 1)
    MatchRunner.tick_once(monotonic_ms: 1_000, now: T0)
    entry = MatchRunner.supervisor.entries.fetch(@match.id)
    assert entry.world.player(@rival_participant.id).frozen?
    assert_equal "disconnected", @rival_participant.reload.connection_state

    # The deadline expires while the runner keeps ticking: the snake resumes
    # and is still alive.
    MatchRunner.tick_once(monotonic_ms: 2_000, now: T0 + 31.seconds)
    refute entry.world.player(@rival_participant.id).frozen?
    assert entry.world.player(@rival_participant.id).alive?
    assert_equal "unattended", @rival_participant.reload.connection_state
  ensure
    MatchRunner.shutdown!
    MatchRunner.reset!
  end

  def test_a_completed_result_is_preserved_across_reconnects_and_restarts
    @match.update!(owner_token: "test-owner", lease_expires_at: T0 + 6.seconds)
    assert @match.complete_from_world!(world, token: "test-owner", now: T0)
    @room.finish_match!
    @match.reload
    winner = @match.winner_membership_id
    standings = @match.standings.map { |p| [p.id, p.placement, p.final_score] }
    assert @match.completed?

    connect(@host_member, token: "host-after-game", at: T0 + 45.seconds)
    connect(token: "rival-after-game", at: T0 + 46.seconds)
    @match.reload
    assert @match.completed?
    assert_equal winner, @match.winner_membership_id
    assert_equal standings, @match.standings.map { |p| [p.id, p.placement, p.final_score] }

    MatchRunner.reset!
    MatchRunner.tick_once(monotonic_ms: 0, now: T0 + 120.seconds)
    assert_equal [], Match.recover_orphans!(now: T0 + 240.seconds)
    assert @match.reload.completed?
    assert_equal winner, @match.winner_membership_id
  ensure
    MatchRunner.shutdown!
    MatchRunner.reset!
  end

  def test_an_unrecoverable_match_is_interrupted_without_inventing_standings
    @match.update_columns(created_at: T0 - 5.minutes, updated_at: T0 - 5.minutes,
                          owner_token: nil, lease_expires_at: nil, checkpoint: {})
    reloaded = @match.reload

    assert_equal [reloaded.id], Match.recover_orphans!(now: T0)
    reloaded.reload
    assert_equal "interrupted", reloaded.status
    assert_nil reloaded.winner_membership_id
    assert_equal [nil, nil], reloaded.standings.map(&:placement)
    assert_equal "finished", @room.reload.state
    assert reloaded.match_presences.count.zero?
  end

  def test_a_match_with_an_authoritative_checkpoint_is_not_interrupted
    @match.update_columns(created_at: T0 - 5.minutes, updated_at: T0 - 5.minutes,
                          owner_token: nil, lease_expires_at: nil,
                          checkpoint: world.to_state, checkpoint_tick: world.tick)

    assert_equal [], Match.recover_orphans!(now: T0)
    assert_equal "pending", @match.reload.status
    assert_equal "in_match", @room.reload.state
  end

  def test_rematch_starts_a_new_game_in_one_action_without_a_refresh
    @match.update!(owner_token: "test-owner", lease_expires_at: T0 + 6.seconds)
    @match.complete_from_world!(world, token: "test-owner", now: T0)
    @room.finish_match!
    first_match_id = @match.id
    assert_equal "completed", @match.reload.status

    error = assert_raises(Room::InvalidTransition) do
      @room.reload.start_match!(actor: @rival_member)
    end
    assert_match(/Only the current host/, error.message)

    @room.reload.start_match!(actor: @host_member)
    @room.reload
    new_match = @room.live_match
    refute_nil new_match
    refute_equal first_match_id, new_match.id
    assert_equal "in_match", @room.state
    assert_equal "completed", @match.reload.status, "the previous result stays intact"
    assert new_match.match_participants.count >= 2

    # A second instantaneous rematch also works: the room is now finished only
    # after a new completion, and start_match! never requires a page reload.
    assert_equal first_match_id, @match.id
  end

  def test_lobby_host_keeps_the_crown_through_a_socket_blip_and_host_grace
    seen = T0
    @host_member.mark_seen!(at: seen)
    @rival_member.mark_seen!(at: seen)
    @room.sweep!(at: seen + 5.seconds)

    assert_equal @host_member.id, @room.reload.host_membership.id
    refute @room.reload.disbanded?
    # Two tabs beating are indistinguishable from one: the seat and crown stay.
    @room.touch_member_presence!(@host_member, at: seen + 10.seconds)
    @room.touch_member_presence!(@host_member, at: seen + 12.seconds)
    assert_equal @host_member.id, @room.reload.host_membership.id

    # Silence past host grace migrates the crown, but NEVER destroys the party.
    @rival_member.mark_seen!(at: seen + Room.config.host_grace + 12.seconds)
    @room.sweep!(at: seen + Room.config.host_grace + 13.seconds)
    assert_equal @rival_member.id, @room.reload.host_membership.id
    @host_member.reload
    assert @host_member.active?, "the host keeps their seat for a later reconnect"
    refute @room.reload.closed?

    @room.touch_member_presence!(@host_member, at: seen + Room.config.host_grace + 20.seconds)
    assert @host_member.reload.active?
    refute @room.reload.closed?
  end
end
