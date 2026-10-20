# A multiplayer room: a lobby that gathers one membership per player
# (signed-in users and guests side by side), runs matches, and is finally
# disbanded or archived — never hard-deleted in normal play, so future
# Brawl/Duel match rows and rankings keep a stable parent to point at.
#
# Lifecycle (guarded transitions below; anything else raises
# Room::InvalidTransition):
#
#     lobby ──start_match!──▶ in_match ──finish_match!──▶ finished
#       ▲                                                    │
#       └──────────────── return_to_lobby! (rematch) ────────┘
#     any unarchived state ──disband!──▶ disbanded ──archive!──▶ archived
#     finished ──archive!──▶ archived
#
# Only a room in `lobby` accepts joins. Disbanding or archiving releases
# every seated membership (state -> left) so those identities are free to
# sit in another room — see the one-active-seat partial unique indexes in
# the migration.
#
# The invitation code is the shareable "where", never the "who": it admits
# a brand-new membership for whoever presents it while the room is in the
# lobby, and it cannot resume, impersonate, or claim an existing member.
# Identity is proven separately — the account session cookie for users,
# the GuestSession token cookie for guests — and neither of those secrets
# ever appears in an invitation link. Codes are 12 characters drawn by
# SecureRandom from an alphabet with no look-alikes (0/O, 1/I/L), are
# stored and compared upper-case, and tolerate hyphens/spaces when typed.
# A host who leaks a code can rotate it with #regenerate_invitation_code!
# without disturbing anyone already seated.
#
# The host is whichever active membership has role "host" (at most one,
# enforced by a partial unique index) rather than a users row, because a
# guest must be able to host a room without creating an account, and
# because hosting can then be transferred when the host leaves.
class Room < ApplicationRecord
  MODES = %w[brawl duel].freeze
  STATES = %w[lobby in_match finished disbanded archived].freeze
  CLOSED_STATES = %w[disbanded archived].freeze
  # Why a closed room closed, so join attempts can explain themselves.
  CLOSED_REASONS = %w[host_disbanded expired].freeze

  # Default starting size; rooms EXPAND on their own as players arrive.
  MAX_MEMBERS_RANGE = (2..64).freeze
  DEFAULT_MAX_MEMBERS = 8
  DUEL_MAX_MEMBERS = 2
  MIN_PLAYERS_TO_START = 2
  NAME_MAX_LENGTH = 60

  INVITATION_CODE_LENGTH = 12
  # 31 symbols, no 0/O/1/I/L look-alikes: 31**12 ≈ 8×10^17 possibilities.
  INVITATION_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789".freeze

  class InvalidTransition < StandardError; end
  class NotJoinable < StandardError; end

  has_many :room_memberships, dependent: :delete_all, inverse_of: :room
  has_many :active_memberships,
           -> { where(state: RoomMembership::ACTIVE_STATES).order(:joined_at, :id) },
           class_name: "RoomMembership", inverse_of: :room

  validates :invitation_code, presence: true, uniqueness: true,
            format: { with: /\A[A-Z0-9]+\z/, message: "is not a valid invitation code" }
  validates :name, length: { maximum: NAME_MAX_LENGTH }, allow_blank: true
  validates :mode, inclusion: { in: MODES }
  validates :state, inclusion: { in: STATES }
  validates :max_members, numericality: { only_integer: true, in: MAX_MEMBERS_RANGE }
  validates :closed_reason, inclusion: { in: CLOSED_REASONS }, allow_nil: true
  validate :validate_duel_capacity!
  validate :validate_settings_shape!

  normalizes :invitation_code, with: ->(code) { code.to_s.strip.upcase.gsub(/[\s-]/, "") }
  normalizes :name, with: ->(name) { name.to_s.strip.presence }

  before_validation :assign_invitation_code, on: :create
  before_validation :apply_sanitized_settings

  scope :joinable, -> { where(state: "lobby") }
  scope :closed, -> { where(state: CLOSED_STATES) }
  scope :not_closed, -> { where.not(state: CLOSED_STATES) }

  # Creates the room and its host membership together, or neither. Pass
  # exactly one of `user:` / `guest_session:`; the membership validation
  # rejects anything else. For a signed-in host, `display_name` may be nil
  # and defaults to a *copy* of the username (later edits never write back
  # to the account). Guests must supply the name they typed in the lobby.
  def self.create_with_host!(user: nil, guest_session: nil, display_name: nil,
                             name: nil, mode: "brawl",
                             max_members: DEFAULT_MAX_MEMBERS, settings: {})
    if guest_session && !guest_session.usable?
      raise NotJoinable, "guest session is no longer valid"
    end

    transaction do
      room = create!(name: name, mode: mode, max_members: max_members, settings: settings)
      RoomMembership.create!(room: room, user: user, guest_session: guest_session,
                             display_name: display_name, role: "host")
      room
    end
  end

  # Case/hyphen-insensitive lookup for typed or linked codes.
  def self.find_by_invitation_code(raw)
    code = raw.to_s.strip.upcase.gsub(/[\s-]/, "")
    return nil if code.empty?

    find_by(invitation_code: code)
  end

  def self.generate_invitation_code
    Array.new(INVITATION_CODE_LENGTH) do
      INVITATION_CODE_ALPHABET[SecureRandom.random_number(INVITATION_CODE_ALPHABET.length)]
    end.join
  end

  # Rebuilds room settings from an allow-list, like
  # Score.sanitize_end_state: never trust the client. Unknown keys and
  # out-of-range values are dropped, not rejected, so a stale lobby form
  # can never break room creation. Ranges are Score's preset ranges so
  # multiplayer and single player agree on what a preset means.
  def self.sanitize_settings(raw)
    raw = raw.to_unsafe_h if raw.respond_to?(:to_unsafe_h)
    return {} unless raw.is_a?(Hash)

    raw = raw.stringify_keys
    clean = {}
    clean["speed_level"] = raw["speed_level"] if raw["speed_level"].is_a?(Integer) &&
                                                  Score::SPEED_PRESET_RANGE.cover?(raw["speed_level"])
    clean["growth"] = raw["growth"] if raw["growth"].is_a?(Integer) &&
                                       Score::GROWTH_PRESET_RANGE.cover?(raw["growth"])
    clean
  end

  # Seats a player in this room and returns their membership. Refresh-safe
  # and idempotent: a player who is already seated gets their existing
  # membership back, and one who left earlier reactivates the same row —
  # there is always at most one membership per identity per room. Raises
  # NotJoinable when the room is not in the lobby, is full, the guest
  # session is dead, or the player was removed from this room. Raises
  # ActiveRecord::RecordInvalid when the identity is already seated in a
  # *different* room (validate_one_active...; partial index backstop).
  # The room row is locked so two simultaneous joins cannot both take
  # the last seat.
  def join!(user: nil, guest_session: nil, display_name: nil)
    membership = nil
    with_lock do
      raise NotJoinable, "room is not open for joining" unless joinable?
      if guest_session && !guest_session.usable?
        raise NotJoinable, "guest session is no longer valid"
      end

      membership = membership_for(user: user, guest_session: guest_session)
      if membership&.active?
        membership.mark_seen!
        next
      end
      if membership&.state == "removed"
        raise NotJoinable, "you were removed from this room"
      end
      if full? && !expand_capacity!
        raise NotJoinable, "room is full"
      end

      membership =
        if membership
          membership.rejoin!(display_name: display_name.presence || membership.display_name)
        else
          RoomMembership.create!(room: self, user: user, guest_session: guest_session,
                                 display_name: display_name, role: "player")
        end

      # Walking into an emptied room makes you its host, so an invitation link
      # that outlives its lobby still leads somewhere usable.
      promote_host_if_vacant!(membership)
    end
    membership
  end

  # The player's membership row in this room (any state), or nil.
  def membership_for(user: nil, guest_session: nil)
    unless user.present? ^ guest_session.present?
      raise ArgumentError, "pass exactly one of user: or guest_session:"
    end

    if user
      room_memberships.find_by(user_id: user.id)
    else
      room_memberships.find_by(guest_session_id: guest_session.id)
    end
  end

  def host_membership
    room_memberships.find_by(role: "host", state: RoomMembership::ACTIVE_STATES)
  end

  def host?(membership)
    membership.present? && membership.room_id == id &&
      membership.role == "host" && membership.active?
  end

  # Hands hosting to another seated member. Demotes before promoting so
  # the one-active-host partial unique index never sees two hosts.
  def transfer_host_to!(new_host)
    with_lock do
      unless new_host.room_id == id && new_host.active?
        raise InvalidTransition, "new host must be an active member of this room"
      end

      current = host_membership
      next new_host if current&.id == new_host.id

      current&.update!(role: "player")
      new_host.update!(role: "host")
      new_host
    end
  end

  def lobby?
    state == "lobby"
  end

  def in_match?
    state == "in_match"
  end

  def finished?
    state == "finished"
  end

  def disbanded?
    state == "disbanded"
  end

  def archived?
    state == "archived"
  end

  def closed?
    CLOSED_STATES.include?(state)
  end

  def joinable?
    lobby?
  end

  def full?
    room_memberships.where(state: RoomMembership::ACTIVE_STATES).count >= max_members
  end

  def duel?
    mode == "duel"
  end

  # A full room grows (up to the configured hard ceiling) instead of turning
  # players away — the size is never something a player has to pick again.
  # Runs inside join!'s room lock, so two simultaneous joins cannot both
  # decide there is no space, and a race for the seats the expansion just
  # created still converges on the unique indexes.
  def expand_capacity!
    # A duel is exactly two snakes — it never grows.
    return false if duel?

    ceiling = [self.class.config.max_capacity, MAX_MEMBERS_RANGE.max].min
    return false if max_members >= ceiling

    update!(max_members: [max_members * 2, ceiling].min)
    true
  end

  # Lobby -> match. Every seated member plays (later steps add recorded
  # match/participant rows; selecting a subset will live there, not here).
  def start_match!
    with_lock do
      raise InvalidTransition, "only a lobby can start a match" unless lobby?

      players = room_memberships.where(state: RoomMembership::ACTIVE_STATES)
      if players.count < MIN_PLAYERS_TO_START
        raise InvalidTransition, "a match needs at least #{MIN_PLAYERS_TO_START} players"
      end

      # Bulk state flip: validations are per-row guards for API writes;
      # the DB CHECKs still constrain the result, and `playing` is inside
      # the active set, so the one-active-seat indexes are unaffected.
      players.update_all(state: "playing", updated_at: Time.current)
      update!(state: "in_match", started_at: Time.current, finished_at: nil)
    end
    self
  end

  # Match -> results. Players stay seated (state -> joined) so the room
  # can show rankings and offer a rematch without anyone re-joining.
  def finish_match!
    with_lock do
      raise InvalidTransition, "only a live match can finish" unless in_match?

      room_memberships.where(state: "playing")
                      .update_all(state: "joined", updated_at: Time.current)
      update!(state: "finished", finished_at: Time.current)
    end
    self
  end

  def return_to_lobby!
    with_lock do
      raise InvalidTransition, "only a finished room can return to the lobby" unless finished?

      update!(state: "lobby")
    end
    self
  end

  # Terminal for play: everyone is released (state -> left) so each
  # identity may immediately sit elsewhere. Idempotent once disbanded.
  # `reason` records who ended it: the host, or the inactivity sweeper.
  def disband!(reason: "host_disbanded", at: Time.current)
    return self if disbanded?
    raise InvalidTransition, "an archived room cannot be disbanded" if archived?

    with_lock do
      release_all_memberships!(at: at)
      update!(state: "disbanded", disbanded_at: at,
              closed_reason: CLOSED_REASONS.include?(reason.to_s) ? reason.to_s : "host_disbanded")
    end
    self
  end

  # Keeps the room (and future match history) for archives/rankings while
  # guaranteeing nobody is left seated in it.
  def archive!
    with_lock do
      unless finished? || disbanded?
        raise InvalidTransition, "only a finished or disbanded room can be archived"
      end

      release_all_memberships!
      update!(state: "archived", archived_at: Time.current)
    end
    self
  end

  # Rotates the shareable code (leaked link, unwanted guests). Seated
  # members are untouched — their identity never depended on the code.
  def regenerate_invitation_code!
    update!(invitation_code: fresh_invitation_code)
    self
  end

  # ---- presence, succession and expiry (step 3) ---------------------------
  #
  # This app has no job runner, so maintenance is lazy: every request that
  # reads or writes a room calls #sweep! first, and the collection endpoints
  # call .sweep_stale! for rooms nobody is visiting. Each pass is bounded and
  # idempotent, so concurrent requests cannot double-apply it.

  def self.config
    Rails.configuration.x.multiplayer
  end

  # Reconciles one room with the wall clock. Returns self.
  #   1. members silent past `member_drop` lose their seat (identity kept),
  #   2. a host silent past `host_grace` hands the crown to the next member,
  #   3. an empty room untouched for `room_idle` expires.
  def sweep!(at: Time.current)
    return self if closed?

    with_lock do
      drop_silent_members!(at: at)
      transfer_host_after_grace!(at: at)
      expire_if_idle!(at: at)
    end
    self
  end

  # Lazy global pass for rooms nobody is polling. Bounded by `sweep_batch`
  # and ordered oldest-first so every room is eventually visited.
  def self.sweep_stale!(at: Time.current, limit: config.sweep_batch)
    cutoff = at - [config.member_drop, config.host_grace, config.room_idle].min
    not_closed.where(updated_at: ..cutoff).order(:updated_at).limit(limit).each do |room|
      room.sweep!(at: at)
    rescue ActiveRecord::RecordInvalid, InvalidTransition
      next # never let one wedged room break an unrelated request
    end
  end

  # Newest sign of life: a state change, or anything a member did.
  def last_activity_at
    [updated_at, room_memberships.maximum(:updated_at)].compact.max
  end

  def members_online(at: Time.current)
    active_memberships.select { |member| member.online?(at: at) }
  end

  # Who could actually play right now. Ready votes are deliberately NOT part
  # of this: the host decides, readiness is advisory (step 3 requirement 6).
  def eligible_players(at: Time.current)
    members_online(at: at)
  end

  # Everything the host's Start control needs, as data. Note `engine_ready`
  # is false until the Brawl engine lands: eligibility is answerable now,
  # starting a match is not.
  def start_eligibility(at: Time.current)
    blockers = []
    blockers << "room_closed" if closed?
    blockers << "match_in_progress" if in_match?
    blockers << "room_not_in_lobby" unless lobby? || closed? || in_match?
    players = eligible_players(at: at)
    blockers << "needs_#{MIN_PLAYERS_TO_START}_players" if players.size < MIN_PLAYERS_TO_START

    {
      eligible: blockers.empty?,
      blockers: blockers,
      engine_ready: false,
      players: players.size,
      minimum_players: MIN_PLAYERS_TO_START
    }
  end

  def closed_reason_message
    case closed_reason
    when "expired" then "That room expired after everyone left."
    else "That room was disbanded by its host."
    end
  end

  private

  # Keeps exactly one crown in a room that has any seated members.
  def promote_host_if_vacant!(preferred = nil)
    return if host_membership

    successor = preferred&.reload&.active? ? preferred : room_memberships.active.seated_first.first
    transfer_host_to!(successor) if successor
  end

  # Silent for longer than `member_drop`: release the seat so the roster and
  # the "everyone left" check stay honest. The membership row survives, so
  # the same person (guest session or account) can rejoin it later.
  def drop_silent_members!(at: Time.current)
    cutoff = at - self.class.config.member_drop
    stale = room_memberships.active.select { |member| member.seen_at < cutoff }
    return if stale.empty?

    room_memberships.where(id: stale.map(&:id))
                    .update_all(state: "left", left_at: at, updated_at: at)
  end

  # Predictable succession: the longest-seated member who is still online,
  # or failing that the longest-seated member at all. Never a silent host.
  def transfer_host_after_grace!(at: Time.current)
    current = host_membership
    candidates = room_memberships.active.seated_first.to_a

    if current.nil?
      successor = candidates.find { |m| m.online?(at: at) } || candidates.first
      return transfer_host_to!(successor) if successor

      return
    end

    return if current.seen_at > at - self.class.config.host_grace

    successor = candidates.find { |m| m.id != current.id && m.online?(at: at) }
    transfer_host_to!(successor) if successor
  end

  # "If everyone leaves, expire the unused room after a configurable
  # inactivity period." Only ever fires on a room with nobody seated.
  def expire_if_idle!(at: Time.current)
    return if closed?
    return if room_memberships.active.exists?

    idle_since = last_activity_at || created_at
    return if idle_since > at - self.class.config.room_idle

    disband!(reason: "expired", at: at)
  end

  def release_all_memberships!(at: Time.current)
    room_memberships.where(state: RoomMembership::ACTIVE_STATES)
                    .update_all(state: "left", left_at: at, updated_at: at)
  end

  def fresh_invitation_code
    loop do
      code = self.class.generate_invitation_code
      break code unless self.class.exists?(invitation_code: code)
    end
  end

  def assign_invitation_code
    self.invitation_code = fresh_invitation_code if invitation_code.blank?
  end

  def apply_sanitized_settings
    self.settings = self.class.sanitize_settings(settings)
  end

  def validate_duel_capacity!
    return unless duel?
    return if max_members == DUEL_MAX_MEMBERS

    errors.add(:max_members, "must be #{DUEL_MAX_MEMBERS} for a duel")
  end

  def validate_settings_shape!
    errors.add(:settings, "must be an object") unless settings.is_a?(Hash)
  end
end
