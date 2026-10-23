require "test_helper"

# Shareable invitation URLs (step 5): where the code and join link point.
# The configured public origin (MULTIPLAYER_PUBLIC_ORIGIN) must win so shares
# and QR codes carry the address outsiders can reach; without it we fall back
# to the request's own origin — never a hardcoded host.
class InvitationUrlTest < ActionDispatch::IntegrationTest
  JSON_HEADERS = { "CONTENT_TYPE" => "application/json", "ACCEPT" => "application/json" }.freeze

  setup do
    @previous_origin = Room.config.public_origin
  end

  teardown do
    Room.config.public_origin = @previous_origin
  end

  def create_room(session)
    session.post("/api/rooms", params: { display_name: "Ada" }.to_json, headers: JSON_HEADERS)
    JSON.parse(session.response.body, symbolize_names: true)
  end

  test "without a configured origin the invitation uses the request's own origin" do
    Room.config.public_origin = nil
    payload = create_room(open_session)

    assert_equal "http://www.example.com/multiplayer/#{payload.dig(:room, :code)}",
                 payload.dig(:room, :invite_url)
    assert_equal "http://www.example.com", payload.dig(:config, :origin)
  end

  test "the configured public origin wins over the Host header" do
    Room.config.public_origin = "https://play.example.com"
    session = open_session
    payload = create_room(session)
    code = payload.dig(:room, :code)

    assert_equal "https://play.example.com/multiplayer/#{code}",
                 payload.dig(:room, :invite_url),
                 "share links and QR codes must carry the public origin"
    assert_equal "https://play.example.com", payload.dig(:config, :origin),
                 "the page needs the trusted origin to validate scanned QR URLs"

    # And a member's snapshot (what the QR renders) agrees with the preview.
    refreshed = JSON.parse(session.response.body, symbolize_names: true)
    assert_equal code, refreshed.dig(:room, :code)
  end

  test "config.origin is always present for the scanner allowlist" do
    Room.config.public_origin = nil
    payload = create_room(open_session)

    assert payload.dig(:config, :origin).present?
    assert_match %r{https?://}, payload.dig(:config, :origin)
  end

  # The parser is the exact lambda production runs (config/initializers).

  test "origin parser accepts scheme + host with an optional port" do
    parse = Room.config.origin_from_env

    assert_equal "https://play.example.com", parse.call("https://play.example.com")
    assert_equal "http://192.168.1.20:3000", parse.call("http://192.168.1.20:3000")
    assert_equal "https://snake.example.com", parse.call(" https://snake.example.com/ "),
                 "surrounding whitespace and a trailing slash are normalized away"
  end

  test "origin parser rejects anything that could smuggle a destination" do
    parse = Room.config.origin_from_env

    assert_nil parse.call(nil)
    assert_nil parse.call("")
    assert_nil parse.call("play.example.com"), "scheme is required"
    assert_nil parse.call("javascript://play.example.com"), "only http/https"
    assert_nil parse.call("https://play.example.com/evil"), "no path allowed"
    assert_nil parse.call("https://user:pass@play.example.com"), "no credentials allowed"
    assert_nil parse.call("https://play.example.com multi"), "no whitespace"
    assert_nil parse.call("file:///etc/passwd")
  end

  test "invitation code and url travel together in every room payload" do
    Room.config.public_origin = "https://play.example.com"
    payload = create_room(open_session)
    code = payload.dig(:room, :code)

    assert_match(/\A[A-Z0-9]{12}\z/, code)
    assert payload.dig(:room, :invite_url).end_with?("/multiplayer/#{code}")
    assert_equal Room.find_by_invitation_code(code).invitation_code, code
  end
end
