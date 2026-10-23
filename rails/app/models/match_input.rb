# Durable player intent waiting for the leased simulation owner. This model
# carries a direction only — never a cell, score, body, or winner.
class MatchInput < ApplicationRecord
  DIRECTIONS = Simulation::Direction::NAMES.freeze
  MAX_PENDING_PER_PARTICIPANT = 16

  belongs_to :match, inverse_of: :match_inputs
  belongs_to :match_participant, inverse_of: :match_inputs

  validates :input_seq, numericality: { only_integer: true, greater_than: 0 },
            uniqueness: { scope: :match_participant_id }
  validates :client_tick, numericality: { only_integer: true, greater_than_or_equal_to: 0 }
  validates :direction, inclusion: { in: DIRECTIONS }
  validates :received_at, presence: true
end
