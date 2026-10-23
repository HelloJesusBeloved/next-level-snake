require "test_helper"

class Api::RoomConfigurationTest < ActionDispatch::IntegrationTest
  DESKTOP = {
    width: 1440, height: 900, screen_width: 1920, screen_height: 1080,
    coarse: false, fine: true, hover: true, touch_points: 0
  }.freeze

  setup do
    @host = browser
    @created = post_json(@host, "/api/rooms", display_name: "Host")
    @code = @created.dig(:room, :code)
    @guest = browser
    @joined = post_json(@guest, "/api/rooms/#{@code}/join", display_name: "Guest")
  end

  def report(session, caps = DESKTOP)
    post_json(session, "/api/rooms/#{@code}/capabilities", client_id: "browser-tab-00000001", capabilities: caps)
  end

  test "colors are assigned to guests on entry and only their own seat can be changed" do
    assert @created.dig(:member, :color, :hex).match?(/\A#[0-9A-F]{6}\z/)
    assert_not_equal @created.dig(:member, :color, :slot), @joined.dig(:member, :color, :slot)
    slot = @joined.dig(:room, :colors, :options).find { |o| o[:taken_by].nil? }[:slot]
    out = post_json(@guest, "/api/rooms/#{@code}/color", color_slot: slot, member_id: @created.dig(:member, :id))
    assert_equal 200, status(@guest)
    assert_equal slot, out.dig(:member, :color, :slot)
    host = get_json(@host, "/api/rooms/current")
    assert_equal @created.dig(:member, :color), host.dig(:member, :color)
    assert_operator host.dig(:room, :version), :>, @created.dig(:room, :version)
    post_json(@host, "/api/rooms/#{@code}/color", color_slot: slot)
    assert_equal 409, status(@host)
    post_json(@host, "/api/rooms/#{@code}/color", color_slot: "#fff; background:red")
    assert_equal 422, status(@host)
  end

  test "strangers and members of another room cannot configure this room" do
    stranger = browser
    %w[color capabilities board].each do |action|
      post_json(stranger, "/api/rooms/#{@code}/#{action}", color_slot: 3, columns: 40, rows: 30)
      assert_equal 403, status(stranger)
    end
  end

  test "host settings are restricted by server capability reports, not a desktop claim field" do
    post_json(@host, "/api/rooms/#{@code}/board", columns: 48, rows: 36, desktop: true)
    assert_equal 409, status(@host)
    report(@host); report(@guest)
    post_json(@guest, "/api/rooms/#{@code}/board", columns: 48, rows: 36, host: true)
    assert_equal 403, status(@guest)
    out = post_json(@host, "/api/rooms/#{@code}/board", columns: 48, rows: 36)
    assert_equal 200, status(@host)
    assert_equal [48, 36], out[:room][:board].values_at(:columns, :rows)
    out = report(@guest, DESKTOP.merge(coarse: true))
    assert_equal [24, 18], out[:room][:board].values_at(:columns, :rows)
    post_json(@host, "/api/rooms/#{@code}/board", columns: 64, rows: 48)
    assert_equal 409, status(@host)
    assert_match(/Mobile or unverified/, body(@host)[:error])
  end

  test "malformed device data and per-tab identifiers never grant custom sizes" do
    post_json(@guest, "/api/rooms/#{@code}/capabilities", client_id: "bad", capabilities: DESKTOP)
    assert_equal 422, status(@guest)
    out = report(@guest, { desktop: true, width: "infinite" })
    assert_equal "unknown", out.dig(:member, :device)
    assert_not out.dig(:room, :board, :custom_allowed)
  end

  test "start is still only eligibility, while late join and telemetry cannot mutate a frozen match" do
    report(@host); report(@guest)
    out = post_json(@host, "/api/rooms/#{@code}/start")
    assert_equal false, out[:started]
    assert_nil Room.find_by_invitation_code(@code).match_configuration
    room = Room.find_by_invitation_code(@code)
    room.update_board!(room.host_membership, columns: 64, rows: 48)
    room.start_match! # model hook only, no gameplay endpoint
    config = room.match_configuration.deep_dup
    late = browser
    out = post_json(late, "/api/rooms/#{@code}/join", display_name: "Spectator")
    assert_equal 200, status(late)
    assert out.dig(:member, :spectator)
    assert out.dig(:room, :board, :frozen)
    post_json(late, "/api/rooms/#{@code}/ready", ready: true)
    assert_equal 409, status(late)
    report(@guest, DESKTOP.merge(width: 390))
    post_json(@host, "/api/rooms/#{@code}/board", columns: 48, rows: 36)
    assert_equal 409, status(@host)
    assert_equal config, room.reload.match_configuration
  end
end
