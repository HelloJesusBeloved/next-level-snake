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

  # Step 3 replaces the step-1 "unavailable" contract with the real one: a
  # Responsive match STARTS, and the strategy it runs is never silently swapped
  # for Classic. The guarantee that remains is that the strategy is reported
  # truthfully everywhere (start response, frozen room configuration, match row
  # and every frame), so a client can never claim Responsive while Classic runs.
  test "Responsive starts a real match and is reported truthfully everywhere" do
    choose(@host, "responsive")
    assert_equal 200, status(@host)
    assert_empty @room.reload.start_eligibility[:blockers]
    assert_equal true, @room.start_eligibility[:presentation_strategy_available]

    started = post_json(@host, "/api/rooms/#{@code}/start")
    assert_equal 201, status(@host)
    assert_equal "responsive", started.dig(:match, :presentation_strategy)
    assert_equal "responsive", @room.reload.match_configuration["presentation_strategy"]
    match = @room.live_match
    assert_equal "responsive", match.presentation_strategy
    # The world the simulator steps is labelled Responsive, so every frame it
    # emits carries "strategy":"responsive".
    world = match.build_world
    assert_equal "responsive", world.presentation_strategy
    assert_equal "responsive", Simulation::Protocol.encode(world)["strategy"]
    assert_equal "responsive", Simulation::Protocol.encode_movement(world)["strategy"]
    # ...and no Classic match was created behind the lobby's back.
    assert_equal 1, @room.matches.count
    assert_equal ["responsive"], @room.matches.pluck(:presentation_strategy)
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
