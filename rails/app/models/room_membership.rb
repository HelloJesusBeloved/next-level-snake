# One player's seat in one room — the row future match, result and ranking
# tables will reference when they need to say "this snake, in this room".
#
# Identity: exactly one principal owns the seat, a signed-in User XOR a
# GuestSession (model validation + `room_memberships_identity_check`).
# Guests therefore play with no account at all, and their seat is bound to
# their unguessable session token — not to the display name they typed,
# which anyone could also type. For signed-in players `display_name` is a
# room-local copy (seeded from the username on join): renaming yourself
# for one room never changes your permanent account name, and two players
# from different rooms may share a name while two seated in the same room
# may not (case-insensitive, freed on leave — see the partial index).
#
# Lifecycle:
#
#     joined ⇄ ready ──room starts──▶ playing ──room finishes──▶ joined
#     joined / ready / playing ──leave!──▶ left ──rejoin!──▶ joined
#     joined / ready / playing ──remove!─▶ removed  (terminal for this room)
#
# `joined`, `ready` and `playing` are the ACTIVE states. A partial unique
# index allows each identity at most one active seat across *all* rooms,
# so a single membership/account/browser can never be playing in several
# simultaneous matches; leaving (or the room disbanding) frees the seat at
# once. The row itself survives leaving so history stays attached, and
# rejoining reactivates the same row instead of forking a second one.
#
# Claiming (guest -> account): #claim_by! moves this seat from its guest
# session to a signed-in user, preserving display name, role and state.
# It is only reachable with the guest's verified raw token in hand (the
# caller authenticates the cookie via GuestSession.authenticate first),
# refuses to merge two live seats, and revokes the guest token in the
# same transaction — so nobody can claim another player's history with a
# display name, an invitation code, or a recycled cookie.
class RoomMembership < ApplicationRecord
  ROLES = %w[host player].freeze
  STATES = %w[joined ready playing left removed].freeze
  ACTIVE_STATES = %w[joined ready playing].freeze
  INACTIVE_STATES = %w[left removed].freeze

  # Same bounds as account usernames (User::USERNAME_*): familiar to type,
  # short enough for a lobby roster.
  DISPLAY_NAME_MIN_LENGTH = 2
  DISPLAY_NAME_MAX_LENGTH = 30

  class InvalidTransition < StandardError; end
  class ClaimError < StandardError; end

  belongs_to :room, inverse_of: :room_memberships
  belongs_to :user, optional: true, inverse_of: :room_memberships
  belongs_to :guest_session, optional: true, inverse_of: :room_memberships

  validates :display_name, presence: true,
            length: { minimum: DISPLAY_NAME_MIN_LENGTH, maximum: DISPLAY_NAME_MAX_LENGTH }
  validates :role, inclusion: { in: ROLES }
  validates :state, inclusion: { in: STATES }
  validates :joined_at, presence: true
  validates :color_slot, inclusion: { in: 0...RoomPalette::CAPACITY }
  validate :validate_color_reservation!
  validate :validate_display_name_chars!
  validate :validate_exactly_one_identity!
  validate :validate_one_active_membership_per_identity!
  validate :validate_display_name_unique_in_room!
  validate :validate_active_membership_room_open!
  validate :validate_left_at_consistency!

  normalizes :display_name, with: ->(name) { name.to_s.strip }

  before_validation :reserve_initial_color!
  before_save :reserve_initial_color! # also covers internal save(validate: false)
  before_validation :assign_joined_at, on: :create
  before_validation :default_display_name_from_account, on: :create

  scope :active, -> { where(state: ACTIVE_STATES) }
  scope :playing, -> { where(state: "playing") }
  scope :seated_first, -> { order(:joined_at, :id) }

  def active?
    ACTIVE_STATES.include?(state)
  end

  def ready?
    state == "ready"
  end

  # Last sign of life. A brand-new member has not polled yet, so fall back to
  # the moment they sat down instead of treating them as instantly offline.
  def seen_at
    last_seen_at || joined_at || created_at || Time.current
  end

  # Presence is derived from the heartbeat the page sends while polling, so
  # a closed tab fades out on its own without any socket (step 3 is HTTP).
  def online?(at: Time.current)
    seen_at > at - Rails.configuration.x.multiplayer.presence_timeout
  end

  def offline_for?(seconds, at: Time.current)
    seen_at <= at - seconds
  end

  # Same persisted solid color is the contract for later snake/food modes.
  def identity_color
    RoomPalette.color(color_slot)
  end

  def device_kind(at: Time.current)
    RoomBoard.device_kind(device_reports, at: at)
  end

  def guest?
    guest_session_id.present?
  end

  def registered?
    user_id.present?
  end

  # True only while seated: a former host who left keeps role "host" on
  # the historical row, but no longer hosts anything.
  def host?
    role == "host" && active?
  end

  # Readiness votes go through the room lock so their ordering (and their
  # broadcast) can never race a sweep or a host transfer. Every other tab and
  # player sees the same ready count.
  def mark_ready!
    raise InvalidTransition, "only a joined member can ready up" unless state == "joined"

    room.with_lock do
      reload
      raise InvalidTransition, "Spectators cannot ready up during a match." if spectator? || room.in_match?
      update!(state: "ready")
    end
    room.notify_events!([[:member_ready, { member: id, ready: true }]])
    self
  end

  def mark_not_ready!
    raise InvalidTransition, "only a ready member can un-ready" unless state == "ready"

    room.with_lock do
      reload
      raise InvalidTransition, "Readiness is locked during a match." if room.in_match?
      update!(state: "joined")
    end
    room.notify_events!([[:member_ready, { member: id, ready: false }]])
    self
  end

  # Presence heartbeat; deliberately skips validations/callbacks (and the
  # updated_at touch) so a future poller/socket can call it cheaply.
  def mark_seen!(at: Time.current)
    update_column(:last_seen_at, at) if persisted?
    self
  end

  def leave!
    depart!("left")
  end

  # Host-initiated kick. Authorisation ("may this caller kick?") belongs
  # to the future controller; this only performs the guarded transition.
  # Removed members cannot rejoin the same room (Room#join! enforces it).
  def remove!
    depart!("removed")
  end

  # Reactivates a seat kept from an earlier visit to the same room. A
  # returning former host comes back as a player: if anyone else was
  # seated they already inherited hosting when the host left.
  def rejoin!(display_name: self.display_name)
    return self if active?
    raise InvalidTransition, "removed members cannot rejoin this room" if state == "removed"

    update!(state: "joined", display_name: display_name, role: "player",
            spectator: room.in_match?, device_reports: {},
            joined_at: Time.current, left_at: nil, last_seen_at: Time.current)
    self
  end

  # Attaches this guest seat to a signed-in account. See the class comment
  # for why this cannot be used to seize somebody else's seat or history.
  # Raises ClaimError (leaving everything untouched) when: the seat is not
  # a current guest seat, the guest session is expired/revoked/claimed,
  # or the account already holds a live seat anywhere — merging two
  # simultaneously seated players into one account is never allowed.
  def claim_by!(user)
    raise ClaimError, "sign in before claiming a guest membership" if user.nil?
    raise ClaimError, "only a guest membership can be claimed" unless guest?
    raise ClaimError, "only a current (active) membership can be claimed" unless active?

    session = guest_session
    unless session&.usable?
      raise ClaimError, "guest session is no longer valid; it cannot be claimed"
    end

    transaction do
      if self.class.active.exists?(user_id: user.id)
        raise ClaimError, "account already has an active membership; leave that room first"
      end

      # The unique (room, user) index spans left seats too. If this same
      # person earlier sat in this room while signed in and then left,
      # that stale inactive row would block the claim. Nothing references
      # membership rows yet (match results arrive in later steps, which
      # must revisit this before attaching history), so the stale row is
      # removed and the live guest seat — name, role, joined_at — wins.
      self.class.where(room_id: room_id, user_id: user.id)
          .where(state: INACTIVE_STATES).delete_all

      update!(user: user, guest_session: nil)
      session.mark_claimed_by!(user)
    end
    self
  end

  private

  # Shared leave/remove path. Locks the room so host succession is atomic: if
  # the host departs, the longest-seated remaining member inherits at once.
  #
  # An emptied room is deliberately NOT disbanded here. The invitation link
  # has to keep working for a moment — people leave and come back, and a whole
  # lobby can reload at once — so the room simply sits there host-less until
  # somebody rejoins (Room#join! hands them the crown) or the inactivity
  # sweeper expires it (Room#sweep!, step 3 requirement 11).
  def depart!(to_state)
    return self unless active?

    events = [[:member_left, { member: id, name: display_name }]]
    room.with_lock do
      was_host = role == "host"
      update!(state: to_state, left_at: Time.current)
      next unless was_host

      successor = room.room_memberships.active.seated_first.first
      if successor
        room.transfer_host_to!(successor, emit: false)
        events << [:host_changed, { host: successor.id }]
      end
    end
    # Leaving and the crown moving are one committed change -> one version,
    # broadcast after the lock so a refetching subscriber sees both.
    room.notify_events!(events)
    self
  end

  # Save validations already run in a transaction; the room lock therefore
  # stays held through INSERT/UPDATE (including direct model creation). Public
  # joins also hold that same lock. A partial unique index is the DB backstop.
  def reserve_initial_color!
    return unless room&.persisted? && active?
    reactivating = persisted? && state_in_database.in?(INACTIVE_STATES)
    return unless color_slot.nil? || @automatic_color || reactivating

    room.with_lock do
      self.color_slot = room.available_color_for!(self)
      @automatic_color = true
    end
  end

  def validate_color_reservation!
    return unless active? && color_slot.present? && room
    if self.class.active.where(room_id: room_id, color_slot: color_slot).where.not(id: id).exists?
      errors.add(:color_slot, "is already claimed in this room")
    end
  end

  def assign_joined_at
    self.joined_at ||= Time.current
  end

  # Signed-in players may omit a name and play under a copy of their
  # username; guests must type one (presence validation enforces it).
  def default_display_name_from_account
    self.display_name = user.username if display_name.blank? && user
  end

  # Same forbidden characters as account usernames (see User): display
  # names end up in the same DOM/log places usernames do.
  def validate_display_name_chars!
    return if display_name.blank?
    if display_name.match?(/[\/\\<>`]/) || display_name.match?(/[\u0000-\u001f\u007f]/)
      errors.add(:display_name, "contains invalid characters")
    end
  end

  def validate_exactly_one_identity!
    return if user_id.present? ^ guest_session_id.present?

    errors.add(:base, "membership must belong to exactly one of a user or a guest session")
  end

  # Friendly mirror of the one-active-seat partial unique indexes. The
  # indexes remain the real guard under races (RecordNotUnique), this
  # turns the ordinary "already in another room" case into a form error.
  # `where.not(id: id)` with a nil id (new record) degrades to matching
  # every persisted row, which is exactly the exclusion we want.
  def validate_one_active_membership_per_identity!
    return unless active?

    others = self.class.active.where.not(id: id)
    conflict =
      if user_id.present?
        others.exists?(user_id: user_id)
      elsif guest_session_id.present?
        others.exists?(guest_session_id: guest_session_id)
      else
        false
      end
    return unless conflict

    errors.add(:base, "already has an active membership in a room; leave it before joining another")
  end

  def validate_display_name_unique_in_room!
    return if display_name.blank? || !active?

    taken = self.class.active.where(room_id: room_id).where.not(id: id)
                .where("LOWER(display_name) = ?", display_name.downcase).exists?
    errors.add(:display_name, "is already taken in this room") if taken
  end

  # Nobody may (re)activate a seat inside a disbanded/archived room.
  # Disband/archive release seats via update_all, so they never trip this.
  def validate_active_membership_room_open!
    return unless active?
    return if room.nil?

    errors.add(:room, "is closed") if Room::CLOSED_STATES.include?(room.state)
  end

  # Mirror of room_memberships_left_at_check.
  def validate_left_at_consistency!
    if active? && left_at.present?
      errors.add(:left_at, "must be blank while the member is active")
    elsif !active? && left_at.blank?
      errors.add(:left_at, "must be set when the member has left")
    end
  end
end
