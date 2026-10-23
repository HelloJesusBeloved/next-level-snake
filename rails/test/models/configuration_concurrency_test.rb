require "test_helper"
require "action_cable/test_helper"

# Real connections and transactions, not request stubs or a transactional
# fixture (other threads must be able to observe committed rows).
class ConfigurationConcurrencyTest < ActiveSupport::TestCase
  include ActionCable::TestHelper
  self.use_transactional_tests = false

  setup do
    @guests = []
    @rooms = []
    @room = Room.create_with_host!(guest_session: guest, display_name: "Host")
    @rooms << @room.id
  end

  teardown do
    Room.where(id: @rooms).destroy_all
    GuestSession.where(id: @guests).delete_all
  end

  def guest
    record, = GuestSession.issue
    @guests << record.id
    record
  end

  def race(count)
    gate = Queue.new
    threads = count.times.map do |index|
      Thread.new do
        ActiveRecord::Base.connection_pool.with_connection do
          gate.pop
          yield(index)
        end
      end
    end
    count.times { gate << true }
    threads.map(&:value)
  end

  test "racing joins get unique solid colors and keep spare choices" do
    identities = 6.times.map { guest }
    ids = race(6) { |n| Room.find(@room.id).join!(guest_session: identities[n], display_name: "Racer#{n}").id }
    assert_equal 6, ids.uniq.size
    slots = @room.room_memberships.active.pluck(:color_slot)
    assert_equal 7, slots.size
    assert_equal slots.size, slots.uniq.size
    assert_operator @room.palette_payload[:options].count { |c| !c[:taken_by] && !c[:locked] }, :>=, 6
  end

  test "one winner when two players race for an unclaimed color" do
    seats = 2.times.map { |n| @room.join!(guest_session: guest, display_name: "Player#{n}") }
    results = race(2) do |n|
      begin
        Room.find(@room.id).choose_color!(seats[n], 5)
        :won
      rescue Room::InvalidTransition
        :lost
      end
    end
    assert_equal 1, results.count(:won)
    assert_equal 1, results.count(:lost)
    assert_equal 1, @room.room_memberships.active.where(color_slot: 5).count
  end

  test "committed color and board policy changes broadcast shared versioned room events" do
    member = @room.host_membership
    stream = RoomChannel.stream_for(@room)
    assert_broadcasts(stream, 1) { @room.choose_color!(member, 4) }
    color = JSON.parse(ActionCable.server.pubsub.broadcasts(stream).last)
    assert_equal "member_color", color["event"]
    assert_equal @room.reload.version, color["v"]
    assert_broadcasts(stream, 1) do
      @room.report_capabilities!(member, client_id: "desktop-report-00001", capabilities: {
        width: 1440, height: 900, screen_width: 1920, screen_height: 1080,
        coarse: false, fine: true, hover: true, touch_points: 0
      })
    end
    assert_broadcasts(stream, 1) { @room.update_board!(member, columns: 48, rows: 36) }
    event = JSON.parse(ActionCable.server.pubsub.broadcasts(stream).last)
    assert_equal "board_changed", event["event"]
    assert_equal @room.reload.version, event["v"]
  end

  test "a mobile report racing start either affects this grid or the next, never mutates the frozen snapshot" do
    member = @room.join!(guest_session: guest, display_name: "Rival")
    desktop = { width: 1440, height: 900, screen_width: 1920, screen_height: 1080,
                coarse: false, fine: true, hover: true, touch_points: 0 }
    [@room.host_membership, member].each do |m|
      @room.report_capabilities!(m, client_id: "desktop-report-00001", capabilities: desktop)
    end
    @room.update_board!(@room.host_membership, columns: 64, rows: 48)
    race(2) do |index|
      room = Room.find(@room.id)
      if index.zero?
        room.start_match!
      else
        room.report_capabilities!(member, client_id: "desktop-report-00001", capabilities: desktop.merge(width: 400))
      end
    end
    frozen = @room.reload.match_configuration.deep_dup
    assert_includes [[64, 48], [24, 18]], frozen.values_at("columns", "rows")
    assert_equal 2, frozen["participants"].size
    @room.report_capabilities!(member, client_id: "desktop-report-00001", capabilities: desktop)
    assert_equal frozen, @room.reload.match_configuration
  end
end
