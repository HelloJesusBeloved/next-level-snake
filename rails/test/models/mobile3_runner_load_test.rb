require 'test_helper'

class Mobile3RunnerLoadTest < ActiveSupport::TestCase
  setup do
    MatchRunner.reset!
    Match.live.delete_all
    @room = make_room_with_guest_host
    @member = make_guest_membership(@room, 'Rival')
    @room.start_match!
    @match = @room.live_match
  end
  teardown do
    MatchRunner.shutdown!
    MatchRunner.reset!
  end

  def sql_during
    queries = []
    listener = ActiveSupport::Notifications.subscribe('sql.active_record') do |_name, _start, _finish, _id, data|
      queries << data[:sql] unless data[:name] == 'SCHEMA' || data[:cached]
    end
    yield
    queries
  ensure
    ActiveSupport::Notifications.unsubscribe(listener) if listener
  end

  test 'claimed matches still start on the first server pass' do
    report = MatchRunner.tick_once(monotonic_ms: 0)
    assert_includes report[:claimed], @match.id
    assert MatchRunner.supervisor.attach?(@match.id)
  end

  test 'free-match claim query does not compete with every movement tick' do
    MatchRunner.tick_once(monotonic_ms: 0)
    queries = sql_during do
      10.times { |index| MatchRunner.tick_once(monotonic_ms: 5 + index * 20) }
    end
    claims = queries.grep(/FROM "matches".*lease_expires_at/m)
    assert_empty claims, 'claims are throttled, but movement continues'
    assert_operator MatchRunner.supervisor.entries.fetch(@match.id).world.tick, :>, 0
    MatchRunner.tick_once(monotonic_ms: 300)
    assert MatchRunner.supervisor.attach?(@match.id)
  end

  test 'ordinary presence checks do not query every connected participant' do
    now = Time.current
    MatchRunner.tick_once(monotonic_ms: 0, now: now)
    queries = sql_during do
      MatchRunner.reconcile_connections(monotonic_ms: 600, now: now)
    end
    assert_empty queries.grep(/FROM "match_participants"/m),
                 'no per-room participant scan when no socket is stale'
  end

  test 'a missing socket row is recovered by the bounded full sweep' do
    now = Time.current
    MatchRunner.tick_once(monotonic_ms: 0, now: now)
    @match.register_presence!(membership: @member, socket_token: 'mobile3-lost', now: now)
    @match.match_presences.where(socket_token: 'mobile3-lost').delete_all
    participant = @match.match_participants.find_by!(room_membership_id: @member.id)
    assert_equal 'connected', participant.reload.connection_state

    MatchRunner.reconcile_connections(monotonic_ms: 600, now: now)
    assert_equal 'connected', participant.reload.connection_state,
                 'the cheap pass only considers stale socket rows'
    MatchRunner.reconcile_connections(monotonic_ms: 6_000, now: now + 6.seconds)
    assert_equal 'disconnected', participant.reload.connection_state,
                 'full server-controlled sweep catches a socket row lost with no callback'
    assert participant.freeze_deadline_at.present?
  end
end
