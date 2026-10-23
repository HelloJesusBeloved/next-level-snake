# A frozen participant of one match. Identity metadata (name, color) is copied
# at match creation so results survive an account/guest cleanup, while
# room_membership_id links back to the live seat when it still exists.
class MatchParticipant < ApplicationRecord
  STATUSES = %w[alive eliminated left].freeze

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

  def engine_identity
    { id: id, name: display_name, color_hex: color_hex, color_slot: color_slot }
  end
end
