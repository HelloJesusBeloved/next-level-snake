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

  MAX_MEMBERS_RANGE = (2..16).freeze
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
      raise NotJoinable, "room is full" if full?

      membership =
        if membership
          membership.rejoin!(display_name: display_name.presence || membership.display_name)
        else
          RoomMembership.create!(room: self, user: user, guest_session: guest_session,
                                 display_name: display_name, role: "player")
        end
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
  def disband!
    return self if disbanded?
    raise InvalidTransition, "an archived room cannot be disbanded" if archived?

    with_lock do
      release_all_memberships!
      update!(state: "disbanded", disbanded_at: Time.current)
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

  private

  def release_all_memberships!
    now = Time.current
    room_memberships.where(state: RoomMembership::ACTIVE_STATES)
                    .update_all(state: "left", left_at: now, updated_at: now)
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
