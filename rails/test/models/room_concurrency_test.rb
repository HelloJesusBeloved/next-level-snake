require "test_helper"

# Races against a real PostgreSQL instance.
#
# These drive Room#join! (the exact call Api::RoomsController makes) from
# several threads instead of going through HTTP: the test environment wraps
# requests in Rack::Lock, so integration sessions would be serialised and the
# race would never actually happen. Transactions are disabled so the threads
# can see each other's committed work.
class RoomConcurrencyTest < ActiveSupport::TestCase
  self.use_transactional_tests = false

  def teardown
    RoomMembership.delete_all
    Room.delete_all
    GuestSession.delete_all
    Score.delete_all
    User.delete_all
  end

  # Each thread is "another browser": its own guest identity, its own
  # connection, all hitting the same room at the same moment.
  def race(count)
    guests = Array.new(count) { GuestSession.issue.first }
    barrier = Concurrent::CountDownLatch.new(count) if defined?(Concurrent::CountDownLatch)
    results = Array.new(count)

    threads = guests.each_with_index.map do |guest, index|
      Thread.new do
        ActiveRecord::Base.connection_pool.with_connection do
          barrier&.count_down
          barrier&.wait(5)
          results[index] =
            begin
              yield(guest, index)
              :ok
            rescue Room::NotJoinable
              :rejected
            rescue ActiveRecord::RecordNotUnique, ActiveRecord::RecordInvalid
              :rejected
            end
        end
      end
    end
    threads.each { |thread| thread.join(15) }
    results
  end

  # Rooms normally expand, so this race pins the ceiling at the starting
  # size: exactly the two free seats can ever be handed out, no matter how
  # precisely five threads collide.
  test "simultaneous joins never oversubscribe the last seats" do
    room = Room.create_with_host!(guest_session: GuestSession.issue.first,
                                  display_name: "Host", max_members: 3)

    results = with_capacity_ceiling(3) do
      race(5) do |guest, index|
        Room.find(room.id).join!(guest_session: guest, display_name: "Racer#{index}")
      end
    end

    assert_equal 2, results.count(:ok), "exactly the two free seats are handed out"
    assert_equal 3, results.count(:rejected)
    room.reload
    assert_equal 3, room.active_memberships.count
    assert_operator room.active_memberships.count, :<=, room.max_members
    assert_equal 1, room.room_memberships.active.where(role: "host").count
  end

  test "concurrent joins expand the room exactly enough, only under the ceiling" do
    room = Room.create_with_host!(guest_session: GuestSession.issue.first,
                                  display_name: "Host", max_members: 2)

    with_capacity_ceiling(8) do
      6.times.map do |index|
        Thread.new do
          ActiveRecord::Base.connection_pool.with_connection do
            Room.find(room.id).join!(guest_session: GuestSession.issue.first,
                                     display_name: "Joiner#{index}")
          end
        end
      end.each { |thread| thread.join(15) }
    end

    room.reload
    assert_equal 7, room.active_memberships.count
    assert_operator room.max_members, :<=, 8
    assert_operator room.max_members, :>=, 7
  end

  test "one identity joining twice at once still gets a single seat" do
    room = Room.create_with_host!(guest_session: GuestSession.issue.first,
                                  display_name: "Host", max_members: 8)
    guest, _raw = GuestSession.issue

    threads = 4.times.map do |index|
      Thread.new do
        ActiveRecord::Base.connection_pool.with_connection do
          Room.find(room.id).join!(guest_session: guest, display_name: "Twin")
        rescue ActiveRecord::RecordNotUnique, ActiveRecord::RecordInvalid, Room::NotJoinable
          nil
        end
      end
    end
    threads.each { |thread| thread.join(15) }

    assert_equal 1, RoomMembership.where(room_id: room.id, guest_session_id: guest.id).count
    assert_equal 2, room.reload.active_memberships.count
  end

  test "two players racing for the same display name cannot both take it" do
    room = Room.create_with_host!(guest_session: GuestSession.issue.first,
                                  display_name: "Host", max_members: 8)

    results = race(4) do |guest, _index|
      Room.find(room.id).join!(guest_session: guest, display_name: "Ada")
    end

    assert_equal 1, results.count(:ok)
    assert_equal 1, room.reload.active_memberships.count { |m| m.display_name.casecmp("Ada").zero? }
  end

  test "a join racing a disband never seats anyone in a closed room" do
    room = Room.create_with_host!(guest_session: GuestSession.issue.first,
                                  display_name: "Host", max_members: 8)
    guest, _raw = GuestSession.issue

    joiner = Thread.new do
      ActiveRecord::Base.connection_pool.with_connection do
        Room.find(room.id).join!(guest_session: guest, display_name: "Latecomer")
      rescue Room::NotJoinable, ActiveRecord::RecordInvalid
        nil
      end
    end
    disbander = Thread.new do
      ActiveRecord::Base.connection_pool.with_connection do
        Room.find(room.id).disband!
      rescue Room::InvalidTransition
        nil
      end
    end
    [joiner, disbander].each { |thread| thread.join(15) }

    room.reload
    assert room.disbanded?
    assert_equal 0, room.active_memberships.count, "a disbanded room must end up empty"
  end

  test "concurrent sweeps leave exactly one host standing" do
    host_guest, _raw = GuestSession.issue
    room = Room.create_with_host!(guest_session: host_guest, display_name: "Host", max_members: 8)
    3.times do |index|
      guest, _token = GuestSession.issue
      room.join!(guest_session: guest, display_name: "Player#{index}")
    end
    # The host went quiet long enough to lose the crown.
    room.host_membership.update_columns(last_seen_at: 1.day.ago)

    threads = 4.times.map do
      Thread.new do
        ActiveRecord::Base.connection_pool.with_connection { Room.find(room.id).sweep! }
      end
    end
    threads.each { |thread| thread.join(15) }

    assert_equal 1, room.reload.room_memberships.active.where(role: "host").count
    assert_not_equal "Host", room.host_membership.display_name
  end
end
