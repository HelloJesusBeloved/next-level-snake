require "test_helper"

# Who may open a WebSocket at all (step 4). A socket handshake must carry one
# of the two credentials the HTTP API already accepts — the signed-in session
# or the encrypted guest cookie — or it is refused before any subscription
# could even be attempted.
class ConnectionTest < ActionCable::Connection::TestCase
  tests ApplicationCable::Connection

  test "rejects a browser with no identity" do
    assert_reject_connection { connect "/cable" }
  end

  test "accepts a signed-in account from the existing session" do
    user = User.create!(username: "SocketUser", password: "correct horse battery")

    connect "/cable", session: { user_id: user.id }

    assert_equal user, connection.current_user
    assert_nil connection.current_guest_session
  end

  test "accepts a guest holding a live room-session cookie" do
    _record, raw_token = GuestSession.issue
    cookies.encrypted[:snake_guest] = raw_token

    connect "/cable"

    assert connection.current_guest_session
    assert_nil connection.current_user
  end

  test "a forged guest cookie is not an identity" do
    cookies.encrypted[:snake_guest] = "not-a-real-token"

    assert_reject_connection { connect "/cable" }
  end

  test "a revoked guest session cannot open a socket" do
    record, raw_token = GuestSession.issue
    record.revoke!
    cookies.encrypted[:snake_guest] = raw_token

    assert_reject_connection { connect "/cable" }
  end

  test "an expired guest session cannot open a socket" do
    record, raw_token = GuestSession.issue(lifetime_seconds: -1) # already dead
    cookies.encrypted[:snake_guest] = raw_token

    assert_not record.usable?
    assert_reject_connection { connect "/cable" }
  end
end
