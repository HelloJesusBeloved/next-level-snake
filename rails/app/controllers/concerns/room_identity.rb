# Resolves *who is making this request* for multiplayer endpoints, and nothing
# else. Identity is taken exclusively from credentials the browser cannot forge
# and the page never sees:
#
#   * signed-in players  -> session[:user_id] (the existing Rails login)
#   * guests             -> an httpOnly, SameSite=Lax, encrypted cookie holding
#                           the raw GuestSession token from step 2
#
# Nothing in the request body or query string is ever consulted for identity,
# so a client cannot act as another member by posting their member id, display
# name or invitation code. Controllers get `current_membership` and must do
# their own host checks on top of it (see Api::RoomsController#require_host!).
module RoomIdentity
  extend ActiveSupport::Concern

  # Distinct from "_snake_session" so signing in or out never disturbs a guest
  # identity, and vice versa.
  GUEST_COOKIE = :snake_guest

  private

  # The guest behind this request, if their cookie is still valid. Expired,
  # revoked and already-claimed tokens all resolve to nil (GuestSession).
  def current_guest_session
    return @current_guest_session if defined?(@current_guest_session)

    @current_guest_session = GuestSession.authenticate(cookies.encrypted[GUEST_COOKIE])
  end

  # Issues a guest identity on demand — only when somebody actually creates or
  # joins a room, never for a passer-by loading the page. The raw token goes
  # straight into the cookie; the database keeps only its SHA-256 digest.
  def ensure_guest_session!
    return current_guest_session if current_guest_session

    record, raw_token = GuestSession.issue
    cookies.encrypted[GUEST_COOKIE] = {
      value: raw_token,
      httponly: true,
      same_site: :lax,
      secure: request.ssl?,
      path: "/",
      expires: record.expires_at
    }
    @current_guest_session = record
  end

  # Leaving a room must NOT forget who you are: the cookie stays so the same
  # browser can return to its seat. Only claiming (which revokes the token
  # server-side) clears it.
  def forget_guest_session!
    cookies.delete(GUEST_COOKIE, path: "/")
    remove_instance_variable(:@current_guest_session) if defined?(@current_guest_session)
  end

  # [user, guest_session] — at most one is present, matching the XOR identity
  # on room_memberships. A signed-in player is never also treated as a guest.
  def room_identity
    current_user ? [current_user, nil] : [nil, current_guest_session]
  end

  def identified?
    current_user.present? || current_guest_session.present?
  end

  # The one seat this requester currently holds anywhere, or nil. The database
  # guarantees at most one active membership per identity (step 2).
  def current_membership
    return @current_membership if defined?(@current_membership)

    @current_membership =
      if current_user
        current_user.room_memberships.active.includes(:room).first
      elsif current_guest_session
        current_guest_session.room_memberships.active.includes(:room).first
      end
  end

  def reset_current_membership!
    remove_instance_variable(:@current_membership) if defined?(@current_membership)
  end

  # Presence heartbeat: every identified multiplayer request is a sign of life,
  # which is what keeps a seat and the crown (see Room#sweep!).
  def touch_presence!
    # PERFORMANCE (step 10 perf): presence is a 90 s window, so writing
    # last_seen on every 5 s poll was pure write amplification (and one of the
    # reasons polling clients felt sluggish). Throttled writes keep the same
    # semantics with a fraction of the traffic.
    current_membership&.mark_seen_throttled!(interval: 15)
    # GuestSession#touch_last_seen! already has its own 60 s interval.
    current_guest_session&.touch_last_seen!
  end
end
