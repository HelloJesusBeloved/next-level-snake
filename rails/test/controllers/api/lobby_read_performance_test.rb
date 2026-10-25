require "test_helper"

# Step 10 performance: reading the lobby must never take the room row lock.
# Previously every 5 s poll from every player serialized on `rooms` FOR UPDATE,
# which is what made lobby -> match transitions and even the connection chip
# feel sluggish under load.
class LobbyReadPerformanceTest < ActionDispatch::IntegrationTest
  setup do
    @room = make_room_with_guest_host
    @guest = open_session
    post_json(@guest, "/api/rooms/#{@room.invitation_code}/join", display_name: "Rival")
  end

  def capture_sql
    statements = []
    callback = lambda do |_name, _start, _finish, _id, payload|
      statements << payload[:sql].squish unless payload[:cached] || payload[:sql].blank?
    end
    ActiveSupport::Notifications.subscribed(callback, "sql.active_record") { yield }
    statements
  end

  test "polling the lobby takes no row locks and a bounded number of reads" do
    statements = capture_sql { get_json(@guest, "/api/rooms/current") }

    assert_equal 200, status(@guest)
    refute statements.any? { |sql| sql.match?(/FOR UPDATE/i) },
           "the read path must not lock the room: #{statements.grep(/FOR UPDATE/).first}"
    assert_operator statements.size, :<=, 25,
                    "a lobby snapshot should be a bounded set of reads, was #{statements.size}"
  end

  test "state transitions still work right after a read without a reload" do
    get_json(@guest, "/api/rooms/current")
    post_json(@guest, "/api/rooms/#{@room.invitation_code}/ready", ready: true)
    assert_equal 200, status(@guest)
    assert_equal true, member_named(body(@guest), "Rival")[:ready]
  end
end
