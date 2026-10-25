require "test_helper"

# Step 9: a completed Brawl persists per-player final score, survival time,
# longest snake and placement, and the final snapshot stays available.
class FinalResultsTest < ActiveSupport::TestCase
  def completed_match
    room = make_room_with_guest_host
    rival = room.join!(guest_session: make_guest.first, display_name: "Rival")
    desktop = { width: 1440, height: 900, screen_width: 1920, screen_height: 1080,
                coarse: false, fine: true, hover: true, touch_points: 0 }
    room.report_capabilities!(room.host_membership, client_id: "a" * 16, capabilities: desktop)
    room.report_capabilities!(rival, client_id: "b" * 16, capabilities: desktop)
    room.start_match!
    match = room.live_match
    world = match.build_world
    world.start!
    eliminated, survivor = world.snakes
    eliminated.score = 9
    eliminated.eliminate!(at_tick: 3, reason: :self_collision)
    eliminated.survived_ticks = 3
    survivor.score = 4
    survivor.survived_ticks = 90
    survivor.longest_length = 11
    world.finish!(reason: :tick_limit)
    [match, world, eliminated, survivor]
  end

  test "completion persists score survival longest placement and winner" do
    match, world, eliminated, survivor = completed_match
    entries = world.standings
    MatchRunner.reset!
    match.claim_lease!(token: "f" * 32, ttl_seconds: 30)
    assert match.complete_from_world!(world, token: "f" * 32)

    winner = match.match_participants.find(eliminated.id)
    runner_up = match.match_participants.find(survivor.id)
    assert_equal 1, winner.placement
    assert_equal 9, winner.final_score
    assert_equal 3, winner.survived_ticks
    assert_equal 2, runner_up.placement
    assert_equal 90, runner_up.survived_ticks
    assert_equal 11, runner_up.longest_length
    assert_equal winner.room_membership_id, match.winner_membership_id

    final = match.live_snapshot
    assert_equal "completed", final["s"]
    assert_equal 2, final["q"].size
    first = final["q"].first
    assert_equal eliminated.id, first["i"]
    assert_equal 1, first["p"]
    assert_equal 9, first["sc"]
  ensure
    MatchRunner.reset!
  end

  test "a subscriber can still read the final snapshot after completion" do
    match, world, = completed_match
    MatchRunner.reset!
    match.claim_lease!(token: "f" * 32, ttl_seconds: 30)
    match.complete_from_world!(world, token: "f" * 32)
    match.reload

    assert match.completed?
    assert match.live_snapshot.present?
    assert_equal "completed", match.live_snapshot["s"]
    assert_equal 2, match.live_snapshot["q"].size
  ensure
    MatchRunner.reset!
  end
end
