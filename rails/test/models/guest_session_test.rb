require "test_helper"

class GuestSessionTest < ActiveSupport::TestCase
  test "issue returns the raw token once and stores only its digest" do
    session, raw_token = GuestSession.issue

    assert raw_token.length >= 40, "token should carry ample entropy"
    assert_equal Digest::SHA256.hexdigest(raw_token), session.token_digest
    assert_not_equal raw_token, session.token_digest
    # The raw bearer secret must not appear in ANY stored column.
    session.attributes.each_value do |value|
      assert_not_equal raw_token, value.to_s
    end
    assert session.public_id.present?
    assert_not_equal raw_token, session.public_id
  end

  test "authenticate resolves the raw token and nothing else" do
    session, raw_token = GuestSession.issue

    assert_equal session, GuestSession.authenticate(raw_token)
    assert_nil GuestSession.authenticate(nil)
    assert_nil GuestSession.authenticate("")
    assert_nil GuestSession.authenticate("not-a-token")
    # Non-secret handles must never work as credentials.
    assert_nil GuestSession.authenticate(session.public_id)
    assert_nil GuestSession.authenticate(session.token_digest)
  end

  test "another guest's token authenticates only that other guest" do
    _victim, victim_raw = GuestSession.issue
    other, other_raw = GuestSession.issue

    assert_equal other, GuestSession.authenticate(other_raw)
    assert_not_equal GuestSession.authenticate(victim_raw), GuestSession.authenticate(other_raw)
  end

  test "expired sessions no longer authenticate" do
    session, raw_token = GuestSession.issue(lifetime_seconds: 60)

    assert_equal session, GuestSession.authenticate(raw_token, at: session.expires_at - 1.second)
    assert_nil GuestSession.authenticate(raw_token, at: session.expires_at + 1.second)
    assert session.expired?(at: session.expires_at)
  end

  test "revoked sessions no longer authenticate" do
    session, raw_token = GuestSession.issue
    session.revoke!

    assert session.revoked?
    assert_nil GuestSession.authenticate(raw_token)
  end

  test "rotate_token! replaces the credential and kills the old one" do
    session, old_raw = GuestSession.issue
    new_raw = session.rotate_token!

    assert_not_equal old_raw, new_raw
    assert_nil GuestSession.authenticate(old_raw)
    assert_equal session, GuestSession.authenticate(new_raw)
  end

  test "a dead session cannot rotate its way back to life" do
    session, _raw = GuestSession.issue
    session.revoke!

    assert_raises(GuestSession::InvalidSession) { session.rotate_token! }
  end

  test "serialisation never includes the token digest" do
    session, _raw = GuestSession.issue

    assert_not_includes session.serializable_hash.keys.map(&:to_s), "token_digest"
    assert_not_includes session.to_json, session.token_digest
    assert_includes session.to_json, session.public_id
  end

  test "claimed stamp must name the account and the moment together" do
    session, _raw = GuestSession.issue
    session.claimed_at = Time.current

    assert_not session.valid?
    assert session.errors[:claimed_at].present?
  end

  test "a claimed session's token is retired" do
    session, raw_token = GuestSession.issue
    user = make_user
    session.mark_claimed_by!(user)

    assert session.claimed?
    assert_equal user, session.claimed_by_user
    assert_nil GuestSession.authenticate(raw_token)
  end

  test "touch_last_seen! is throttled" do
    at = Time.current
    session, _raw = GuestSession.issue(at: at)

    session.touch_last_seen!(at: at + 10.seconds)
    assert_in_delta at.to_f, session.reload.last_seen_at.to_f, 1.0

    session.touch_last_seen!(at: at + 5.minutes)
    assert_in_delta (at + 5.minutes).to_f, session.reload.last_seen_at.to_f, 1.0
  end

  test "guests exist with no user account anywhere" do
    assert_no_difference "User.count" do
      session, _raw = GuestSession.issue
      make_room_with_guest_host(session)
    end
  end
end
