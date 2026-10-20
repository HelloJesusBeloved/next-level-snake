# A guest's session identity: proof that "the browser that joined as Ada"
# is still that same browser after a refresh — with no account, no email,
# and nothing derived from the chosen display name.
#
# How it works (the cookie is set by the join endpoints in a later step;
# this model is the credential those endpoints will use):
#
#   session, raw_token = GuestSession.issue   # raw token shown exactly once
#   # -> stored by the browser as an httpOnly, SameSite=Lax cookie (Secure
#   #    in production), expiring with `expires_at`. JavaScript cannot read
#   #    it, and it is NEVER placed in a URL — invitation links carry only
#   #    the room's invitation code, which admits a *new* player and can
#   #    never resume somebody else's seat.
#   GuestSession.authenticate(raw_token)      # -> session or nil
#
# Only the SHA-256 digest of the 256-bit random token is stored. A fast
# hash is correct here (unlike for passwords) because the token itself has
# full cryptographic entropy — there is no dictionary to attack — and this
# matches how Rails digests other high-entropy bearer tokens. A leaked
# database therefore contains nothing that can be replayed as a guest.
#
# `public_id` is a separate random handle that is safe to expose in JSON
# and logs when a later step needs to refer to a guest before sign-in.
#
# Claiming: after signing in, a guest may attach their *current* (active)
# room membership to the account — see RoomMembership#claim_by!. Claiming
# stamps `claimed_by_user`/`claimed_at` and revokes the token in the same
# transaction, so the old cookie dies immediately and can never be used to
# claim the same (or anyone else's) history a second time. Past, already
# left memberships are deliberately not claimable.
class GuestSession < ApplicationRecord
  TOKEN_BYTES = 32        # 256 bits of entropy in the raw token
  PUBLIC_ID_BYTES = 16    # 128-bit non-secret handle

  # 30 days, matching the signed cookie session in config/application.rb.
  # Plain seconds for the same reason given there.
  DEFAULT_LIFETIME_SECONDS = 30 * 24 * 60 * 60

  # Raised when a dead (expired/revoked/claimed) session is asked to do
  # something only a live credential may do, such as rotating its token.
  class InvalidSession < StandardError; end

  has_many :room_memberships, dependent: :delete_all, inverse_of: :guest_session
  belongs_to :claimed_by_user, class_name: "User", optional: true,
             inverse_of: :claimed_guest_sessions

  validates :public_id, presence: true, uniqueness: true
  validates :token_digest, presence: true, uniqueness: true
  validates :expires_at, presence: true
  validate :validate_claimed_pair!

  scope :expired, ->(at = Time.current) { where(expires_at: ..at) }
  scope :revoked, -> { where.not(revoked_at: nil) }

  # Creates a new guest identity and returns [session, raw_token]. The raw
  # token exists only in this return value (and then in the browser's
  # cookie) — it is never persisted, logged, or recoverable later.
  def self.issue(at: Time.current, lifetime_seconds: DEFAULT_LIFETIME_SECONDS)
    raw_token = generate_raw_token
    session = create!(
      public_id: SecureRandom.urlsafe_base64(PUBLIC_ID_BYTES),
      token_digest: digest(raw_token),
      expires_at: at + lifetime_seconds,
      last_seen_at: at
    )
    [session, raw_token]
  end

  # Resolves a cookie's raw token to its session, or nil. Unknown, expired,
  # revoked and already-claimed tokens all return nil — callers cannot
  # distinguish them, and a display name or invitation code (which are not
  # secrets of this strength) can never be used in place of the token.
  def self.authenticate(raw_token, at: Time.current)
    return nil if raw_token.blank?

    candidate = digest(raw_token.to_s)
    session = find_by(token_digest: candidate)
    return nil unless session
    return nil unless session.token_digest.bytesize == candidate.bytesize &&
                        ActiveSupport::SecurityUtils.secure_compare(session.token_digest, candidate)

    session.usable?(at: at) ? session : nil
  end

  def self.digest(raw_token)
    Digest::SHA256.hexdigest(raw_token.to_s)
  end

  def self.generate_raw_token
    SecureRandom.urlsafe_base64(TOKEN_BYTES)
  end

  def usable?(at: Time.current)
    revoked_at.nil? && claimed_at.nil? && expires_at.present? && expires_at > at
  end

  def expired?(at: Time.current)
    expires_at.blank? || expires_at <= at
  end

  def revoked?
    revoked_at.present?
  end

  def claimed?
    claimed_at.present?
  end

  # Issues a replacement token (e.g. after sign-in, or on a suspected leak)
  # and returns the new raw value. The previous token stops working the
  # moment this saves. Also slides the expiry forward.
  def rotate_token!(at: Time.current, lifetime_seconds: DEFAULT_LIFETIME_SECONDS)
    raise InvalidSession, "guest session is no longer usable" unless usable?(at: at)

    raw_token = self.class.generate_raw_token
    update!(token_digest: self.class.digest(raw_token),
            expires_at: at + lifetime_seconds, last_seen_at: at)
    raw_token
  end

  # Kills the credential (sign-out, "forget this browser"). Seats are left
  # for the room lifecycle/presence timeouts of later steps to reclaim.
  def revoke!(at: Time.current)
    update!(revoked_at: at) unless revoked?
    self
  end

  # Heartbeat for presence ("last seen") without a write per request.
  def touch_last_seen!(at: Time.current, min_interval: 60)
    return self if last_seen_at && (at - last_seen_at) < min_interval

    update_column(:last_seen_at, at)
    self
  end

  # At most one, guaranteed by the partial unique index on active states.
  def active_membership
    room_memberships.active.first
  end

  # Attaches this guest's current membership to a signed-in account.
  # Only the holder of this session's raw token can ever reach this call
  # (via .authenticate), which is what makes the claim safe: knowing a
  # display name, a public_id, or an invitation code is not enough.
  def claim_by!(user)
    membership = active_membership
    raise RoomMembership::ClaimError, "guest has no current room membership to claim" unless membership

    membership.claim_by!(user)
    reload
    self
  end

  # One-way stamp written by RoomMembership#claim_by! in the same
  # transaction that moves the membership. Revoking here is what retires
  # the guest cookie: after claiming, the account session is the identity.
  def mark_claimed_by!(user, at: Time.current)
    update!(claimed_by_user: user, claimed_at: at, revoked_at: at)
  end

  # The digest is a credential verifier and must never be serialised, even
  # by accident (admin JSON, debug dumps). `public_id` exists for that.
  def serializable_hash(options = nil)
    options = (options || {}).dup
    options[:except] = Array(options[:except]).map(&:to_s) | ["token_digest"]
    super(options)
  end

  private

  # Mirror of the guest_sessions_claimed_pair_check constraint, so callers
  # get a friendly validation error instead of a database exception.
  def validate_claimed_pair!
    return if claimed_by_user_id.present? == claimed_at.present?

    errors.add(:claimed_at, "and claimed_by_user must be set together")
  end
end
