# A single multiplayer match. The rules live in Simulation::World (pure Ruby);
# this record is the durable shell: configuration frozen at start, ownership
# lease, periodic checkpoints and final standings.
#
# Ownership: exactly one process may simulate a match at a time. #claim_lease!
# is a conditional UPDATE (expired / unowned / own token) and every subsequent
# write is fenced on owner_token, so a stale owner cannot checkpoint or publish
# results after another process took over.
class Match < ApplicationRecord
  STATUSES = %w[pending running paused completed abandoned].freeze
  LIVE_STATUSES = %w[pending running paused].freeze
  MODES = %w[brawl duel].freeze
  DEFAULT_DURATION_SECONDS = 180
  TICK_PRESET_MS = Simulation::Config::SPEED_PRESETS

  belongs_to :room, inverse_of: :matches
  belongs_to :winner_membership, class_name: "RoomMembership", optional: true
  has_many :match_participants, dependent: :delete_all, inverse_of: :match

  validates :mode, inclusion: { in: MODES }
  validates :status, inclusion: { in: STATUSES }
  validates :columns, numericality: { only_integer: true, in: Simulation::Config::MIN_COLUMNS..Simulation::Config::MAX_COLUMNS }
  validates :rows, numericality: { only_integer: true, in: Simulation::Config::MIN_ROWS..Simulation::Config::MAX_ROWS }
  validates :tick_ms, numericality: { only_integer: true, in: Simulation::Config::MIN_TICK_MS..Simulation::Config::MAX_TICK_MS }
  validates :growth, numericality: { only_integer: true, in: Simulation::Config::MIN_GROWTH..Simulation::Config::MAX_GROWTH }
  validates :seed, :tick, :checkpoint_tick, presence: true
  validates :max_ticks, numericality: {
    only_integer: true,
    in: Simulation::Config::MIN_MAX_TICKS..Simulation::Config::MAX_MAX_TICKS
  }

  scope :live, -> { where(status: LIVE_STATUSES) }
  scope :claimable, lambda { |now = Time.current|
    live.where("owner_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at < ?", now)
  }

  # Creates the durable match (and frozen participants) for a room whose
  # configuration was locked by Room#start_match!. Called inside the room lock.
  def self.open_for_room!(room, now: Time.current)
    frozen = room.match_configuration
    raise ArgumentError, "room has no frozen match configuration" unless frozen.is_a?(Hash)

    speed_level = integer_setting(room.settings["speed_level"], 1..6, Simulation::Config::DEFAULT_SPEED_LEVEL)
    growth = integer_setting(room.settings["growth"], 0..100, Simulation::Config::DEFAULT_GROWTH)
    tick_ms = TICK_PRESET_MS.fetch(speed_level)
    participants = Array(frozen["participants"]).filter_map do |entry|
      membership = room.room_memberships.find_by(id: entry["membership_id"])
      next unless membership

      { membership: membership, display_name: membership.display_name,
        color_slot: entry["color_slot"].to_i, color_hex: entry["color"].to_s }
    end
    raise ArgumentError, "room has no participants" if participants.empty?

    transaction do
      match = create!(
        room: room, mode: room.mode, status: "pending",
        columns: frozen["columns"], rows: frozen["rows"],
        tick_ms: tick_ms, speed_level: speed_level, growth: growth,
        seed: SecureRandom.random_number(2**63),
        max_ticks: derive_max_ticks(tick_ms), checkpoint: {}, checkpoint_tick: 0,
        tick: 0, started_at: nil
      )
      participants.each do |entry|
        match.match_participants.create!(
          room_membership: entry[:membership], display_name: entry[:display_name],
          color_slot: entry[:color_slot], color_hex: entry[:color_hex]
        )
      end
      match
    end
  end

  def self.integer_setting(value, range, fallback)
    integer = value.is_a?(Integer) ? value : Integer(value)
    range.cover?(integer) ? integer : fallback
  rescue ArgumentError, TypeError
    fallback
  end

  def self.derive_max_ticks(tick_ms)
    [(DEFAULT_DURATION_SECONDS * 1_000.0 / tick_ms).round, Simulation::Config::MIN_MAX_TICKS].max
  end

  def simulation_config
    Simulation::Config.new(
      columns: columns, rows: rows, speed_level: speed_level,
      tick_ms: speed_level ? nil : tick_ms, growth: growth, mode: mode.to_sym,
      seed: seed, max_ticks: max_ticks
    )
  end

  def simulation_participants
    match_participants.order(:id).map(&:engine_identity)
  end

  # Rebuilds the in-memory world. A checkpoint (written every N ticks) is the
  # only recovery source after a lease hand-over; participants are re-read from
  # the database so names/colors cannot be altered through a checkpoint.
  def build_world
    config = simulation_config
    participants = simulation_participants
    if checkpoint.present? && Array(checkpoint["snakes"]).any?
      Simulation::World.restore(id: id, config: config, participants: participants, state: checkpoint)
    else
      Simulation::World.new(id: id, config: config, participants: participants)
    end
  end

  # ---- ownership lease -----------------------------------------------------

  def claim_lease!(token:, ttl_seconds:, now: Time.current)
    return false unless LIVE_STATUSES.include?(status)

    self.class.where(id: id)
        .where("owner_token IS NULL OR owner_token = :token OR lease_expires_at IS NULL OR lease_expires_at < :now",
               token: token, now: now)
        .update_all(owner_token: token, lease_expires_at: now + ttl_seconds, updated_at: now) == 1
  end

  def renew_lease!(token:, ttl_seconds:, now: Time.current)
    self.class.where(id: id, owner_token: token)
        .where(status: LIVE_STATUSES)
        .update_all(lease_expires_at: now + ttl_seconds, updated_at: now) == 1
  end

  def release_lease!(token:, now: Time.current)
    self.class.where(id: id, owner_token: token)
        .update_all(owner_token: nil, lease_expires_at: nil, updated_at: now) == 1
  end

  def owns_lease?(token)
    owner_token == token
  end

  # Periodic durable progress. Fenced: a process that lost its lease cannot
  # overwrite a newer checkpoint.
  def save_progress!(world, token:, now: Time.current)
    attrs = { status: world.status.to_s, tick: world.tick, checkpoint: world.to_state,
              checkpoint_tick: world.tick, updated_at: now }
    attrs[:started_at] = now if started_at.nil? && !world.pending?
    updated = self.class.where(id: id, owner_token: token).update_all(attrs) == 1
    reload if updated
    updated
  end

  def complete_from_world!(world, token:, now: Time.current)
    entries = world.standings
    committed = false
    transaction do
      updated = self.class.where(id: id, owner_token: token).update_all(
        status: "completed", tick: world.tick, checkpoint: world.to_state,
        checkpoint_tick: world.tick, ended_at: now,
        end_reason: world.end_reason.to_s, winner_membership_id: membership_id_for(entries.first&.id),
        owner_token: nil, lease_expires_at: nil, updated_at: now
      ) == 1
      raise ActiveRecord::Rollback unless updated

      persist_standings!(entries, now)
      committed = true
    end
    reload
    committed ? entries : false
  end

  # Ends a match without a simulated result (room finished, owner lost, etc.).
  # Any checkpoint is still ranked, so surviving points are never discarded.
  def abandon!(reason:, now: Time.current)
    return self if completed? || abandoned?

    entries =
      begin
        build_world.standings
      rescue StandardError
        []
      end
    transaction do
      update!(status: "abandoned", ended_at: now, end_reason: reason.to_s,
              tick: [tick, checkpoint_tick].max, owner_token: nil, lease_expires_at: nil)
      persist_standings!(entries, now) if entries.any?
    end
    self
  end

  def completed?
    status == "completed"
  end

  def abandoned?
    status == "abandoned"
  end

  def live?
    LIVE_STATUSES.include?(status)
  end

  def standings
    match_participants.order(Arel.sql("placement ASC NULLS LAST"), :id)
  end

  private

  def membership_id_for(participant_id)
    return nil unless participant_id

    match_participants.find_by(id: participant_id)&.room_membership_id
  end

  def persist_standings!(entries, now)
    entries.each do |entry|
      match_participants.where(id: entry.id).update_all(
        status: entry.alive ? "alive" : "eliminated",
        final_score: entry.score, longest_length: entry.longest_length,
        survived_ticks: entry.survived_ticks, eliminated_at_tick: entry.eliminated_at_tick,
        placement: entry.placement, updated_at: now
      )
    end
  end
end
