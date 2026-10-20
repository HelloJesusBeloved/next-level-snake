require "test_helper"

class RoomTest < ActiveSupport::TestCase
  test "rooms start as brawl lobbies with sanitised defaults" do
    room = make_room_with_user_host

    assert_equal "lobby", room.state
    assert_equal "brawl", room.mode
    assert_equal Room::DEFAULT_MAX_MEMBERS, room.max_members
    assert_equal({}, room.settings)
    assert room.joinable?
    assert_not room.closed?
    assert_equal room.host_membership.user, room.room_memberships.first.user
  end

  test "invitation codes are long, unambiguous, unique and unpredictable in shape" do
    rooms = Array.new(10) { make_room_with_guest_host }
    codes = rooms.map(&:invitation_code)

    assert_equal codes.uniq, codes
    codes.each do |code|
      assert_match(/\A[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{12}\z/, code)
    end
    # Not derived from ids or sequence: consecutive rooms, unrelated codes.
    assert_not_equal codes.first, codes.second
  end

  test "a duplicate invitation code is rejected" do
    room = make_room_with_user_host
    dupe = Room.new(invitation_code: room.invitation_code.downcase)

    assert_not dupe.valid?
    assert dupe.errors[:invitation_code].present?
  end

  test "code lookup tolerates case, spaces and hyphens" do
    room = make_room_with_user_host
    typed = room.invitation_code.downcase.chars.each_slice(4).map(&:join).join("-")

    assert_equal room, Room.find_by_invitation_code(typed)
    assert_equal room, Room.find_by_invitation_code(" #{room.invitation_code} ")
    assert_nil Room.find_by_invitation_code("")
    assert_nil Room.find_by_invitation_code("ZZZZZZZZZZZZ")
  end

  test "rotating the invitation code keeps seated members seated" do
    room = make_room_with_user_host
    guest, _raw = make_guest
    seat = room.join!(guest_session: guest, display_name: "Visitor")
    old_code = room.invitation_code

    room.regenerate_invitation_code!

    assert_not_equal old_code, room.invitation_code
    assert_nil Room.find_by_invitation_code(old_code)
    assert seat.reload.active?
    assert_equal 2, room.active_memberships.count
  end

  test "mode and state are validated, and the database enforces them too" do
    room = make_room_with_user_host
    room.mode = "deathmatch"
    assert_not room.valid?

    room = make_room_with_guest_host
    assert_raises(ActiveRecord::StatementInvalid) do
      room.update_columns(state: "exploded") # skip validations, hit the CHECK
    end
  end

  test "duels seat exactly two" do
    room = make_room_with_user_host(mode: "duel", max_members: 2)
    guest, _raw = make_guest
    room.join!(guest_session: guest, display_name: "Challenger")

    third, _raw3 = make_guest
    assert_raises(Room::NotJoinable) do
      room.join!(guest_session: third, display_name: "ThirdWheel")
    end
  end

  test "a duel with the wrong capacity is invalid" do
    assert_raises(ActiveRecord::RecordInvalid) do
      make_room_with_user_host(mode: "duel") # default capacity 8
    end
  end

  test "capacity is respected for brawls" do
    room = make_room_with_user_host(max_members: 2)
    room.join!(guest_session: make_guest.first, display_name: "Second")

    assert room.full?
    assert_raises(Room::NotJoinable) do
      room.join!(guest_session: make_guest.first, display_name: "Overflow")
    end
  end

  test "settings are rebuilt from an allow-list, junk is dropped" do
    room = make_room_with_user_host(settings: {
                                      "speed_level" => 4, "growth" => 99,
                                      "speed" => "fast", "admin" => true
                                    })

    assert_equal({ "speed_level" => 4 }, room.settings)
    assert_equal({}, Room.sanitize_settings("nonsense"))
    assert_equal({ "growth" => 2 }, Room.sanitize_settings({ growth: 2 }))
  end

  test "full lifecycle: lobby, match, results, rematch, archive" do
    host = make_user
    room = make_room_with_user_host(host)
    guest_seat = room.join!(guest_session: make_guest.first, display_name: "Rival")

    room.start_match!
    assert room.in_match?
    assert room.started_at.present?
    assert_equal "playing", guest_seat.reload.state
    assert_equal "playing", room.host_membership.reload.state

    # Nobody new sits down mid-match.
    assert_raises(Room::NotJoinable) do
      room.join!(guest_session: make_guest.first, display_name: "Latecomer")
    end

    room.finish_match!
    assert room.finished?
    assert room.finished_at.present?
    assert_equal "joined", guest_seat.reload.state

    room.return_to_lobby!
    assert room.lobby?
    room.start_match! # rematch with the same seats
    room.finish_match!

    room.archive!
    assert room.archived?
    assert room.archived_at.present?
    assert_equal "left", guest_seat.reload.state

    # Archiving freed the host to sit in a brand-new room.
    assert make_room_with_user_host(host).persisted?
  end

  test "illegal lifecycle jumps raise and change nothing" do
    room = make_room_with_user_host

    assert_raises(Room::InvalidTransition) { room.finish_match! }
    assert_raises(Room::InvalidTransition) { room.archive! }
    assert_raises(Room::InvalidTransition) { room.start_match! } # only one player
    assert room.reload.lobby?
  end

  test "disband releases everyone, is idempotent, and can then be archived" do
    host = make_user
    room = make_room_with_user_host(host)
    seat = room.join!(guest_session: make_guest.first, display_name: "Pal")

    room.disband!
    assert room.disbanded?
    assert room.disbanded_at.present?
    assert_equal "left", seat.reload.state
    assert_nil host.reload.active_room_membership

    room.disband! # no error, no second timestamp churn
    assert_raises(Room::NotJoinable) do
      room.join!(guest_session: make_guest.first, display_name: "TooLate")
    end

    room.archive!
    assert room.archived?
    assert_raises(Room::InvalidTransition) { room.disband! }
  end

  test "hosting can be transferred to another seated member" do
    room = make_room_with_user_host
    guest, _raw = make_guest
    seat = room.join!(guest_session: guest, display_name: "Successor")
    old_host = room.host_membership

    room.transfer_host_to!(seat)

    assert_equal "player", old_host.reload.role
    assert seat.reload.host?
    assert room.host?(seat)
  end

  test "the database refuses two active hosts in one room" do
    room = make_room_with_user_host
    seat = room.join!(guest_session: make_guest.first, display_name: "Usurper")

    assert_raises(ActiveRecord::RecordNotUnique) do
      seat.update_columns(role: "host")
    end
  end

  test "room creation does not disturb existing accounts or scores" do
    veteran = make_user(username: "Veteran")
    score = Score.create!(user: veteran, score: 120, speed_level: 3, growth: 1)

    make_room_with_guest_host
    make_room_with_user_host(make_user)

    assert_equal score, Score.find(score.id)
    assert_equal 120, veteran.scores.first.score
    assert_equal "Veteran", veteran.reload.username
  end
end
