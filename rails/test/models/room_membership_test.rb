require "test_helper"

class RoomMembershipTest < ActiveSupport::TestCase
  test "a seat belongs to exactly one of a user or a guest session" do
    room = make_room_with_user_host
    both = RoomMembership.new(room: room, user: make_user,
                              guest_session: make_guest.first, display_name: "Both",
                              joined_at: Time.current)
    neither = RoomMembership.new(room: room, display_name: "Neither")

    assert_not both.valid?
    assert_not neither.valid?
    assert_raises(ActiveRecord::StatementInvalid) { both.save(validate: false) }
  end

  test "signed-in players default to their username but can rename per room" do
    user = make_user(username: "PermanentName")
    room = make_room_with_guest_host

    defaulted = room.join!(user: user)
    assert_equal "PermanentName", defaulted.display_name

    defaulted.update!(display_name: "LobbyAlias")
    assert_equal "LobbyAlias", defaulted.reload.display_name
    assert_equal "PermanentName", user.reload.username, "account name must never follow the room name"
  end

  test "an explicit room display name wins over the account username" do
    user = make_user(username: "AccountName")
    room = make_room_with_guest_host

    seat = room.join!(user: user, display_name: "RoomName")
    assert_equal "RoomName", seat.display_name
  end

  test "guests must type a display name, and it is not an identity" do
    room = make_room_with_user_host

    assert_raises(ActiveRecord::RecordInvalid) do
      room.join!(guest_session: make_guest.first, display_name: "  ")
    end

    # Two different guests may use the same name in *different* rooms:
    # they are still different people, told apart by their sessions.
    other_room = make_room_with_user_host
    a = room.join!(guest_session: make_guest.first, display_name: "Twin")
    b = other_room.join!(guest_session: make_guest.first, display_name: "Twin")
    assert_not_equal a.guest_session_id, b.guest_session_id
  end

  test "seated display names are unique per room, case-insensitively, until freed" do
    room = make_room_with_user_host
    first = room.join!(guest_session: make_guest.first, display_name: "Speedy")

    assert_raises(ActiveRecord::RecordInvalid) do
      room.join!(guest_session: make_guest.first, display_name: "speedy")
    end

    first.leave!
    reused = room.join!(guest_session: make_guest.first, display_name: "SPEEDY")
    assert reused.active?
  end

  test "one active seat per account across all rooms" do
    user = make_user
    home = make_room_with_guest_host
    away = make_room_with_guest_host

    home.join!(user: user)
    assert_raises(ActiveRecord::RecordInvalid) { away.join!(user: user) }

    user.active_room_membership.leave!
    assert away.join!(user: user).active?, "leaving frees the account to sit elsewhere"
  end

  test "one active seat per guest session across all rooms, enforced by the DB" do
    guest, _raw = make_guest
    home = make_room_with_user_host
    home.join!(guest_session: guest, display_name: "Wanderer")

    away = make_room_with_user_host
    sneak = RoomMembership.new(room: away, guest_session: guest, display_name: "Wanderer",
                               joined_at: Time.current)
    assert_raises(ActiveRecord::RecordNotUnique) { sneak.save(validate: false) }
  end

  test "an identity can never be playing in two rooms at once" do
    guest, _raw = make_guest
    room = make_room_with_user_host
    room.join!(guest_session: make_guest.first, display_name: "Filler")
    seat = room.join!(guest_session: guest, display_name: "Contender")
    room.start_match!
    assert_equal "playing", seat.reload.state

    other = make_room_with_user_host
    assert_raises(ActiveRecord::RecordInvalid) do
      other.join!(guest_session: guest, display_name: "Contender")
    end
  end

  test "rejoining after leaving reactivates the same membership row" do
    user = make_user
    room = make_room_with_guest_host
    original = room.join!(user: user, display_name: "Boomerang")
    original.leave!

    assert_no_difference "RoomMembership.count" do
      rejoined = room.join!(user: user)
      assert_equal original.id, rejoined.id
    end
    assert original.reload.active?
    assert_nil original.left_at
  end

  test "joining while already seated is a refresh-safe no-op" do
    user = make_user
    room = make_room_with_guest_host
    seat = room.join!(user: user)

    assert_no_difference "RoomMembership.count" do
      assert_equal seat, room.join!(user: user)
    end
  end

  test "removed members cannot come back; left members can" do
    room = make_room_with_user_host
    kicked = room.join!(guest_session: make_guest.first, display_name: "Trouble")
    kicked.remove!
    assert_equal "removed", kicked.reload.state
    assert kicked.left_at.present?

    assert_raises(Room::NotJoinable) do
      room.join!(guest_session: kicked.guest_session, display_name: "Trouble")
    end
    assert_raises(RoomMembership::InvalidTransition) { kicked.rejoin! }
  end

  test "when the host leaves, the longest-seated member inherits" do
    room = make_room_with_user_host
    elder = room.join!(guest_session: make_guest.first, display_name: "Elder")
    room.join!(guest_session: make_guest.first, display_name: "Younger")

    room.host_membership.leave!

    assert elder.reload.host?
    assert_equal elder, room.reload.host_membership
  end

  # Step 3: an emptied room stays open (its invitation link must survive a
  # lobby-wide reload) until somebody rejoins or the inactivity sweeper
  # expires it — see Room#sweep! and the rooms API tests.
  test "the last member leaving empties the room without closing it" do
    room = make_room_with_user_host
    room.host_membership.leave!

    room.reload
    assert room.lobby?
    assert_not room.closed?
    assert_equal 0, room.active_memberships.count
    assert_nil room.host_membership
  end

  test "rejoining an emptied room makes the returning player its host" do
    room = make_room_with_user_host
    room.host_membership.leave!

    guest, _raw = make_guest
    seat = room.join!(guest_session: guest, display_name: "Newcomer")

    assert seat.host?, "an empty room hands the crown to whoever shows up"
    assert_equal seat, room.reload.host_membership
  end

  test "ready toggles only from joined" do
    room = make_room_with_user_host
    seat = room.join!(guest_session: make_guest.first, display_name: "Eager")

    seat.mark_ready!
    assert_equal "ready", seat.state
    assert_raises(RoomMembership::InvalidTransition) { seat.mark_ready! }
    seat.mark_not_ready!
    assert_equal "joined", seat.state
  end

  test "a dead guest session cannot take a seat" do
    guest, _raw = make_guest
    guest.revoke!
    room = make_room_with_user_host

    assert_raises(Room::NotJoinable) do
      room.join!(guest_session: guest, display_name: "Ghost")
    end
  end

  test "deleting an account removes its seats but not the room" do
    room = make_room_with_guest_host
    user = make_user
    seat = room.join!(user: user)

    user.destroy!
    assert_nil RoomMembership.find_by(id: seat.id)
    assert Room.exists?(room.id)
  end

  # --- Claiming a guest seat after signing in -----------------------------

  test "claim moves the live seat to the account, keeping name and role" do
    guest, raw_token = make_guest
    room = make_room_with_guest_host(guest) # guest is the host
    seat = room.host_membership
    user = make_user(username: "NewAccount")

    verified = GuestSession.authenticate(raw_token) # what the endpoint will do
    verified.claim_by!(user)

    seat.reload
    assert_equal user, seat.user
    assert_nil seat.guest_session_id
    assert_equal "GuestHost", seat.display_name
    assert seat.host?, "claiming must not cost the guest their host role"
    assert_equal seat, user.active_room_membership

    guest.reload
    assert guest.claimed?
    assert_equal user, guest.claimed_by_user
    assert_nil GuestSession.authenticate(raw_token), "the guest cookie dies at claim time"
  end

  test "a seat cannot be claimed twice or by a second account" do
    guest, raw_token = make_guest
    make_room_with_guest_host(guest)
    guest.claim_by!(make_user)

    # The token is dead, so no second claimant can even present the seat.
    assert_nil GuestSession.authenticate(raw_token)
    seat = RoomMembership.find_by(user: guest.claimed_by_user)
    assert_raises(RoomMembership::ClaimError) { seat.claim_by!(make_user) }
  end

  test "claiming with someone else's token moves only the token owner's seat" do
    victim_guest, _victim_raw = make_guest
    room = make_room_with_user_host
    victim_seat = room.join!(guest_session: victim_guest, display_name: "Victim")

    attacker_guest, attacker_raw = make_guest
    other_room = make_room_with_guest_host(attacker_guest)
    attacker_seat = other_room.host_membership

    GuestSession.authenticate(attacker_raw).claim_by!(make_user)

    assert attacker_seat.reload.registered?
    assert victim_seat.reload.guest?, "the victim's seat is untouched"
    assert_equal victim_guest.id, victim_seat.guest_session_id
  end

  test "claim refuses to merge two live seats" do
    user = make_user
    account_room = make_room_with_guest_host
    account_room.join!(user: user) # account is seated here...

    guest, _raw = make_guest
    make_room_with_guest_host(guest) # ...and as a guest over there

    assert_raises(RoomMembership::ClaimError) { guest.claim_by!(user) }
    assert guest.reload.usable?, "a refused claim must not burn the guest session"
    assert guest.active_membership.guest?
  end

  test "only a current seat can be claimed, not yesterday's history" do
    guest, _raw = make_guest
    room = make_room_with_guest_host(guest)
    room.join!(guest_session: make_guest.first, display_name: "Witness")
    guest.active_membership.leave!

    assert_raises(RoomMembership::ClaimError) { guest.claim_by!(make_user) }
  end

  test "an expired guest session cannot be claimed" do
    guest, _raw = make_guest
    make_room_with_guest_host(guest)
    guest.update_columns(expires_at: 1.minute.ago)

    assert_raises(RoomMembership::ClaimError) { guest.claim_by!(make_user) }
  end

  test "claim still works when the account had an old, left seat in the same room" do
    user = make_user
    room = make_room_with_guest_host
    room.join!(user: user, display_name: "Earlier").leave!

    guest, _raw = make_guest
    guest_seat = room.join!(guest_session: guest, display_name: "AnonymousMe")
    guest_seat.claim_by!(user)

    assert_equal 1, RoomMembership.where(room: room, user: user).count
    assert_equal guest_seat.id, user.active_room_membership.id
    assert_equal "AnonymousMe", user.active_room_membership.display_name
  end
end
