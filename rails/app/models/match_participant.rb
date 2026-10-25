# A frozen participant of one match. Identity metadata (name, color) is copied
# at match creation so results survive an account/guest cleanup, while
# room_membership_id links back to the live seat when it still exists.
class MatchParticipant < ApplicationRecord
  STATUSES = %w[alive eliminated left].freeze
  # Step 10: the server's classification of the player's active connection.
  #   connected     -> at least one fresh MatchChannel socket (or newly seated)
  #   disconnected  -> no fresh socket; the grace window is running, snake frozen
  #   unattended    -> no fresh socket and no grace left; snake keeps moving
  CONNECTION_STATES = %w[connected disconnected unattended].freeze

  belongs_to :match, inverse_of: :match_participants
  belongs_to :room_membership, optional: true
  has_many :match_inputs, dependent: :delete_all, inverse_of: :match_participant

  validates :display_name, presence: true
  validates :color_hex, format: { with: /\A#[0-9A-F]{6}\z/i }
  validates :color_slot, numericality: { only_integer: true, in: 0...96 }
  validates :status, inclusion: { in: STATUSES }
  validates :final_score, :longest_length, :survived_ticks,
            numericality: { only_integer: true, greater_than_or_equal_to: 0 }
  validates :room_membership_id, uniqueness: { scope: :match_id }, allow_nil: true
  validates :last_input_seq, numericality: { only_integer: true, greater_than_or_equal_to: 0 }
  validates :connection_state, inclusion: { in: CONNECTION_STATES }
  validates :freeze_windows_used, :freeze_ticks,
            numericality: { only_integer: true, greater_than_or_equal_to: 0 }

  scope :connected_now, -> { where(connection_state: "connected") }
  scope :frozen_now, -> { where(connection_state: "disconnected") }

  def connected?
    connection_state == "connected"
  end

  def frozen?
    connection_state == "disconnected" && freeze_deadline_at.present?
  end

  def unattended?
    connection_state == "unattended"
  end

  # Spectators are dead/left participants and members who never held a frozen
  # seat. They reconnect to watch, never to steer.
  def spectator?
    status != "alive"
  end

  def engine_identity
    { id: id, name: display_name, color_hex: color_hex, color_slot: color_slot }
  end

  # Compact, non-identity connection block for the room HTTP payload (the
  # authoritative snapshot carries the live values at 10 Hz).
  def connection_payload
    {
      state: connection_state,
      frozen: frozen?,
      frozen_at: frozen_at&.iso8601(6),
      grace_deadline_at: freeze_deadline_at&.iso8601(6),
      freezes_used: freeze_windows_used,
      last_seen_at: last_seen_at&.iso8601(6)
    }
  end
end
