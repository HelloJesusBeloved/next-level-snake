require "test_helper"

class RoomConfigurationTest < ActiveSupport::TestCase
  DESKTOP = { width: 1440, height: 900, screen_width: 1920, screen_height: 1080,
              coarse: false, fine: true, hover: true, touch_points: 0 }.freeze

  def desktop!(room, member, client: "desktop-tab-0000001", at: Time.current)
    room.report_capabilities!(member, client_id: client, capabilities: DESKTOP, at: at)
  end

  def two_desktops
    room = make_room_with_guest_host
    second = room.join!(guest_session: make_guest.first, display_name: "Rival")
    desktop!(room, room.host_membership)
    desktop!(room, second)
    [room, second]
  end

  test "palette uses distinct hues first then visible lightness bands with 96 unique solid colors" do
    options = RoomPalette.colors
    assert_equal 96, options.size
    assert_equal options.size, options.map { |c| c[:hex] }.uniq.size
    assert options.all? { |c| c[:hex].match?(/\A#[0-9A-F]{6}\z/) }
    assert options.first(24).all? { |c| c[:label].start_with?("Medium") }
    assert options[24][:label].start_with?("Dark")
    assert options[48][:label].start_with?("Light")
    assert_raises(ArgumentError) { RoomPalette.color(1000) }
  end

  test "guest host and every joining identity immediately get unique colors without accounts" do
    assert_no_difference "User.count" do
      room = make_room_with_guest_host
      63.times { |n| room.join!(guest_session: make_guest.first, display_name: "Player#{n}") }
      seats = room.room_memberships.active.to_a
      assert_equal 64, seats.size
      assert_equal 64, seats.map(&:color_slot).uniq.size
      assert seats.all? { |member| member.identity_color[:hex].present? }
      assert_operator room.palette_payload[:options].count { |c| c[:taken_by].nil? && !c[:locked] }, :>=, RoomPalette::SPARE_OPTIONS
    end
  end

  test "color change is permanent across reloads and cannot take another member's option" do
    room, member = two_desktops
    previous = member.color_slot
    slot = room.palette_payload[:options].find { |c| c[:taken_by].nil? }[:slot]
    room.choose_color!(member, slot)
    assert_equal slot, member.reload.color_slot
    assert_not_equal previous, slot
    assert_raises(Room::InvalidTransition) { room.choose_color!(room.host_membership, slot) }
    assert_raises(ArgumentError) { room.choose_color!(member, "2") }
    assert_raises(ArgumentError) { room.choose_color!(member, 900) }
  end

  test "a departed seat frees its color and rejoining never steals that color back" do
    room, member = two_desktops
    old_slot = member.color_slot
    member.leave!
    newcomer = room.join!(guest_session: make_guest.first, display_name: "Replacement")
    room.choose_color!(newcomer, old_slot)
    back = room.join!(guest_session: member.guest_session, display_name: "Rival")
    assert_equal old_slot, newcomer.reload.color_slot
    assert_not_equal old_slot, back.reload.color_slot
    assert_equal member.id, back.id
  end

  test "database refuses duplicate active colors even if model validations are skipped" do
    room, member = two_desktops
    assert_raises(ActiveRecord::RecordNotUnique) do
      RoomMembership.transaction(requires_new: true) { member.update_columns(color_slot: room.host_membership.color_slot) }
    end
    assert_not_equal member.reload.color_slot, room.host_membership.color_slot
  end

  test "a palette at its finite reservation limit refuses clearly rather than duplicating" do
    room, member = two_desktops
    room.start_match!
    # Simulate a maximally reserved future roster; the allocation policy must
    # retain the promised six spare options and refuse a new seat honestly.
    room.finish_match!
    snapshot = room.match_configuration.deep_dup
    snapshot["participants"] = (0...90).map { |n| { "color_slot" => n, "membership_id" => n + 1 } }
    room.update!(match_configuration: snapshot, state: "in_match")
    assert_raises(Room::NotJoinable) { room.join!(guest_session: make_guest.first, display_name: "NoDuplicate") }
  end

  test "classification requires bounded viewport input and device facts, not a user agent" do
    assert_equal "desktop", RoomBoard.classify(DESKTOP)
    [DESKTOP.merge(width: 800), DESKTOP.merge(touch_points: 1), DESKTOP.merge(coarse: true),
     DESKTOP.merge(hover: false), DESKTOP.merge(fine: false), DESKTOP.merge(mobile_hint: true),
     DESKTOP.merge(screen_width: 390)].each do |raw|
      assert_equal "mobile", RoomBoard.classify(raw)
    end
    [nil, {}, { user_agent: "Desktop" }, DESKTOP.merge(width: "1440"),
     DESKTOP.merge(width: -100), DESKTOP.merge(coarse: "false")].each do |raw|
      assert_equal "unknown", RoomBoard.classify(raw)
    end
  end

  test "all eligible desktops allow a host preference with count-based recommendations" do
    room, = two_desktops
    assert room.board_payload[:custom_allowed]
    room.update_board!(room.host_membership, columns: 48, rows: 36)
    assert_equal [48, 36], room.board_payload.values_at(:columns, :rows)
    assert_equal [24, 18], RoomBoard::DEFAULT.values_at(:columns, :rows)
    assert_equal "classic", RoomBoard.recommendation(2)[:key]
    assert_equal "roomy", RoomBoard.recommendation(8)[:key]
    assert_equal "large", RoomBoard.recommendation(12)[:key]
    assert_equal "arena", RoomBoard.recommendation(64)[:key]
  end

  test "one mobile tab wins over other desktop tabs for the same participant" do
    room, member = two_desktops
    room.update_board!(room.host_membership, columns: 64, rows: 48)
    room.report_capabilities!(member, client_id: "mobile-tab-00000001", capabilities: DESKTOP.merge(width: 390, touch_points: 5))
    desktop!(room, member, client: "another-desktop-0001")
    assert_equal "mobile", member.reload.device_kind
    assert_equal [24, 18], room.board_payload.values_at(:columns, :rows)
    assert_match(/Mobile or unverified/, room.board_payload[:reason])
    assert_raises(Room::InvalidTransition) { room.update_board!(room.host_membership, columns: 40, rows: 30) }
    assert_equal 64, room.reload.brawl_columns, "preference survives but is not the effective board"
  end

  test "missing and stale reports never establish desktop eligibility" do
    room = make_room_with_guest_host
    assert_not room.board_payload[:custom_allowed]
    room, member = two_desktops
    future = Time.current + RoomBoard::REPORT_TTL + 1
    room.room_memberships.active.each { |m| m.mark_seen!(at: future) }
    assert_not room.board_payload(at: future)[:custom_allowed]
    assert_equal 2, room.board_payload(at: future)[:unknown]
  end

  test "host-only board validation and strict numeric bounds" do
    room, member = two_desktops
    assert_raises(Room::InvalidTransition) { room.update_board!(member, columns: 48, rows: 36) }
    [["48", 36], [0, 24], [1000, 1000], [32.5, 24], [32, nil]].each do |columns, rows|
      assert_raises(ArgumentError) { room.update_board!(room.host_membership, columns: columns, rows: rows) }
    end
  end

  test "start rechecks eligible participants and mobile status and freezes dimensions and colors" do
    room, member = two_desktops
    room.update_board!(room.host_membership, columns: 64, rows: 48)
    room.report_capabilities!(member, client_id: "desktop-tab-0000001", capabilities: DESKTOP.merge(width: 500))
    room.start_match!
    config = room.reload.match_configuration.deep_dup
    assert_equal [24, 18], config.values_at("columns", "rows")
    assert config["mobile_default"]
    assert_equal 2, config["participants"].size
    assert config["participants"].all? { |p| p["color"] == RoomPalette.color(p["color_slot"])[:hex] }

    desktop!(room, member)
    late = room.join!(guest_session: make_guest.first, display_name: "Watching")
    assert late.spectator?
    assert_not room.eligible_players.map(&:id).include?(late.id)
    desktop!(room, late)
    member.leave!
    assert_equal config, room.reload.match_configuration
    assert room.board_payload[:frozen]
    assert_equal [24, 18], room.board_payload.values_at(:columns, :rows)
    assert_raises(Room::InvalidTransition) { room.update_board!(room.host_membership, columns: 96, rows: 72) }
    assert_raises(Room::InvalidTransition) { room.choose_color!(room.host_membership, 6) }
    assert_raises(RoomMembership::InvalidTransition) { late.mark_ready! }
  end

  test "frozen configuration cannot change through models or direct SQL during an active match" do
    room, = two_desktops
    room.start_match!
    frozen = room.match_configuration.deep_dup
    assert_raises(ActiveRecord::RecordInvalid) do
      room.update!(match_configuration: frozen.merge("columns" => 64))
    end
    room.reload
    assert_raises(ActiveRecord::StatementInvalid) do
      Room.transaction(requires_new: true) { room.update_columns(match_configuration: frozen.merge("columns" => 64)) }
    end
    assert_equal frozen, room.reload.match_configuration
  end

  test "rematch reevaluates devices and admits prior spectators without touching the old snapshot" do
    room, = two_desktops
    room.update_board!(room.host_membership, columns: 48, rows: 36)
    room.start_match!
    previous = room.match_configuration.deep_dup
    watcher = room.join!(guest_session: make_guest.first, display_name: "PhoneNextRound")
    room.report_capabilities!(watcher, client_id: "mobile-tab-00000001", capabilities: DESKTOP.merge(touch_points: 3))
    assert_equal previous, room.reload.match_configuration
    room.finish_match!
    room.return_to_lobby!
    assert_not watcher.reload.spectator?
    room.start_match!
    assert_equal [24, 18], room.match_configuration.values_at("columns", "rows")
    assert_equal 3, room.match_configuration["participants"].size
  end

  test "device report overflow is bounded and fails closed instead of losing a mobile tab" do
    room = make_room_with_guest_host
    member = room.host_membership
    RoomBoard::MAX_CLIENTS.times do |n|
      desktop!(room, member, client: "device-tab-%016d" % n)
    end
    assert room.board_payload[:custom_allowed]
    room.report_capabilities!(member, client_id: "extra-tab-000000001", capabilities: DESKTOP.merge(width: 390))
    assert_not room.board_payload[:custom_allowed]
    assert_operator member.reload.device_reports.size, :<=, RoomBoard::MAX_CLIENTS + 1
    desktop!(room, member, client: "device-tab-%016d" % 0)
    assert_not room.board_payload[:custom_allowed], "other desktop tabs must not erase overflow"
  end

  test "offline mobile members do not block eligible desktops, but a returning mobile member does" do
    room, member = two_desktops
    room.report_capabilities!(member, client_id: "desktop-tab-0000001", capabilities: DESKTOP.merge(width: 390))
    assert_not room.board_payload[:custom_allowed]
    member.update_columns(last_seen_at: 1.hour.ago)
    assert room.board_payload[:custom_allowed]
    member.mark_seen!
    assert_not room.board_payload[:custom_allowed]
  end

  test "identity colors apply to both existing room modes without adding a Duel UI" do
    room = make_room_with_guest_host(mode: "duel", max_members: 2)
    challenger = room.join!(guest_session: make_guest.first, display_name: "Challenger")
    assert_not_equal room.host_membership.color_slot, challenger.color_slot
    assert_not room.board_payload[:custom_allowed]
  end

  test "server default dimensions match the unchanged canonical single-player entry point" do
    engine = Rails.root.parent.join("public/game.js").read
    assert_match(/var cols = opts\.cols \|\| #{RoomBoard::DEFAULT[:columns]}/, engine)
    assert_match(/var rows = opts\.rows \|\| #{RoomBoard::DEFAULT[:rows]}/, engine)
    page = Rails.root.parent.join("public/app.js").read
    options = page.match(/SnakeGame\.create\(root, \{(.*?)\}\);/m)[1]
    assert_no_match(/\b(cols|rows):/, options, "single-player page must use those engine defaults")
  end

  test "fewer than two online eligible players cannot start, even with a larger saved board" do
    room, member = two_desktops
    member.update_columns(last_seen_at: 1.hour.ago)
    assert_raises(Room::InvalidTransition) { room.start_match! }
    assert room.reload.lobby?
    assert_nil room.match_configuration
  end
end
