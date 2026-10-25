# The authoritative simulator for this process.
#
# Ownership strategy (documented in docs/multiplayer-step-07-server-engine.md):
# every live match has a database lease (`matches.owner_token` +
# `lease_expires_at`). A process may only attach a match after winning the
# conditional-UPDATE claim, and it renews the lease on a throttled interval.
# All checkpoint/completion writes are fenced on the token, so a stale owner
# cannot overwrite newer state or publish results after another process took
# over.
#
# Step 8 adds the two bridges that make the engine playable:
#   * durable direction commands (match_inputs) written by any Action Cable
#     worker are drained by the leased owner immediately before each logical
#     step — movement is never scheduled by socket arrival time;
#   * compact full snapshots are persisted + broadcast at a 10 Hz network
#     cadence, independent of the 40–1000 ms movement tick.
#
# PostgreSQL is touched for input commands, the 10 Hz snapshot, the throttled
# lease renewal, and checkpoints every CHECKPOINT_EVERY_TICKS — never for
# every movement tick.
class MatchRunner
  LEASE_TTL_SECONDS = 6
  CHECKPOINT_EVERY_TICKS = 20
  MAX_CLAIMS_PER_TICK = 10
  # Must stay below the fastest tick (Ludicrous = 42 ms) so every logical step
  # drains pending direction rows; otherwise a step can run without them.
  INPUT_POLL_INTERVAL_MS = 30
  SNAPSHOT_BROADCAST_INTERVAL_MS = 100
  # Step 10: presence sweeps are throttled well below socket-heartbeat cadence
  # but fast enough to detect a silent tunnel drop without a 15 s stall.
  PRESENCE_SWEEP_INTERVAL_MS = 500
  # Orphan recovery is a cheap bounded query; never run it on every pass.
  ORPHAN_SWEEP_INTERVAL_MS = 10_000

  class << self
    def token
      @token ||= SecureRandom.hex(16)
    end

    def input_poll_at
      @input_poll_at ||= {}
    end

    def snapshot_broadcast_at
      @snapshot_broadcast_at ||= {}
    end

    def forget_match(match_id)
      input_poll_at.delete(match_id)
      snapshot_broadcast_at.delete(match_id)
    end

    def presence_sweep_at
      @presence_sweep_at ||= 0
    end

    def orphan_sweep_at
      @orphan_sweep_at ||= 0
    end

    def supervisor
      @supervisor ||= Simulation::Supervisor.new(
        ownership: Ownership.new(token: token),
        checkpoint_every: CHECKPOINT_EVERY_TICKS,
        before_step: ->(world) { deliver_inputs(world) },
        on_error: lambda do |match_id, error|
          Rails.logger.error("Match #{match_id} detached after simulation error: " \
                             "#{error.class}: #{error.message}")
        end
      )
    end

    def mutex
      @mutex ||= Mutex.new
    end

    # One scheduler pass: claim free matches, advance owned worlds on monotonic
    # time, then publish snapshots at the independent network cadence.
    # `monotonic_ms` is injectable so tests never sleep on a real clock.
    def tick_once(now: Time.current, monotonic_ms: Simulation::Scheduler.monotonic_ms, limit: MAX_CLAIMS_PER_TICK)
      mutex.synchronize do
        claimed = claim_matches(now: now, monotonic_ms: monotonic_ms, limit: limit)
        # Server-owned connection transitions run BEFORE any movement tick, so a
        # freeze/unfreeze takes effect in the same pass that observes it.
        # Presence first: a silent socket starts a grace window, then the world
        # is frozen before it can move another cell.
        presence = reconcile_connections(now: now, monotonic_ms: monotonic_ms)
        connections = sync_connections(now: now)
        interrupted = recover_orphans(now: now, monotonic_ms: monotonic_ms)
        report = supervisor.tick!(now_ms: monotonic_ms).merge(
          claimed: claimed, connections: connections, presence: presence,
          interrupted: interrupted
        )
        publish_snapshots(now: now, monotonic_ms: monotonic_ms)
        report
      end
    end

    # Applies the database's authoritative connection states to every owned
    # world. Entirely server-driven: a frozen snake stays put, a resumed one is
    # released, and an expired grace deadline unfreezes without killing.
    def sync_connections(now: Time.current)
      changes = []
      supervisor.entries.each_value do |entry|
        match = Match.find_by(id: entry.world.id)
        next unless match

        changes.concat(match.sync_connection_states!(entry.world, now: now))
      rescue StandardError => error
        Rails.logger.warn("Connection sync failed for match=#{entry.world.id}: " \
                          "#{error.class}: #{error.message}")
      end
      changes
    end

    # Reaps sockets that died without a clean Action Cable callback and starts
    # the grace window for players whose every tab is silent.
    def reconcile_connections(now: Time.current, monotonic_ms: Simulation::Scheduler.monotonic_ms)
      return {} if monotonic_ms - presence_sweep_at < PRESENCE_SWEEP_INTERVAL_MS

      @presence_sweep_at = monotonic_ms
      Match.live.find_each do |match|
        match.reconcile_presence!(now: now)
      rescue StandardError => error
        Rails.logger.warn("Presence reconcile failed for match=#{match.id}: " \
                          "#{error.class}: #{error.message}")
      end
    end

    # Server-crash recovery: only safely unrecoverable live matches (no
    # checkpoint, lease expired) are interrupted — without invented standings
    # or a winner. Completed matches/results are never modified.
    def recover_orphans(now: Time.current, monotonic_ms: Simulation::Scheduler.monotonic_ms)
      return [] if monotonic_ms - orphan_sweep_at < ORPHAN_SWEEP_INTERVAL_MS

      @orphan_sweep_at = monotonic_ms
      Match.recover_orphans!(now: now)
    end

    # Throttled, fenced drain of durable direction commands. Returns false when
    # the lease is gone; the supervisor then detaches without stepping.
    def deliver_inputs(world, now: Time.current, monotonic_ms: Simulation::Scheduler.monotonic_ms)
      last = input_poll_at[world.id]
      return true if last && monotonic_ms - last < INPUT_POLL_INTERVAL_MS

      input_poll_at[world.id] = monotonic_ms
      match = Match.find_by(id: world.id)
      return false unless match

      rejected = match.apply_queued_inputs!(world: world, token: token, now: now)
      return false unless rejected

      rejected.each do |failure|
        MatchChannel.broadcast_event(world.id, {
          type: "input_rejected", participant: failure[:participant],
          seq: failure[:seq], reason: failure[:reason].to_s, tick: world.tick
        })
      end
      true
    end

    # Persist + broadcast the full compact snapshot at 10 Hz, independent of
    # tick_ms. The persisted frame lets a MatchChannel on any Puma worker seed
    # a reconnecting client from complete authoritative state.
    def publish_snapshots(now: Time.current, monotonic_ms: Simulation::Scheduler.monotonic_ms)
      supervisor.entries.each do |match_id, entry|
        last = snapshot_broadcast_at[match_id]
        next if last && monotonic_ms - last < SNAPSHOT_BROADCAST_INTERVAL_MS

        match = Match.find_by(id: match_id)
        unless match && match.publish_snapshot!(entry.world, token: token, now: now)
          supervisor.detach(match_id)
          forget_match(match_id)
          next
        end
        MatchChannel.broadcast_snapshot(match_id, Simulation::Protocol.encode(entry.world))
        snapshot_broadcast_at[match_id] = monotonic_ms
      rescue StandardError => error
        Rails.logger.warn("MatchRunner snapshot broadcast failed match=#{match_id}: " \
                          "#{error.class}: #{error.message}")
      end
    end

    def claim_matches(now:, monotonic_ms:, limit:)
      claimed = []
      Match.claimable(now).order(:id).limit(limit).each do |match|
        next if supervisor.attach?(match.id)

        # A match that had started but never checkpointed cannot be replayed
        # from scratch: abandon it rather than silently restarting the round.
        if match.checkpoint.blank? && match.status != "pending"
          match.abandon!(reason: "owner_lost")
          next
        end
        next unless match.claim_lease!(token: token, ttl_seconds: LEASE_TTL_SECONDS, now: now)

        world = match.build_world
        next if finish_from_checkpoint!(match, world, now: now)

        world.start! if world.pending?
        # If the fenced progress write is refused, we no longer hold the lease:
        # attaching would simulate a match another process owns.
        next unless match.save_progress!(world, token: token, now: now)

        supervisor.attach(world, now_ms: monotonic_ms)
        claimed << match.id
      rescue StandardError => error
        # One corrupt/unclaimable match must never stop the claim loop.
        Rails.logger.warn("MatchRunner could not claim match=#{match.id}: #{error.class}: #{error.message}")
        match.abandon!(reason: "invalid_state") rescue nil
      end
      claimed
    end

    # A checkpoint whose world already finished (crash after the final tick,
    # before the completion write) is finalized instead of being attached: a
    # completed world would otherwise sit in memory forever.
    def finish_from_checkpoint!(match, world, now:)
      return false unless world.completed?

      match.complete_from_world!(world, token: token, now: now)
      true
    end

    # Test helper: forget in-process worlds (does not release database leases).
    def reset!
      @mutex = Mutex.new
      @supervisor = nil
      @token = nil
      @presence_sweep_at = 0
      @orphan_sweep_at = 0
      input_poll_at.clear
      snapshot_broadcast_at.clear
      true
    end

    # Orderly cleanup: give our leases back so another process (or the next
    # boot) can pick the matches up immediately instead of waiting for expiry.
    def shutdown!
      supervisor.match_ids.each do |match_id|
        supervisor.ownership.release!(match_id)
      rescue StandardError => error
        Rails.logger.warn("MatchRunner could not release match=#{match_id}: #{error.class}: #{error.message}")
      end
      supervisor.shutdown!
      input_poll_at.clear
      snapshot_broadcast_at.clear
    end
  end

  # Lease-fenced callbacks used by Simulation::Supervisor.
  class Ownership
    def initialize(token:)
      @token = token
    end

    def renew!(match_id)
      match = Match.find_by(id: match_id)
      return false unless match

      match.renew_lease!(token: @token, ttl_seconds: LEASE_TTL_SECONDS)
    rescue ActiveRecord::ActiveRecordError => error
      Rails.logger.warn("MatchRunner lease renewal failed for match=#{match_id}: #{error.class}: #{error.message}")
      false
    end

    def checkpoint!(world)
      match = Match.find_by(id: world.id)
      return false unless match

      match.persist_freeze_ticks!(world)
      match.save_progress!(world, token: @token)
    rescue ActiveRecord::ActiveRecordError => error
      Rails.logger.warn("MatchRunner checkpoint failed for match=#{world.id}: #{error.class}: #{error.message}")
      false
    end

    def complete!(world)
      match = Match.find_by(id: world.id)
      return false unless match

      persisted = match.complete_from_world!(world, token: @token)
      return false unless persisted

      # Final standings are durable first. Then restore the room lobby for the
      # next Brawl and broadcast the final complete frame. A transport failure
      # cannot undo results; the persisted final snapshot remains authoritative.
      begin
        match.room.finish_match! if match.room.in_match?
        MatchChannel.broadcast_snapshot(match.id, Simulation::Protocol.encode(world))
      rescue StandardError => error
        Rails.logger.warn("Completed match #{match.id}; room/snapshot notification deferred: " \
                          "#{error.class}: #{error.message}")
      end
      MatchRunner.forget_match(match.id)
      true
    rescue ActiveRecord::ActiveRecordError => error
      Rails.logger.warn("MatchRunner completion failed for match=#{world.id}: #{error.class}: #{error.message}")
      false
    end

    def release!(match_id)
      match = Match.find_by(id: match_id)
      return false unless match

      match.release_lease!(token: @token)
    rescue ActiveRecord::ActiveRecordError => error
      Rails.logger.warn("MatchRunner release failed for match=#{match_id}: #{error.class}: #{error.message}")
      false
    end
  end
end
