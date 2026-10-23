require "test_helper"

# MatchChannel (step 8): subscription and input actions are authorized against
# the authenticated connection and the frozen match participant rows. The wire
# payload never chooses a player, position, score or winner.
class MatchChannelTest < ActionCable::Channel::TestCase
  setup do
    @room = Room.create_with_host!(guest_session: GuestSession.issue.first, display_name: "Host")
    @guest, _raw = GuestSession.issue
    @seat = @room.join!(guest_session: @guest, display_name: "Rival")
    @room.start_match!(actor: @room.host_membership)
    @match = @room.live_match
    @participant = @match.match_participants.find_by(room_membership_id: @seat.id)
    @host_participant = @match.match_participants.find_by(room_membership_id: @room.host_membership.id)
  end

  def connect_as_guest
    stub_connection(current_user: nil, current_guest_session: @guest)
  end

  def connect_as_host
    stub_connection(current_user: nil, current_guest_session: @room.host_membership.guest_session)
  end

  def connect_as_stranger
    stranger, _raw = GuestSession.issue
    stub_connection(current_user: nil, current_guest_session: stranger)
  end

  test "a frozen participant subscribes and receives the latest snapshot or waiting" do
    connect_as_guest
    subscribe(match: @match.id)

    assert subscription.confirmed?
    assert_has_stream(MatchChannel.stream_for(@match.id))
    message = transmissions.last
    assert_includes %w[waiting snapshot], message["type"]
  end

  test "a room member who did not enter the Brawl is rejected" do
    late, _raw = GuestSession.issue
    @room.join!(guest_session: late, display_name: "Late")
    stub_connection(current_user: nil, current_guest_session: late)

    subscribe(match: @match.id)

    assert subscription.rejected?
    assert_equal "not_a_participant", transmissions.last["error"]
  end

  test "a stranger is rejected" do
    connect_as_stranger
    subscribe(match: @match.id)

    assert subscription.rejected?
    assert_equal "not_a_member", transmissions.last["error"]
  end

  test "an unknown match is rejected" do
    connect_as_guest
    subscribe(match: 999_999)

    assert subscription.rejected?
    assert_equal "match_not_found", transmissions.last["error"]
  end

  test "a participant can queue a direction and gets an ack with its participant id" do
    connect_as_guest
    subscribe(match: @match.id)

    perform :input, "v" => 1, "type" => "input", "match" => @match.id,
                    "tick" => 0, "seq" => 1, "dir" => "up"

    ack = transmissions.last
    assert_equal "input_ack", ack["type"]
    assert_equal true, ack["accepted"]
    assert_equal @participant.id, ack["participant"]
    assert_equal 1, @participant.reload.last_input_seq
  end

  test "replayed sequences and invalid directions are refused" do
    connect_as_guest
    subscribe(match: @match.id)

    perform :input, "v" => 1, "type" => "input", "match" => @match.id,
                    "tick" => 0, "seq" => 7, "dir" => "left"
    perform :input, "v" => 1, "type" => "input", "match" => @match.id,
                    "tick" => 0, "seq" => 7, "dir" => "right"

    assert_equal "stale_sequence", transmissions.last["reason"]
    assert_equal false, transmissions.last["accepted"]

    perform :input, "v" => 1, "type" => "input", "match" => @match.id,
                    "tick" => 0, "seq" => 8, "dir" => "diagonal"
    assert_equal false, transmissions.last["accepted"]
    assert_equal "invalid_direction", transmissions.last["reason"]
  end

  test "authority fields in an input payload are rejected outright" do
    connect_as_guest
    subscribe(match: @match.id)

    perform :input, "v" => 1, "type" => "input", "match" => @match.id,
                    "tick" => 0, "seq" => 9, "dir" => "up",
                    "score" => 999, "position" => [1, 1], "winner" => @host_participant.id

    ack = transmissions.last
    assert_equal false, ack["accepted"]
    assert_equal "forbidden_field", ack["reason"]
    assert_equal 0, @participant.reload.last_input_seq
  end

  test "an input for a different match is refused" do
    connect_as_guest
    subscribe(match: @match.id)

    perform :input, "v" => 1, "type" => "input", "match" => @match.id + 1,
                    "tick" => 0, "seq" => 3, "dir" => "up"

    assert_equal false, transmissions.last["accepted"]
    assert_equal "wrong_match", transmissions.last["reason"]
  end
end
