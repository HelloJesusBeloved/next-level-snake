# A single multiplayer match. The rules live in Simulation::World (pure Ruby);
# this record is the durable shell: configuration frozen at start, ownership
# lease, periodic checkpoints and final standings.
#
# Ownership: exactly one process may simulate a match at a time. #claim_lease!
# is a conditional UPDATE (expired / unowned / own token) and every subsequent
# write is fenced on owner_token, so a stale owner cannot checkpoint or publish
# results after another process took over.
class Match < ApplicationRecord
  STATUSES = %w[pending running paused completed abandoned interrupted].freeze
  LIVE_STATUSES = %w[pending running paused].freeze
  # ---- Step 10: connection recovery ---------------------------------------
  FREEZE_GRACE_SECONDS = 30
  MAX_FREEZE_WINDOWS = 2
  FREEZE_COOLDOWN_SECONDS = 60
  # Backstop only: Action Cable closes a dead socket on its own ping timeout,
  # which is what normally starts the freeze immediately. The heartbeat window
  # must stay comfortably above hidden-tab timer throttling.
  PRESENCE_STALE_SECONDS = 90
  ORPHAN_MATCH_GRACE_SECONDS = 60
  MODES = %w[brawl duel].freeze
  DEFAULT_DURATION_SECONDS = 180
  TICK_PRESET_MS = Simulation::Config::SPEED_PRESETS

  belongs_to :room, inverse_of: :matches
  belongs_to :winner_membership, class_name: "RoomMembership", optional: true
  has_many :match_participants, dependent: :delete_all, inverse_of: :match
  has_many :match_inputs, dependent: :delete_all, inverse_of: :match
  # One row per open MatchChannel socket (one tab). Presence rows are the only
  # source of "is any tab of this player still connected?".
  has_many :match_presences, dependent: :delete_all, inverse_of: :match

  validates :mode, inclusion: { in: MODES }
  validates :presentation_strategy, inclusion: { in: Room::PRESENTATION_STRATEGIES }
  validate :presentation_strategy_is_immutable, if: :persisted?
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
      # Step 3: the host's frozen choice is created as-is. Validating the VALUE
      # (rather than rejecting one of them) keeps the match row honest: the
      # strategy stored here is the strategy the simulator is built with, and it
      # is what every frame reports.
      strategy = frozen["presentation_strategy"] || room.presentation_strategy || "classic"
      unless Room::PRESENTATION_STRATEGIES.include?(strategy)
        raise Room::InvalidTransition, "That Brawl presentation strategy is not available."
      end
      match = create!(
        room: room, mode: room.mode, presentation_strategy: strategy, status: "pending",
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

  # Tunables resolve through the shared multiplayer configuration so an
  # operator (or a test with a controllable clock) can scale the timeline
  # without editing code. Defaults are the step-10 contract: 30 s grace, at
  # most two windows per match, 60 s between windows.
  class << self
    def tuning(key, fallback)
      cfg = Rails.configuration.x.multiplayer
      cfg.respond_to?(key) ? cfg.public_send(key) : fallback
    end

    def freeze_grace_seconds
      tuning(:brawl_freeze_grace, FREEZE_GRACE_SECONDS)
    end

    def max_freeze_windows
      tuning(:brawl_freeze_windows, MAX_FREEZE_WINDOWS)
    end

    def freeze_cooldown_seconds
      tuning(:brawl_freeze_cooldown, FREEZE_COOLDOWN_SECONDS)
    end

    def presence_stale_seconds
      tuning(:match_presence_timeout, PRESENCE_STALE_SECONDS)
    end

    def orphan_match_grace_seconds
      tuning(:orphan_match_grace, ORPHAN_MATCH_GRACE_SECONDS)
    end
  end

  def self.derive_max_ticks(tick_ms)
    [(DEFAULT_DURATION_SECONDS * 1_000.0 / tick_ms).round, Simulation::Config::MIN_MAX_TICKS].max
  end

  def presentation_strategy_is_immutable
    return unless will_save_change_to_presentation_strategy?

    errors.add(:presentation_strategy, "is locked for this match")
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
    { id: id, mode: mode, presentation_strategy: presentation_strategy, status: status, tick: tick, tick_ms: tick_ms,
      columns: columns, rows: rows, growth: growth, protocol_version: Simulation::Protocol::SNAPSHOT_VERSION,
      participant_id: participant_id,
      # Step 10: the browser renders the countdown from server values only.
      freeze_grace_seconds: self.class.freeze_grace_seconds,
      presence_stale_seconds: self.class.presence_stale_seconds }
  end

  # Queue a direction from a channel that authenticated the connection and
  # resolved the actor's active RoomMembership. No player id is accepted from
  # the wire payload.
  #
  # PERFORMANCE (step 10 perf): this used to take the MATCH row lock on every
  # keypress, which serialized all steering behind the simulator's own
  # lock/checkpoint/broadcast writes and was the main source of perceived input
  # lag. The sequence is now reserved with a single atomic conditional UPDATE:
  # concurrent duplicate/replayed envelopes still lose the race exactly once,
  # but no rows stay locked while the command is written. The participant
  # read + validation is three cheap indexed queries at most.
  def accept_direction!(membership:, input:, now: Time.current)
    # One indexed read decides liveness and gives the checkpoint window.
    checkpoint = self.class.where(id: id, status: %w[pending running]).pick(:checkpoint_tick)
    return :match_not_running if checkpoint.nil?

    participant = match_participants.find_by(room_membership_id: membership.id)
    return :not_a_participant unless participant
    return :eliminated unless participant.status == "alive"
    # Commands from a frozen/unattended snake are never authoritative, even if
    # a stale socket slips one past the disconnect handler.
    return :disconnected unless participant.connection_state == "connected"
    return :frozen if participant.freeze_deadline_at.present? && participant.freeze_deadline_at > now
    return :stale_sequence unless input.seq.is_a?(Integer) && input.seq > participant.last_input_seq

    earliest = [checkpoint.to_i - Simulation::World::INPUT_TICK_WINDOW, 0].max
    latest = checkpoint.to_i + INPUT_FUTURE_WINDOW
    return :invalid_tick unless input.tick.is_a?(Integer) && input.tick.between?(earliest, latest)
    if MatchInput.where(match_participant_id: participant.id).count >= MAX_PENDING_INPUTS_PER_PARTICIPANT
      return :queue_full
    end

    # Atomic reservation: no FOR UPDATE, no transaction held across the insert.
    reserved = match_participants
               .where(id: participant.id, status: "alive", connection_state: "connected")
               .where("last_input_seq < ?", input.seq)
               .where("freeze_deadline_at IS NULL OR freeze_deadline_at <= ?", now)
               .update_all(last_input_seq: input.seq, updated_at: now)
    return :stale_sequence if reserved.zero?

    match_inputs.create!(match_participant: participant, input_seq: input.seq,
                         client_tick: input.tick, direction: input.direction.name,
                         received_at: now)
    :queued
  rescue ActiveRecord::RecordNotUnique
    :stale_sequence
  end

  # The sole owner drains durable commands immediately before a logical step.
  # Applied rows stay until the checkpoint that includes their sequence
  # commits, so a crash replays them from the previous checkpoint.
  #
  # PERFORMANCE (step 10 perf): the old version opened a transaction and took
  # the match row lock BEFORE every logical tick even when the queue was empty
  # (10-25 times per second per match). It now reads the ready rows with one
  # indexed query and returns immediately when nobody is steering; the fenced
  # liveness read happens only when there is real work to apply.
  def apply_queued_inputs!(world:, token:, now: Time.current, limit: 128, on_applied: nil)
    entries = match_inputs.order(:id).limit(limit).to_a
    return [] if entries.empty?
    return nil unless owned_by?(token: token, now: now)

    rejected = []
    entries.each do |entry|
      snake = world.player(entry.match_participant_id)
      next if snake && snake.last_seq >= entry.input_seq

      outcome = world.apply_input(
        player_id: entry.match_participant_id,
        direction: Simulation::Direction.parse(entry.direction),
        tick: entry.client_tick,
        seq: entry.input_seq,
        # The client names its last RECEIVED snapshot tick, which lags the
        # owner's in-memory tick. Sequence order, not this tick, governs
        # ordering; a strict window here silently dropped valid steering.
        window: Simulation::World::QUEUED_INPUT_TICK_WINDOW
      )
      if outcome == :accepted
        snake = world.player(entry.match_participant_id)
        on_applied&.call({ participant: entry.match_participant_id, seq: entry.input_seq,
                           tick: snake&.last_applied_tick || world.tick })
        next
      end

      rejected << { participant: entry.match_participant_id, seq: entry.input_seq,
                    reason: outcome, tick: world.tick }
      match_inputs.where(id: entry.id).delete_all
    end
    rejected
  end

  # Single indexed liveness check used by the input drain. Reads only; the
  # authoritative fencing still happens on every durable write.
  def owned_by?(token:, now: Time.current)
    self.class.where(id: id, owner_token: token, status: LIVE_STATUSES)
        .where("lease_expires_at > ?", now).exists?
  end

  # Persist the latest complete frame at the independent broadcast cadence (not
  # per movement tick), fenced on the lease, so a reconnecting channel on any
  # Puma worker can bootstrap from a whole authoritative snapshot.
  def publish_snapshot!(world, token:, now: Time.current)
    persisted = persist_snapshot!(world, token: token, now: now)
    # Keep the in-memory copy fresh for this process's reconnect seeds without
    # re-reading the whole row (the old `reload` was a full extra SELECT on
    # every published frame).
    self.live_snapshot = Simulation::Protocol.encode(world).merge("type" => "snapshot")
    self.snapshot_tick = world.tick
    persisted
  end

  # Fenced durable write used at a deliberately lower cadence than the socket
  # broadcast. Reconnecting clients are seeded from the newest persisted frame
  # and immediately receive live frames, so 2 s of durability is plenty.
  def persist_snapshot!(world, token:, now: Time.current)
    payload = Simulation::Protocol.encode(world).merge("type" => "snapshot")
    self.class.where(id: id, owner_token: token).where(status: LIVE_STATUSES)
        .update_all(live_snapshot: payload, snapshot_tick: world.tick, updated_at: now) == 1
  end

  # Rebuilds the in-memory world. A checkpoint (written every N ticks) is the
  # only recovery source after a lease hand-over; participants are re-read from
  # the database so names/colors cannot be altered through a checkpoint.
  def build_world
    config = simulation_config
    participants = simulation_participants
    if checkpoint.present? && Array(checkpoint["snakes"]).any?
      Simulation::World.restore(id: id, config: config, participants: participants, state: checkpoint,
                                presentation_strategy: presentation_strategy)
    else
      Simulation::World.new(id: id, config: config, participants: participants,
                            presentation_strategy: presentation_strategy)
    end
  end

  # ---- connection lifecycle (step 10) -------------------------------------
  #
  # The SERVER owns every transition below. A browser disconnect only records
  # "no fresh socket"; the leased simulator owner applies the freeze to the
  # in-memory world, unfreezes at the database deadline, and resumes on the
  # next observed connection. No client timer participates.

  def interrupted?
    status == "interrupted"
  end

  def recoverable_from_checkpoint?
    checkpoint.present? && Array(checkpoint["snakes"]).any?
  end

  # Atomic connect/observe. A new tab/socket immediately clears any freeze in
  # the database and discards queued commands from the lost connection; the
  # owner unfreezes the snake on its next pass. Returns [presence, participant].
  def register_presence!(membership:, socket_token:, kind: "participant", now: Time.current)
    participant = match_participants.find_by(room_membership_id: membership.id)
    presence = match_presences.create!(
      room_membership: membership, match_participant: participant,
      socket_token: socket_token, kind: participant ? "participant" : "spectator",
      connected_at: now, last_seen_at: now
    )
    if participant
      # PERFORMANCE (step 10 perf): no match row lock and no unconditional
      # command purge on every (re)subscribe. A healthy tab is now one UPDATE
      # of its presence timestamp; only an actually broken connection pays for
      # clearing the stale commands and signalling a resume.
      was_offline = participant.connection_state != "connected" || participant.freeze_deadline_at.present?
      if was_offline
        match_inputs.where(match_participant_id: participant.id).delete_all
        match_participants.where(id: participant.id).update_all(
          connection_state: "connected", reconnected_at: now, last_seen_at: now,
          frozen_at: nil, freeze_deadline_at: nil, updated_at: now
        )
        participant.reload
        broadcast_connection!(participant, event: "resumed", now: now)
      else
        match_participants.where(id: participant.id).update_all(last_seen_at: now, updated_at: now)
        participant.last_seen_at = now
      end
    end
    [presence, participant]
  rescue ActiveRecord::RecordNotUnique
    [match_presences.find_by(socket_token: socket_token), participant]
  end

  # Removes one tab. The player is only considered gone when no other fresh
  # presence remains. Returns :still_connected, :frozen, :unattended,
  # :already_disconnected, :not_a_participant or :match_over.
  def release_presence!(socket_token:, now: Time.current)
    presence = match_presences.find_by(socket_token: socket_token)
    return :not_a_participant unless presence

    membership = presence.room_membership
    participant = presence.match_participant || match_participants.find_by(room_membership_id: membership.id)
    match_presences.where(socket_token: socket_token).delete_all
    return :spectator unless participant

    outcome = nil
    with_lock do
      participant.reload
      if match_presences.where(room_membership_id: membership.id).fresh(now).exists?
        outcome = :still_connected
      elsif !live?
        outcome = :match_over
      elsif participant.connection_state != "connected"
        outcome = :already_disconnected
      else
        outcome = mark_disconnected_locked!(participant, now: now, reason: :socket_closed)
      end
    end
    broadcast_connection!(participant.reload, event: outcome.to_s, now: now) unless outcome == :still_connected
    outcome
  end

  # Reaps sockets that vanished without a clean close (Cloudflare Tunnel, killed
  # tab, dead worker) and freezes any participant whose last tab went silent.
  # Returns the outcomes for observability/tests.
  def reconcile_presence!(now: Time.current)
    stale_before = now - self.class.presence_stale_seconds
    stale = match_presences.where("last_seen_at < ?", stale_before)
    stale_memberships = stale.pluck(:room_membership_id).uniq
    stale.delete_all
    outcomes = {}
    match_participants.where(connection_state: "connected").where.not(last_seen_at: nil).find_each do |participant|
      next if participant.room_membership_id.nil?
      next if match_presences.where(room_membership_id: participant.room_membership_id).exists?

      membership = RoomMembership.find_by(id: participant.room_membership_id)
      next unless membership

      outcome = with_lock do
        participant.lock!
        break :already_disconnected unless participant.connection_state == "connected"
        break :match_over unless live?

        mark_disconnected_locked!(participant, now: now, reason: :presence_timeout)
      end
      outcomes[participant.id] = outcome
      broadcast_connection!(participant.reload, event: outcome.to_s, now: now) unless outcome == :already_disconnected
    end
    { stale_sockets: stale_memberships, participants: outcomes }
  end

  # Server-owned clock pass, called by the leased owner before it steps the
  # world. Applies freezes, unfreezes on reconnection and RELEASES snakes whose
  # 30 s grace expired; released snakes keep moving in their last direction and
  # are never eliminated here.
  def sync_connection_states!(world, now: Time.current)
    world.server_time_ms = (now.to_f * 1000).round
    # One indexed read of every participant instead of a row lock plus a
    # per-participant `reload` on every simulator pass (the step-10 version did
    # both ~20 times per second, which alone cost more than the simulation).
    states = match_participants.pluck(:id, :connection_state, :freeze_deadline_at)
    events = []
    expired = []

    states.each do |participant_id, state, deadline|
      snake = world.player(participant_id)
      next unless snake

      case state
      when "connected"
        next unless snake.frozen?

        world.resume_player!(participant_id)
        events << { participant: participant_id, state: "resumed" }
      when "disconnected"
        if snake.alive? && deadline.present? && deadline > now
          next if snake.frozen?

          world.freeze_player!(participant_id, now_ms: (now.to_f * 1000).round,
                                              until_ms: (deadline.to_f * 1000).round)
          events << { participant: participant_id, state: "frozen",
                      grace_deadline_at: deadline.iso8601(6) }
        else
          world.release_player!(participant_id) if snake.frozen?
          expired << participant_id
          events << { participant: participant_id, state: "unattended", reason: "grace_expired" }
        end
      when "unattended"
        next unless snake.frozen?

        world.release_player!(participant_id)
        events << { participant: participant_id, state: "unattended" }
      end
    end

    unless expired.empty?
      # Only the rows that are still disconnected are touched, so a tab that
      # reconnected during this pass is not clobbered.
      match_participants.where(id: expired, connection_state: "disconnected")
                        .update_all(connection_state: "unattended", frozen_at: nil,
                                    freeze_deadline_at: nil, updated_at: now)
    end
    events.each { |fields| MatchChannel.broadcast_event(id, { type: "connection", match: id }.merge(fields)) }
    events
  end

  # A late reconnection while still alive simply restores control. This is a
  # deliberate no-op for a completed/interrupted match: the connection is
  # acknowledged, but no snake can be resurrected.
  def reconnect_after_game!(membership:, now: Time.current)
    participant = match_participants.find_by(room_membership_id: membership.id)
    return nil unless participant

    participant.update_columns(last_seen_at: now, reconnected_at: now, updated_at: now)
    participant
  end

  # Ended without simulation: either the match never produced a recoverable
  # checkpoint, or the room was closed. Never writes standings or a winner.
  def interrupt!(reason: "unrecoverable", now: Time.current)
    changed = false
    transaction do
      changed = self.class.where(id: id, status: LIVE_STATUSES).update_all(
        status: "interrupted", ended_at: now, end_reason: reason.to_s,
        owner_token: nil, lease_expires_at: nil, winner_membership_id: nil, updated_at: now
      ) == 1
      next unless changed

      match_presences.delete_all
      match_participants.update_all(connection_state: "unattended", frozen_at: nil,
                                    freeze_deadline_at: nil, updated_at: now)
    end
    return false unless changed

    reload
    begin
      MatchChannel.broadcast_event(id, { type: "interrupted", match: id, reason: reason.to_s })
      room.finish_match! if room.in_match?
    rescue StandardError => error
      Rails.logger.warn("Interrupted match #{id}; room notification deferred: " \
                        "#{error.class}: #{error.message}")
    end
    true
  end

  # Marks live matches that cannot be resumed safely as interrupted. A match
  # with an authoritative checkpoint is NOT interrupted: the lease can be
  # taken over and the world rebuilt. Completed results are frozen forever.
  def self.recover_orphans!(now: Time.current, limit: 100)
    cutoff = now - orphan_match_grace_seconds
    interrupted = []
    live.where("lease_expires_at IS NULL OR lease_expires_at < ?", now)
        .where(created_at: ..cutoff).order(:id).limit(limit).each do |match|
      next if match.recoverable_from_checkpoint?
      next unless match.interrupt!(reason: "unrecoverable", now: now)

      interrupted << match.id
    end
    interrupted
  end

  private def mark_disconnected_locked!(participant, now:, reason:)
    # Commands queued for the connection that just died are stale by
    # definition: drop them before the freeze so they can never be applied
    # after a reconnect. Sequence numbers stay monotonic (replay is refused).
    match_inputs.where(match_participant_id: participant.id).delete_all
    # Only grant a freeze while the Brawl is running and the snake still lives.
    if live? && participant.status == "alive" && freeze_window_allowed?(participant, now)
      deadline = now + self.class.freeze_grace_seconds
      participant.update_columns(
        connection_state: "disconnected", disconnected_at: now, frozen_at: now,
        freeze_deadline_at: deadline, last_seen_at: now,
        freeze_windows_used: participant.freeze_windows_used + 1,
        last_freeze_started_at: now, updated_at: now
      )
      :frozen
    else
      participant.update_columns(
        connection_state: "unattended", disconnected_at: now, frozen_at: nil,
        freeze_deadline_at: nil, last_seen_at: now, updated_at: now
      )
      :unattended
    end
  end

  private def freeze_window_allowed?(participant, now)
    return false if participant.freeze_windows_used >= self.class.max_freeze_windows

    last = participant.last_freeze_started_at
    last.nil? || last <= now - self.class.freeze_cooldown_seconds
  end

  # Called from checkpoint and completion writes only. Frozen ticks are an
  # audit/display counter; Ranking never uses them.
  def persist_freeze_ticks!(world, now: Time.current)
    frozen = world.snakes.select { |snake| snake.frozen_ticks.positive? }
    frozen.each do |snake|
      match_participants.where(id: snake.id).update_all(freeze_ticks: snake.frozen_ticks, updated_at: now)
    end
    # Persist the authoritative frozen set as part of the checkpoint; a crash
    # then restores the exact same pause (still bounded by the DB deadline).
  end

  private def broadcast_connection!(participant, event:, now:)
    MatchChannel.broadcast_event(id, {
      type: "connection", match: id, participant: participant.id,
      state: event.to_s, connection: participant.connection_state,
      frozen: participant.frozen?, reason: event.to_s,
      grace_deadline_at: participant.freeze_deadline_at&.iso8601(6),
      freezes_used: participant.freeze_windows_used, at: now.iso8601(6)
    }.compact)
  rescue StandardError => error
    Rails.logger.warn("match=#{id} connection event deferred: #{error.class}: #{error.message}")
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
      persist_freeze_ticks!(world, now: now)
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
