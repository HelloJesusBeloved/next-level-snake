# One open MatchChannel socket (one tab) attached to a Brawl.
#
# Why a table instead of an in-process counter: Action Cable can run across
# several Puma workers, and a Cloudflare Tunnel can drop a socket without a
# clean callback. A row per socket lets any worker answer "does this player
# still have ANY live connection?" from the database, and lets the leased
# simulator owner reap connections whose heartbeats went stale. Closing one of
# several tabs therefore never freezes the player.
class MatchPresence < ApplicationRecord
  KINDS = %w[participant spectator].freeze

  belongs_to :match, inverse_of: :match_presences
  belongs_to :room_membership
  belongs_to :match_participant, optional: true

  validates :socket_token, presence: true, uniqueness: true
  validates :kind, inclusion: { in: KINDS }

  scope :fresh, ->(at = Time.current) { where(last_seen_at: (at - Match.presence_stale_seconds)..) }

  def fresh?(at = Time.current)
    last_seen_at.present? && last_seen_at > at - Match.presence_stale_seconds
  end

  def touch!(at = Time.current)
    update_columns(last_seen_at: at, updated_at: at)
    self
  end
end
