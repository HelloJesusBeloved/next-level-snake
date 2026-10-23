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
  has_many :match_inputs, dependent: :delete_all, inverse_of: :match

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
    frozen_participants = Array(frozen["participants"])
    raise ArgumentError, "room has no participants" if frozen_participants.empty?

    # One query instead of one per player (up to 64) while the room row lock is
    # held. A frozen participant whose membership vanished is a hard error: a
    # silently smaller roster would start a different match than the one the
    # host and players agreed to.
    ids = frozen_participants.map { |entry| entry["membership_id"] }.compact
    memberships = room.room_memberships.where(id: ids).index_by(&:id)
    participants = frozen_participants.map do |entry|
      membership = memberships[entry["membership_id"]]
      raise ArgumentError, "frozen participant #{entry["membership_id"]} is no longer seated" unless membership

      { membership: membership, display_name: membership.display_name,
        color_slot: entry["color_slot"].to_i, color_hex: entry["color"].to_s }
    end

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

  MAX_PENDING_INPUTS_PER_PARTICIPANT = MatchInput::MAX_PENDING_PER_PARTICIPANT
  # A client may aim at a bounded future checkpoint window; the owner validates
  # against its exact in-memory tick when it consumes the queued command.
  INPUT_FUTURE_WINDOW = MatchRunner::CHECKPOINT_EVERY_TICKS + Simulation::Config::MAX_CATCHUP_TICKS + 1

  def client_summary(participant_id: nil)
    { id: id, mode: mode, status: status, tick: tick, tick_ms: tick_ms,
      columns: columns, rows: rows, protocol_version: Simulation::Protocol::SNAPSHOT_VERSION,
      participant_id: participant_id }
  end

  # Queue a direction from a channel that authenticated the connection and
  # resolved the actor's active RoomMembership. No player id is accepted from
  # the wire payload. The match row serializes sequence allocation and caps.
  def accept_direction!(membership:, input:, now: Time.current)
    outcome = nil
    with_lock do
      unless LIVE_STATUSES.include?(status) && %w[pending running].include?(status)
        outcome = :match_not_running
        next
      end
      participant = match_participants.lock.find_by(room_membership_id: membership.id)
      unless participant
        outcome = :not_a_participant
        next
      end
      unless participant.status == "alive"
        outcome = :eliminated
        next
      end
      unless input.seq.is_a?(Integer) && input.seq > participant.last_input_seq
        outcome = :stale_sequence
        next
      end
      earliest = [checkpoint_tick - Simulation::World::INPUT_TICK_WINDOW, 0].max
      latest = checkpoint_tick + INPUT_FUTURE_WINDOW
      unless input.tick.is_a?(Integer) && input.tick.between?(earliest, latest)
        outcome = :invalid_tick
        next
      end
      if MatchInput.where(match_participant_id: participant.id).count >= MAX_PENDING_INPUTS_PER_PARTICIPANT
        outcome = :queue_full
        next
      end

      match_inputs.create!(match_participant: participant, input_seq: input.seq,
                           client_tick: input.tick, direction: input.direction.name,
                           received_at: now)
      participant.update_columns(last_input_seq: input.seq, updated_at: now)
      outcome = :queued
    end
    outcome
  rescue ActiveRecord::RecordNotUnique
    :stale_sequence
  end

  # The sole owner drains durable commands immediately before a logical step.
  # Applied rows stay until the checkpoint that includes their sequence
  # commits, so a crash replays them from the previous checkpoint.
  def apply_queued_inputs!(world:, token:, now: Time.current, limit: 128)
    rejected = []
    owned = false
    with_lock do
      unless owner_token == token && lease_expires_at && lease_expires_at > now && live?
        next
      end
      owned = true
      match_inputs.order(:id).limit(limit).each do |entry|
        snake = world.player(entry.match_participant_id)
        next if snake && snake.last_seq >= entry.input_seq

        outcome = world.apply_input(
          player_id: entry.match_participant_id,
          direction: Simulation::Direction.parse(entry.direction),
          tick: entry.client_tick,
          seq: entry.input_seq
        )
        unless %i[accepted duplicate_direction reversal queue_full].include?(outcome)
          rejected << { participant: entry.match_participant_id, seq: entry.input_seq, reason: outcome }
          match_inputs.where(id: entry.id).delete_all
        end
      end
    end
    owned ? rejected : nil
  end

  # Persist the latest complete frame at the independent broadcast cadence (not
  # per movement tick), fenced on the lease, so a reconnecting channel on any
  # Puma worker can bootstrap from a whole authoritative snapshot.
  def publish_snapshot!(world, token:, now: Time.current)
    payload = Simulation::Protocol.encode(world).merge("type" => "snapshot")
    updated = self.class.where(id: id, owner_token: token).where(status: LIVE_STATUSES)
                .update_all(live_snapshot: payload, snapshot_tick: world.tick, updated_at: now) == 1
    reload if updated
    updated
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

  # Periodic durable progress. Checkpoint and consumed-input acknowledgements
  # commit atomically, fenced on owner_token: a process that lost its lease
  # cannot overwrite a newer checkpoint or acknowledge inputs it did not apply.
  def save_progress!(world, token:, now: Time.current)
    self.class.transaction do
      attrs = { status: world.status.to_s, tick: world.tick, checkpoint: world.to_state,
                checkpoint_tick: world.tick, started_at: (started_at || now), updated_at: now }
      updated = self.class.where(id: id, owner_token: token).where(status: LIVE_STATUSES)
                  .update_all(attrs) == 1
      next false unless updated

      world.snakes.each do |snake|
        match_inputs.where(match_participant_id: snake.id)
                    .where("input_seq <= ?", snake.last_seq).delete_all
      end
      reload
      true
    end
  end

  def complete_from_world!(world, token:, now: Time.current)
    entries = world.standings
    committed = false
    transaction do
      updated = self.class.where(id: id, owner_token: token).update_all(
        status: "completed", tick: world.tick, checkpoint: world.to_state,
        checkpoint_tick: world.tick,
        live_snapshot: Simulation::Protocol.encode(world).merge("type" => "snapshot"),
        snapshot_tick: world.tick, ended_at: now,
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

    # Only real progress is ranked. A match that never started (or never
    # checkpointed) has no authoritative score; writing zero-point placements
    # for it would fabricate a result that future ranking could surface.
    entries =
      if checkpoint.present?
        begin
          build_world.standings
        rescue StandardError => error
          Rails.logger.warn("Match #{id} could not rebuild standings on abandon: #{error.class}: #{error.message}")
          []
        end
      else
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
