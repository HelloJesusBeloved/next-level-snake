# Durable player intent waiting for the leased simulation owner.
# Classic rows carry a direction only. Responsive rows also carry head_cell:
# the board index the browser already stepped into. Never a score, body, or winner.
class MatchInput < ApplicationRecord
  DIRECTIONS = Simulation::Direction::NAMES.freeze
  # Checkpoint drops acknowledged rows every 20 ticks. Responsive reports one
  # cell per tick, so the cap has to sit above that interval or a healthy
  # match rejects its own snake halfway between checkpoints.
  MAX_PENDING_PER_PARTICIPANT = 80

  belongs_to :match, inverse_of: :match_inputs
  belongs_to :match_participant, inverse_of: :match_inputs

  validates :input_seq, numericality: { only_integer: true, greater_than: 0 },
            uniqueness: { scope: :match_participant_id }
  validates :client_tick, numericality: { only_integer: true, greater_than_or_equal_to: 0 }
  validates :direction, inclusion: { in: DIRECTIONS }
  validates :head_cell, numericality: { only_integer: true, greater_than_or_equal_to: 0 }, allow_nil: true
  validates :received_at, presence: true
end
