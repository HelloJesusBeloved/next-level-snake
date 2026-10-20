require "test_helper"

# End-to-end request tests for the multiplayer room API. Each `browser` is an
# independent cookie jar, so guests, accounts and strangers are genuinely
# different callers — nothing is stubbed.
class Api::RoomsControllerTest < ActionDispatch::IntegrationTest
  # ---- creating and inviting ------------------------------------------------

  test "a guest creates a room, becomes host, and gets a code and invite URL" do
    host = browser
    payload = post_json(host, "/api/rooms", display_name: "Ada")

    assert_equal 201, status(host)
    assert_match(/\A[A-Z0-9]{12}\z/, payload.dig(:room, :code))
    assert_equal payload.dig(:room, :code), payload.dig(:room, :invite_url).split("/multiplayer/").last
    assert_equal "lobby", payload.dig(:room, :state)
    assert_equal "brawl", payload.dig(:room, :mode)
    assert_equal "Ada", host_name(payload), "the creator wears the crown"
    assert payload.dig(:member, :host)
    assert payload.dig(:member, :you)
    assert payload.dig(:viewer, :guest)
    assert_not payload.dig(:viewer, :signed_in)
  end

  test "a guest needs a display name but never an account" do
    guest = browser
    assert_no_difference "User.count" do
      post_json(guest, "/api/rooms", display_name: "  ")
      assert_equal 422, status(guest)
      assert_equal "display_name_required", body(guest)[:code]

      post_json(guest, "/api/rooms", display_name: "Nameless")
      assert_equal 201, status(guest)
    end
  end

  test "a signed-in player hosts under their username and may override it per room" do
    user = make_user(username: "Permanent")
    session = browser
    sign_in(session, user)

    payload = post_json(session, "/api/rooms")
    assert_equal "Permanent", payload.dig(:member, :display_name)
    assert payload.dig(:viewer, :signed_in)

    post_json(session, "/api/rooms/#{payload.dig(:room, :code)}/leave")
    renamed = post_json(session, "/api/rooms", display_name: "TableFlipper")
    assert_equal "TableFlipper", renamed.dig(:member, :display_name)
    assert_equal "Permanent", user.reload.username
  end

  test "joining by code works for guests and is case/hyphen tolerant" do
    host = browser
    code = post_json(host, "/api/rooms", display_name: "Ada").dig(:room, :code)
    typed = code.downcase.chars.each_slice(4).map(&:join).join("-")

    guest = browser
    payload = post_json(guest, "/api/rooms/#{typed}/join", display_name: "Grace")

    assert_equal 200, status(guest)
    assert_equal 2, payload.dig(:room, :counts, :members)
    assert_equal "Ada", host_name(payload)
    assert_not payload.dig(:member, :host)
    assert_equal "Grace", payload.dig(:member, :display_name)
  end

  test "the invitation URL path renders the lobby page for the code" do
    code = post_json(browser, "/api/rooms", display_name: "Ada").dig(:room, :code)

    get "/multiplayer/#{code}"
    assert_response :success
    assert_includes response.body, "multiplayer-root"
    assert_includes response.body, code
  end

  test "previewing a code before joining shows the room without joining it" do
    host = browser
    code = post_json(host, "/api/rooms", display_name: "Ada").dig(:room, :code)

    onlooker = browser
    preview = get_json(onlooker, "/api/rooms/#{code}")

    assert_equal 200, status(onlooker)
    assert_equal "Ada", preview.dig(:room, :host_name)
    assert preview.dig(:room, :joinable)
    assert_nil preview[:member]
    assert_equal 1, Room.find_by_invitation_code(code).active_memberships.count
  end

  # ---- refresh, roster and readiness ----------------------------------------

  test "a plain refresh restores the current room state" do
    guest = browser
    created = post_json(guest, "/api/rooms", display_name: "Ada")

    refreshed = get_json(guest, "/api/rooms/current")
    assert_equal created.dig(:room, :code), refreshed.dig(:room, :code)
    assert_equal created.dig(:member, :id), refreshed.dig(:member, :id)
    assert refreshed.dig(:member, :host)

    # Same code, fetched directly the way /multiplayer/CODE does it.
    direct = get_json(guest, "/api/rooms/#{created.dig(:room, :code)}")
    assert_equal created.dig(:member, :id), direct.dig(:member, :id)
  end

  test "someone with no room gets an empty state, not an error" do
    visitor = browser
    payload = get_json(visitor, "/api/rooms/current")
    assert_equal 200, status(visitor)
    assert_nil payload[:room]
    assert_nil payload[:member]
  end

  test "readiness is advisory and counted for everyone" do
    host = browser
    code = post_json(host, "/api/rooms", display_name: "Ada").dig(:room, :code)
    guest = browser
    post_json(guest, "/api/rooms/#{code}/join", display_name: "Grace")

    payload = post_json(guest, "/api/rooms/#{code}/ready", ready: true)
    assert_equal 1, payload.dig(:room, :counts, :ready)
    assert_equal 2, payload.dig(:room, :counts, :members)
    assert payload.dig(:member, :ready)
    assert member_named(payload, "Grace")[:ready]
    assert_not member_named(payload, "Ada")[:ready]

    payload = post_json(guest, "/api/rooms/#{code}/ready", ready: false)
    assert_equal 0, payload.dig(:room, :counts, :ready)
    assert_not payload.dig(:member, :ready)
  end

  # ---- start eligibility (no engine yet) ------------------------------------

  test "a lone host cannot start a Brawl" do
    host = browser
    code = post_json(host, "/api/rooms", display_name: "Ada").dig(:room, :code)

    payload = post_json(host, "/api/rooms/#{code}/start")
    assert_equal 422, status(host)
    assert_equal "not_eligible", payload[:code]
    assert_includes payload.dig(:start, :blockers), "needs_2_players"
    assert_equal "lobby", Room.find_by_invitation_code(code).state
  end

  test "the host may start with two players even when nobody voted ready" do
    host = browser
    code = post_json(host, "/api/rooms", display_name: "Ada").dig(:room, :code)
    guest = browser
    post_json(guest, "/api/rooms/#{code}/join", display_name: "Grace")

    payload = post_json(host, "/api/rooms/#{code}/start")
    assert_equal 200, status(host)
    assert payload.dig(:start, :eligible), "ready votes are advisory, not mandatory"
    assert_equal 0, payload.dig(:room, :counts, :ready)
    assert_equal false, payload[:started], "there is no game engine yet"
    assert_equal false, payload.dig(:start, :engine_ready)
    assert_equal "lobby", Room.find_by_invitation_code(code).state, "the room must not pretend to play"
  end

  # ---- permissions ----------------------------------------------------------

  test "only the host can start, disband or hand over the crown" do
    host = browser
    code = post_json(host, "/api/rooms", display_name: "Ada").dig(:room, :code)
    guest = browser
    joined = post_json(guest, "/api/rooms/#{code}/join", display_name: "Grace")

    %w[start disband].each do |action|
      post_json(guest, "/api/rooms/#{code}/#{action}")
      assert_equal 403, status(guest), "#{action} must be host-only"
      assert_equal "forbidden", body(guest)[:code]
    end

    post_json(guest, "/api/rooms/#{code}/host", member_id: joined.dig(:member, :id))
    assert_equal 403, status(guest)
    assert_equal "Ada", host_name(get_json(host, "/api/rooms/current"))
    assert_equal "lobby", Room.find_by_invitation_code(code).state
  end

  test "a stranger cannot act inside a room they never joined" do
    host = browser
    code = post_json(host, "/api/rooms", display_name: "Ada").dig(:room, :code)

    stranger = browser
    %w[ready leave start disband].each do |action|
      post_json(stranger, "/api/rooms/#{code}/#{action}")
      assert_equal 403, status(stranger), "#{action} needs a seat"
      assert_equal_any ["not_a_member", "forbidden"], body(stranger)[:code]
    end
    assert_equal 1, Room.find_by_invitation_code(code).active_memberships.count
  end

  test "a member of one room cannot act on another room" do
    host_a = browser
    code_a = post_json(host_a, "/api/rooms", display_name: "Ada").dig(:room, :code)
    host_b = browser
    code_b = post_json(host_b, "/api/rooms", display_name: "Bob").dig(:room, :code)

    post_json(host_a, "/api/rooms/#{code_b}/disband")
    assert_equal 403, status(host_a)
    assert_equal "lobby", Room.find_by_invitation_code(code_b).state
  end

  test "posting another member's id cannot move their seat" do
    host = browser
    code = post_json(host, "/api/rooms", display_name: "Ada").dig(:room, :code)
    guest = browser
    guest_state = post_json(guest, "/api/rooms/#{code}/join", display_name: "Grace")
    host_member_id = member_named(guest_state, "Ada")[:id]

    # Grace tries to ready up "as Ada" by naming her member id.
    payload = post_json(guest, "/api/rooms/#{code}/ready",
                        ready: true, member_id: host_member_id, display_name: "Ada")

    assert member_named(payload, "Grace")[:ready], "only the caller's own seat moves"
    assert_not member_named(payload, "Ada")[:ready], "identity cannot be spoofed from the body"

    # And leaving affects only the caller.
    post_json(guest, "/api/rooms/#{code}/leave", member_id: host_member_id)
    roster = get_json(host, "/api/rooms/current")
    assert_equal 1, roster.dig(:room, :counts, :members)
    assert_equal "Ada", host_name(roster)
  end

  # ---- invalid identities ---------------------------------------------------

  test "a forged guest cookie is simply not an identity" do
    host = browser
    code = post_json(host, "/api/rooms", display_name: "Ada").dig(:room, :code)

    forger = browser
    forger.cookies[RoomIdentity::GUEST_COOKIE.to_s] = "not-a-real-token"

    assert_nil get_json(forger, "/api/rooms/current")[:room]
    post_json(forger, "/api/rooms/#{code}/ready", ready: true)
    assert_equal 403, status(forger)

    post_json(forger, "/api/rooms/#{code}/join")
    assert_equal 422, status(forger), "no identity means a display name is required"
    assert_equal "display_name_required", body(forger)[:code]
  end

  test "a revoked guest session loses its seat but not the room" do
    host = browser
    code = post_json(host, "/api/rooms", display_name: "Ada").dig(:room, :code)
    guest = browser
    post_json(guest, "/api/rooms/#{code}/join", display_name: "Grace")

    GuestSession.order(:id).last.revoke! # e.g. the identity was retired server-side

    assert_nil get_json(guest, "/api/rooms/current")[:room]
    post_json(guest, "/api/rooms/#{code}/ready", ready: true)
    assert_equal 403, status(guest)
    assert_equal "lobby", Room.find_by_invitation_code(code).state
  end

  test "claiming attaches the guest's seat to the account that signs in" do
    host = browser
    code = post_json(host, "/api/rooms", display_name: "Ada").dig(:room, :code)

    guest = browser
    joined = post_json(guest, "/api/rooms/#{code}/join", display_name: "Grace")
    seat_id = joined.dig(:member, :id)

    user = make_user(username: "GraceHopper")
    sign_in(guest, user)
    claimed = post_json(guest, "/api/rooms/claim")

    assert_equal 200, status(guest)
    assert_equal seat_id, claimed.dig(:member, :id), "the same seat, now owned by the account"
    assert_equal "Grace", claimed.dig(:member, :display_name)
    assert_equal false, claimed.dig(:member, :guest)
    assert claimed.dig(:viewer, :signed_in)
    assert_equal user.id, RoomMembership.find(seat_id).user_id
  end

  test "claiming without signing in is refused" do
    guest = browser
    post_json(guest, "/api/rooms", display_name: "Ada")
    post_json(guest, "/api/rooms/claim")
    assert_equal 401, status(guest)
  end

  # ---- leaving, switching rooms and reconnecting ----------------------------

  test "leaving keeps the guest identity so the same browser can come back" do
    host = browser
    code = post_json(host, "/api/rooms", display_name: "Ada").dig(:room, :code)
    guest = browser
    first = post_json(guest, "/api/rooms/#{code}/join", display_name: "Grace")

    left = post_json(guest, "/api/rooms/#{code}/leave")
    assert_nil left[:room]
    assert_equal code, left[:left]
    assert_nil get_json(guest, "/api/rooms/current")[:room]

    back = post_json(guest, "/api/rooms/#{code}/join", display_name: "Grace")
    assert_equal first.dig(:member, :id), back.dig(:member, :id),
                 "reconnecting reuses the same membership row"
  end

  test "joining a second room is refused until the first is left on purpose" do
    first_host = browser
    code_a = post_json(first_host, "/api/rooms", display_name: "Ada").dig(:room, :code)
    second_host = browser
    code_b = post_json(second_host, "/api/rooms", display_name: "Bob").dig(:room, :code)

    guest = browser
    post_json(guest, "/api/rooms/#{code_a}/join", display_name: "Grace")

    conflict = post_json(guest, "/api/rooms/#{code_b}/join", display_name: "Grace")
    assert_equal 409, status(guest)
    assert_equal "in_other_room", conflict[:code]
    assert_equal code_a, conflict.dig(:current, :code), "the page can name the room being left"

    confirmed = post_json(guest, "/api/rooms/#{code_b}/join",
                          display_name: "Grace", leave_current: true)
    assert_equal 200, status(guest)
    assert_equal code_b, confirmed.dig(:room, :code)
    assert_equal 1, Room.find_by_invitation_code(code_a).active_memberships.count
  end

  test "re-joining the room you are already in is a harmless no-op" do
    guest = browser
    code = post_json(guest, "/api/rooms", display_name: "Ada").dig(:room, :code)

    again = post_json(guest, "/api/rooms/#{code}/join", display_name: "Ada")
    assert_equal 200, status(guest)
    assert_equal 1, again.dig(:room, :counts, :members)
  end

  # ---- host succession, disbanding and expiry -------------------------------

  test "the crown passes immediately when the host leaves" do
    host = browser
    code = post_json(host, "/api/rooms", display_name: "Ada").dig(:room, :code)
    guest = browser
    post_json(guest, "/api/rooms/#{code}/join", display_name: "Grace")

    post_json(host, "/api/rooms/#{code}/leave")
    payload = get_json(guest, "/api/rooms/current")

    assert_equal "Grace", host_name(payload)
    assert payload.dig(:member, :host)
    post_json(guest, "/api/rooms/#{code}/disband")
    assert_equal 200, status(guest), "the new host has host powers"
  end

  test "a silent host loses the crown after the grace period" do
    host = browser
    code = post_json(host, "/api/rooms", display_name: "Ada").dig(:room, :code)
    guest = browser
    post_json(guest, "/api/rooms/#{code}/join", display_name: "Grace")

    grace = Rails.configuration.x.multiplayer.host_grace
    travel_to(Time.current + grace - 5.seconds) do
      assert_equal "Ada", host_name(get_json(guest, "/api/rooms/current")), "still within grace"
    end

    travel_to(Time.current + grace + 30.seconds) do
      payload = get_json(guest, "/api/rooms/current") # Grace keeps polling, Ada does not
      assert_equal "Grace", host_name(payload)
      assert payload.dig(:member, :host)
    end
  end

  test "the host can disband the room and everyone else is told why" do
    host = browser
    code = post_json(host, "/api/rooms", display_name: "Ada").dig(:room, :code)
    guest = browser
    post_json(guest, "/api/rooms/#{code}/join", display_name: "Grace")

    disbanded = post_json(host, "/api/rooms/#{code}/disband")
    assert_equal 200, status(host)
    assert_nil disbanded[:room]

    payload = get_json(guest, "/api/rooms/current")
    assert_nil payload[:room]
    assert_match(/disbanded by its host/, payload[:notice])

    onlooker = browser
    get_json(onlooker, "/api/rooms/#{code}")
    assert_equal 410, status(onlooker)
    assert_equal "host_disbanded", Room.find_by_invitation_code(code).closed_reason
  end

  test "invalid, disbanded and expired invitation codes each explain themselves" do
    stranger = browser
    get_json(stranger, "/api/rooms/ZZZZZZZZZZZZ")
    assert_equal 404, status(stranger)
    assert_equal "room_not_found", body(stranger)[:code]

    host = browser
    disbanded_code = post_json(host, "/api/rooms", display_name: "Ada").dig(:room, :code)
    post_json(host, "/api/rooms/#{disbanded_code}/disband")
    get_json(stranger, "/api/rooms/#{disbanded_code}")
    assert_equal 410, status(stranger)
    assert_equal "room_closed", body(stranger)[:code]
    assert_match(/disbanded by its host/, body(stranger)[:error])

    abandoned = browser
    expired_code = post_json(abandoned, "/api/rooms", display_name: "Bob").dig(:room, :code)
    post_json(abandoned, "/api/rooms/#{expired_code}/leave")
    travel_to(Time.current + Rails.configuration.x.multiplayer.room_idle + 1.minute) do
      get_json(stranger, "/api/rooms/#{expired_code}")
      assert_equal 410, status(stranger)
      assert_match(/expired/, body(stranger)[:error])
      assert_equal "expired", Room.find_by_invitation_code(expired_code).closed_reason
    end
  end

  test "an empty room survives inside the inactivity window" do
    host = browser
    code = post_json(host, "/api/rooms", display_name: "Ada").dig(:room, :code)
    post_json(host, "/api/rooms/#{code}/leave")

    onlooker = browser
    travel_to(Time.current + Rails.configuration.x.multiplayer.room_idle - 1.minute) do
      get_json(onlooker, "/api/rooms/#{code}")
      assert_equal 200, status(onlooker)
      assert_equal "lobby", Room.find_by_invitation_code(code).state
    end
  end

  test "a long-silent member loses the seat but can rejoin with the same identity" do
    host = browser
    code = post_json(host, "/api/rooms", display_name: "Ada").dig(:room, :code)
    guest = browser
    joined = post_json(guest, "/api/rooms/#{code}/join", display_name: "Grace")

    travel_to(Time.current + Rails.configuration.x.multiplayer.member_drop + 1.minute) do
      roster = get_json(host, "/api/rooms/current") # Ada is still polling
      assert_equal 1, roster.dig(:room, :counts, :members)

      back = post_json(guest, "/api/rooms/#{code}/join", display_name: "Grace")
      assert_equal 200, status(guest)
      assert_equal joined.dig(:member, :id), back.dig(:member, :id)
    end
  end

  test "clients cannot pick a room size: everyone piling in just grows the room" do
    host = browser
    payload = post_json(host, "/api/rooms", display_name: "Ada", max_members: 2)
    code = payload.dig(:room, :code)
    assert_equal Room::DEFAULT_MAX_MEMBERS, payload.dig(:room, :max_members),
                 "a size hint must never come from the client"

    with_capacity_ceiling(10) do
      # Fill all eight default seats, then keep joining: the room expands.
      7.times { |i| post_json(browser, "/api/rooms/#{code}/join", display_name: "Guest#{i}") }
      ninth_browser = browser
      ninth = post_json(ninth_browser, "/api/rooms/#{code}/join", display_name: "Ninth")
      assert_equal 200, status(ninth_browser)
      assert_equal 9, ninth.dig(:room, :counts, :members)
      assert_operator ninth.dig(:room, :max_members), :>, Room::DEFAULT_MAX_MEMBERS

      tenth = post_json(browser, "/api/rooms/#{code}/join", display_name: "Tenth")
      assert_equal 10, tenth.dig(:room, :counts, :members)

      # And at the hard ceiling the refusal is a clear, named error.
      eleventh = browser
      rejected = post_json(eleventh, "/api/rooms/#{code}/join", display_name: "Eleventh")
      assert_equal 409, status(eleventh)
      assert_equal "room_full", rejected[:code]
    end
  end

  test "writes must be JSON, like the rest of the API" do
    host = browser
    host.post "/api/rooms", params: { display_name: "Ada" }
    assert_equal 415, status(host)
  end

  private

  def assert_equal_any(allowed, actual)
    assert_includes allowed, actual
  end
end
