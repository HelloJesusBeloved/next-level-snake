require "test_helper"

# Subscription authorization and channel-action authorization (step 4).
# Parameters are hints; identity comes only from the connection, and the seat
# is re-checked on every single action.
class RoomChannelTest < ActionCable::Channel::TestCase
  tests RoomChannel

  setup do
    @room = Room.create_with_host!(guest_session: GuestSession.issue.first,
                                   display_name: "Host")
    @guest, _raw = GuestSession.issue
    @seat = @room.join!(guest_session: @guest, display_name: "Member")
    @user = User.create!(username: "SocketPlayer", password: "correct horse battery")
  end

  def connect_as_guest(guest = @guest)
    stub_connection(current_user: nil, current_guest_session: guest)
  end

  def connect_as_user(user = @user)
    stub_connection(current_user: user, current_guest_session: nil)
  end

  def connect_anonymous
    stub_connection(current_user: nil, current_guest_session: nil)
  end

  # ---- accepted -------------------------------------------------------------

  test "a seated guest subscribes to the room stream and is marked present" do
    connect_as_guest
    subscribe(code: @room.invitation_code)

    assert subscription.confirmed?
    assert_has_stream(RoomChannel.stream_for(@room))
    assert @seat.reload.last_seen_at >= 1.minute.ago
  end

  test "a seated signed-in player subscribes to the same stream" do
    @room.join!(user: @user, display_name: "SocketPlayer")
    connect_as_user

    subscribe(code: @room.invitation_code)

    assert subscription.confirmed?
    assert_has_stream(RoomChannel.stream_for(@room))
  end

  # ---- rejected -------------------------------------------------------------

  test "rejects a connection with no identity" do
    connect_anonymous

    subscribe(code: @room.invitation_code)

    assert subscription.rejected?
    assert_no_streams
    assert_equal "not_a_member", transmissions.last["error"]
  end

  test "rejects a guest who never sat in this room" do
    stranger, _raw = GuestSession.issue
    connect_as_guest(stranger)

    subscribe(code: @room.invitation_code)

    assert subscription.rejected?
    assert_no_streams
    assert_equal "not_a_member", transmissions.last["error"]
  end

  test "rejects a signed-in player who never sat in this room" do
    connect_as_user # @user is only seated after join, which we skip

    subscribe(code: @room.invitation_code)

    assert subscription.rejected?
    assert_no_streams
  end

  test "rejects a member of a different room subscribing here" do
    elsewhere = Room.create_with_host!(guest_session: GuestSession.issue.first,
                                       display_name: "OtherHost")
    other_guest, _raw = GuestSession.issue
    elsewhere.join!(guest_session: other_guest, display_name: "Elsewhere")
    connect_as_guest(other_guest)

    subscribe(code: @room.invitation_code)

    assert subscription.rejected?
    assert_no_streams
    assert_equal "not_a_member", transmissions.last["error"]
  end

  test "rejects an unknown invitation code with a plain-language reason" do
    connect_as_guest

    subscribe(code: "ZZZZZZZZZZZZ")

    assert subscription.rejected?
    assert_no_streams
    assert_equal "room_not_found", transmissions.last["error"]
  end

  test "rejects a disbanded room and explains why" do
    connect_as_guest
    @room.disband!(reason: "host_disbanded")

    subscribe(code: @room.invitation_code)

    assert subscription.rejected?
    assert_no_streams
    assert_equal "room_closed", transmissions.last["error"]
    assert_match(/disbanded by its host/, transmissions.last["message"])
  end

  test "rejects a subscription after the seat is gone" do
    connect_as_guest
    @seat.leave!

    subscribe(code: @room.invitation_code)

    assert subscription.rejected?
    assert_no_streams
  end

  # ---- channel actions --------------------------------------------------------

  test "heartbeat is answered and keeps presence alive" do
    connect_as_guest
    subscribe(code: @room.invitation_code)
    assert subscription.confirmed?

    @seat.update_columns(last_seen_at: 1.hour.ago)
    perform :heartbeat

    assert_equal "heartbeat", transmissions.last["event"]
    assert @seat.reload.last_seen_at >= 1.minute.ago
    assert_equal @room.reload.version, transmissions.last["v"]
  end

  test "heartbeat is refused once the seat disappears" do
    connect_as_guest
    subscribe(code: @room.invitation_code)
    assert subscription.confirmed?

    @seat.leave!
    perform :heartbeat

    assert_equal "resync", transmissions.last["event"]
    assert_equal "not_a_member", transmissions.last["error"]
  end
end
