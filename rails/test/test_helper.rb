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

  # Temporarily lowers the hard expansion ceiling so capacity races stay fast.
  def with_capacity_ceiling(value)
    cfg = Rails.configuration.x.multiplayer
    previous = cfg.max_capacity
    cfg.max_capacity = value
    yield
  ensure
    cfg.max_capacity = previous
  end

  def make_guest_membership(room, name)
    room.join!(guest_session: make_guest.first, display_name: name)
  end
end

# Request-test helpers. Every multiplayer endpoint is JSON-only (see
# Api::BaseController), and identity lives in cookies, so tests drive real
# "browsers" through ActionDispatch sessions instead of stubbing anything.
module MultiplayerRequestHelpers
  PASSWORD = "correct horse battery"
  JSON_HEADERS = { "CONTENT_TYPE" => "application/json", "ACCEPT" => "application/json" }.freeze

  # An independent cookie jar — a second browser, or a second person.
  def browser
    open_session
  end

  def post_json(session, path, payload = {})
    session.post(path, params: payload.to_json, headers: JSON_HEADERS)
    body(session)
  end

  def get_json(session, path)
    session.get(path, headers: { "ACCEPT" => "application/json" })
    body(session)
  end

  def body(session)
    JSON.parse(session.response.body, symbolize_names: true)
  rescue JSON::ParserError
    {}
  end

  def status(session)
    session.response.status
  end

  def sign_in(session, user, password = PASSWORD)
    post_json(session, "/api/auth/login", username: user.username, password: password)
  end

  def member_named(payload, name)
    payload.dig(:room, :members).to_a.find { |member| member[:display_name] == name }
  end

  def host_name(payload)
    payload.dig(:room, :members).to_a.find { |member| member[:host] }&.dig(:display_name)
  end
end

class ActiveSupport::TestCase
  include MultiplayerTestHelpers
  include ActiveSupport::Testing::TimeHelpers
end

class ActionDispatch::IntegrationTest
  include MultiplayerRequestHelpers
end
