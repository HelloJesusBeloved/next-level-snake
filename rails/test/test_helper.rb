ENV["RAILS_ENV"] ||= "test"
require_relative "../config/environment"
require "rails/test_help"

# Small record builders shared by the multiplayer model tests. Tests build
# their own rows (there are no fixtures in this app yet) inside the usual
# per-test transaction, so everything rolls back afterwards.
#
# Run with:  bundle exec rails test    (from rails/, test DB must exist)
# or:        bundle exec ruby -Itest test/models/room_test.rb
# DATABASE_URL, when set, wins over config/database.yml as elsewhere.
module MultiplayerTestHelpers
  def make_user(username: "player-#{SecureRandom.hex(4)}")
    User.create!(username: username, password: "correct horse battery")
  end

  # Returns [session, raw_token] — tests that only need "a guest" can take
  # .first, tests about credentials keep the raw token.
  def make_guest
    GuestSession.issue
  end

  def make_room_with_user_host(host = make_user, **attrs)
    Room.create_with_host!(user: host, display_name: "Host", **attrs)
  end

  def make_room_with_guest_host(session = make_guest.first, **attrs)
    Room.create_with_host!(guest_session: session, display_name: "GuestHost", **attrs)
  end
end

class ActiveSupport::TestCase
  include MultiplayerTestHelpers
end
