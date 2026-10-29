require "test_helper"

class Api::BrawlPresentationStrategyTest < ActionDispatch::IntegrationTest
  setup do
    MatchRunner.reset!
    @host = browser
    @created = post_json(@host, "/api/rooms", display_name: "Host",
                         settings: { speed_level: 5, growth: 4 })
    @code = @created.dig(:room, :code)
    @room = Room.find_by_invitation_code(@code)
    @guest = browser
    @joined = post_json(@guest, "/api/rooms/#{@code}/join", display_name: "Guest")
  end

  teardown do
    MatchRunner.shutdown!
    MatchRunner.reset!
  end

  def choose(session, strategy)
    post_json(session, "/api/rooms/#{@code}/presentation_strategy",
              presentation_strategy: strategy)
  end

  test "new rooms default to Classic independently of game mode and expose it in lobby state" do
    assert_equal "brawl", @created.dig(:room, :mode)
    assert_equal "classic", @created.dig(:room, :presentation_strategy)
    assert_equal "classic", @room.reload.presentation_strategy
    assert_equal "classic", @room.start_eligibility[:presentation_strategy]
    assert_equal true, @room.start_eligibility[:presentation_strategy_available]
  end

  test "only the host may change strategy and the change is persisted and broadcast" do
    stream = RoomChannel.stream_for(@room)
    before_version = @room.reload.version
    before_settings = @room.settings.deep_dup
    before_board = [@room.brawl_columns, @room.brawl_rows]
    before_mode = @room.mode
    before_broadcasts = ActionCable.server.pubsub.broadcasts(stream).length
    choose(@guest, "responsive")
    assert_equal before_broadcasts, ActionCable.server.pubsub.broadcasts(stream).length
    assert_equal 403, status(@guest)
    assert_equal "classic", @room.reload.presentation_strategy

    choose(@host, "responsive")
    assert_equal before_broadcasts + 1, ActionCable.server.pubsub.broadcasts(stream).length
    assert_equal 200, status(@host)
    assert_equal "responsive", body(@host).dig(:room, :presentation_strategy)
    assert_equal "responsive", @room.reload.presentation_strategy
    assert_equal before_settings, @room.settings, "speed and growth remain unchanged"
    assert_equal before_board, [@room.brawl_columns, @room.brawl_rows]
    assert_equal before_mode, @room.mode, "presentation remains separate from Brawl/Duel mode"
    event = JSON.parse(ActionCable.server.pubsub.broadcasts(stream).last)
    assert_equal "presentation_strategy_changed", event["event"]
    assert_equal "responsive", event["presentation_strategy"]
    assert_equal before_version + 1, event["v"]

    choose(@host, "not-a-strategy")
    assert_equal 422, status(@host)
    assert_equal "responsive", @room.reload.presentation_strategy
  end

  test "Responsive is honestly unavailable and cannot silently start a Classic match" do
    choose(@host, "responsive")
    assert_equal 200, status(@host)
    assert_includes @room.reload.start_eligibility[:blockers], "responsive_strategy_unavailable"

    post_json(@host, "/api/rooms/#{@code}/start")
    assert_equal 422, status(@host)
    assert_match(/Responsive Brawl is unavailable/, body(@host)[:error])
    assert_equal 0, @room.matches.count
    assert_equal "lobby", @room.reload.state
    assert_equal "responsive", @room.presentation_strategy

    choose(@host, "classic")
    started = post_json(@host, "/api/rooms/#{@code}/start")
    assert_equal 201, status(@host)
    assert_equal "classic", started.dig(:match, :presentation_strategy)
    assert_equal "classic", @room.reload.match_configuration["presentation_strategy"]
    assert_equal "classic", @room.live_match.presentation_strategy
  end

  test "a match locks its selected strategy while the host may choose for the next Brawl" do
    post_json(@host, "/api/rooms/#{@code}/start")
    assert_equal 201, status(@host)
    first_match = @room.reload.live_match
    assert_equal "classic", first_match.presentation_strategy
    assert_raises(ActiveRecord::RecordInvalid) do
      first_match.update!(presentation_strategy: "responsive")
    end

    choose(@host, "responsive")
    assert_equal 409, status(@host), "strategy is locked during a running match"
    assert_equal "classic", first_match.reload.presentation_strategy
    assert_equal "classic", @room.reload.presentation_strategy

    @room.finish_match!
    choose(@host, "responsive")
    assert_equal 200, status(@host)
    assert_equal "responsive", @room.reload.presentation_strategy
    assert_equal "classic", first_match.reload.presentation_strategy

    choose(@host, "classic")
    second = post_json(@host, "/api/rooms/#{@code}/start")
    assert_equal 201, status(@host)
    assert_equal "classic", second.dig(:match, :presentation_strategy)
    assert_equal "classic", @room.reload.live_match.presentation_strategy
    assert_equal "classic", first_match.reload.presentation_strategy
  end
end
