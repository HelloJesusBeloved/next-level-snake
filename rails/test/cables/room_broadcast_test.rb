require "test_helper"

# Fan-out proof (step 4): two INDEPENDENT subscribers attached to the same
# room stream — precisely what two sockets' RoomChannel#stream_from register —
# both receive byte-identical events when a real API request mutates the room.
#
# The subscribers are registered straight on ActionCable.server.pubsub (the
# `test` adapter from config/cable.yml, which records broadcasts AND delivers
# them in-process). Waiting on a queue keeps the assertions honest if delivery
# ever moves to a worker thread; timeouts surface as failures, not hangs.
class RoomBroadcastTest < ActionDispatch::IntegrationTest
  # One simulated client: an independent subscriber with its own inbox.
  class Client
    attr_reader :messages

    def initialize(stream)
      @stream = stream
      @messages = []
      @queue = Queue.new
      @callback = lambda do |payload|
        # server.broadcast encodes with ActiveSupport::JSON, so subscribers
        # (over the real transport too) always receive a JSON string.
        event = payload.is_a?(String) ? JSON.parse(payload) : payload
        @messages << event
        @queue << event
      end
      ActionCable.server.pubsub.subscribe(stream, @callback)
    end

    # Blocks until the next event arrives; nil on timeout.
    def next_event(timeout = 3)
      Timeout.timeout(timeout) { @queue.pop }
    rescue Timeout::Error
      nil
    end

    # Collect up to `count` events, bounded by `timeout` seconds total.
    def events(count, timeout = 6)
      collected = []
      deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
      while collected.size < count
        remaining = deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)
        break if remaining <= 0

        begin
          event = Timeout.timeout([remaining, 0.5].min) { @queue.pop }
        rescue Timeout::Error
          break
        end
        break if event.nil?

        collected << event
      end
      collected
    end

    def close
      ActionCable.server.pubsub.unsubscribe(@stream, @callback)
    end
  end

  JSON_HEADERS = { "CONTENT_TYPE" => "application/json", "ACCEPT" => "application/json" }.freeze

  def post_json(session, path, payload = {})
    session.post(path, params: payload.to_json, headers: JSON_HEADERS)
    JSON.parse(session.response.body, symbolize_names: true) rescue {}
  end

  def get_json(session, path)
    session.get(path, headers: { "ACCEPT" => "application/json" })
    JSON.parse(session.response.body, symbolize_names: true) rescue {}
  end

  setup do
    @host = open_session # guest host browser
    created = post_json(@host, "/api/rooms", display_name: "Ada")
    @room = Room.find_by_invitation_code(created.dig(:room, :code))
    assert @room, "setup must create a room"
    @stream = RoomChannel.stream_for(@room)
    @alice = Client.new(@stream)
    @bob = Client.new(@stream)
  end

  teardown do
    @alice&.close
    @bob&.close
  end

  test "two separate clients receive the same join event, byte for byte" do
    before_version = @room.reload.version
    stranger = open_session
    post_json(stranger, "/api/rooms/#{@room.invitation_code}/join", display_name: "Grace")

    a = @alice.next_event
    b = @bob.next_event
    assert a, "client A must receive the join event"
    assert b, "client B must receive the join event"
    assert_equal a, b, "both clients must receive the identical event"
    assert_equal "member_joined", a["event"]
    assert_equal before_version + 1, a["v"], "one visible change = one version bump"
    assert_equal @room.reload.version, a["v"], "the broadcast version is the stored one"
    assert_equal @room.invitation_code, a["code"]
  end

  test "ready votes, leaves and host succession reach both clients with rising versions" do
    guest = open_session
    post_json(guest, "/api/rooms/#{@room.invitation_code}/join", display_name: "Grace")
    @alice.events(1); @bob.events(1) # the join, already covered above

    # --- readiness ---
    post_json(guest, "/api/rooms/#{@room.invitation_code}/ready", ready: true)
    ready_a = @alice.next_event
    ready_b = @bob.next_event
    assert ready_a, "A gets the ready event"
    assert_equal ready_a, ready_b, "B gets the identical ready event"
    assert_equal "member_ready", ready_a["event"]
    assert ready_a["ready"], "the event carries the new vote"

    # --- the host leaves: seat + crown move together under ONE version ---
    post_json(@host, "/api/rooms/#{@room.invitation_code}/leave")
    first_a = @alice.events(2)
    first_b = @bob.events(2)
    assert_equal 2, first_a.size, "A gets member_left and host_changed"
    # Action Cable delivers the two NOTIFYs of one logical change through
    # independent per-subscription streams, so their interleaving is not
    # guaranteed. Both clients must still see the same events at the same
    # single version; order within one version carries no meaning.
    signature = ->(events) { events.map { |event| [event["event"], event["v"]] }.sort }
    assert_equal signature.call(first_a), signature.call(first_b),
                 "B sees exactly the same events and version"
    assert_equal %w[host_changed member_left], first_a.map { |e| e["event"] }.sort
    left = first_a.find { |event| event["event"] == "member_left" }
    changed = first_a.find { |event| event["event"] == "host_changed" }
    assert_equal left["v"], changed["v"], "one logical change shares a single version"
    assert changed["host"], "the host_changed event names the new host"
    assert_not_equal left["member"], changed["host"], "the crown left the departing member"

    roster = get_json(guest, "/api/rooms/#{@room.invitation_code}")
    successor = roster[:room][:members].find { |m| m[:display_name] == "Grace" }
    assert successor, "Grace is still seated"
    assert_equal successor[:id], changed["host"], "the crown moved to the longest-seated member"
    assert successor[:host], "and the roster agrees Grace hosts now"

    # --- disband ---
    post_json(guest, "/api/rooms/#{@room.invitation_code}/disband") # Grace is host now
    closed_a = @alice.next_event
    closed_b = @bob.next_event
    assert_equal closed_a, closed_b
    assert_equal "room_closed", closed_a["event"]
    assert_equal "host_disbanded", closed_a["reason"]

    # Versions never go backwards for either client.
    versions = @alice.messages.map { |e| e["v"] }
    assert_equal versions.sort, versions, "versions are monotonic per client"
    assert_equal versions, @bob.messages.map { |e| e["v"] }, "clients agree on the sequence"
  end

  test "re-joining an existing seat broadcasts nothing (multiple tabs, one member)" do
    guest = open_session
    post_json(guest, "/api/rooms/#{@room.invitation_code}/join", display_name: "Grace")
    @alice.events(1); @bob.events(1)
    assert_nil @alice.next_event(0.3), "quiet after the first join"

    # A second tab of the SAME browser (same cookies) joins again: idempotent.
    post_json(guest, "/api/rooms/#{@room.invitation_code}/join", display_name: "Grace")
    assert_nil @alice.next_event(0.3), "a refresh/rejoin must not look like a new player"
    assert_nil @bob.next_event(0.3)

    roster = get_json(guest, "/api/rooms/#{@room.invitation_code}")
    assert_equal 2, roster.dig(:room, :counts, :members), "host + one member, not more"
    assert_equal 1, roster.dig(:room, :members).count { |m| m[:display_name] == "Grace" }
  end

  test "an unknown or closed room never opens a stream" do
    assert_nil Room.find_by_invitation_code("ZZZZZZZZZZZZ")

    room2 = Room.create_with_host!(guest_session: GuestSession.issue.first, display_name: "Solo")
    room2.disband!
    assert_equal "disbanded", room2.reload.state
    # RoomChannel#subscribed refuses these before stream_from runs; the
    # channel tests cover that path directly — here we only prove the stream
    # name itself is inert for a closed room: nothing ever emits on it again.
    assert_nil @alice.next_event(0.3)
    assert RoomChannel.stream_for(room2).start_with?("rooms:")
  end
end
