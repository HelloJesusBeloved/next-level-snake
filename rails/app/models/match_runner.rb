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
  # The lease only has to outlast a *slow* scheduler pass, not a healthy one.
  # Six seconds meant a stalled database round trip or a busy pool could make
  # an owner lose a live match and strand the round for everybody.
  LEASE_TTL_SECONDS = 20
  RENEW_INTERVAL_MS = 4_000
  CHECKPOINT_EVERY_TICKS = 20
  MAX_CLAIMS_PER_TICK = 10
  # Every movement step force-drains inputs before applying the tick. Keep
  # a bounded wake for connection changes, but do not poll all matches again
  # between ticks: those reads competed with the very tick they were meant to
  # make responsive.
  INPUT_POLL_INTERVAL_MS = 30
  CLAIM_SCAN_INTERVAL_MS = 250
  # Network cadence is decoupled from durability:
  #   * broadcast ONE frame per movement tick, in memory only (no DB write);
  #   * persist ~2 s so reconnects still have a complete recent frame.
  # Snake is a discrete grid game, so the only meaningful visual event is a
  # tick. A fixed-rate broadcast either duplicates frames (faster than the
  # tick) or drops them (slower), and an uneven frame/tick ratio is itself
  # visible as stutter. Emitting exactly one frame per tick makes the client's
  # visual cadence identical to the simulation's, with no client-side
  # smoothing required and the least possible traffic.
  # A keepalive still refreshes an idle board (pending/paused/all-frozen) so a
  # client that missed a frame re-syncs quickly.
  SNAPSHOT_KEEPALIVE_INTERVAL_MS = 1_000
  # Step 3: a Responsive match broadcasts compact movement frames between
  # complete snapshots. A full snapshot still goes out at least this often, so a
  # client that lost a frame is never more than this many ticks from recovery.
  MOVEMENT_FULL_INTERVAL_TICKS = 12
  SNAPSHOT_PERSIST_INTERVAL_MS = 2_000
  # Connection reconciliation is a cheap read now, but there is no reason to run
  # it 20 times per second. 150 ms keeps freeze/resume imperceptible.
  CONNECTION_SYNC_INTERVAL_MS = 150
  # Step 10: presence sweeps are throttled well below socket-heartbeat cadence
  # but fast enough to detect a silent tunnel drop without a 15 s stall.
  PRESENCE_SWEEP_INTERVAL_MS = 500
  # A deleted socket row with no unsubscribe callback is caught by this full
  # backstop. The usual half-second pass only touches rooms with stale rows.
  PRESENCE_FULL_SWEEP_INTERVAL_MS = 5_000
  # Orphan recovery is a cheap bounded query; never run it on every pass.
  ORPHAN_SWEEP_INTERVAL_MS = 10_000
  # Lobby lifecycle (presence, host succession, idle expiry) used to run only
  # inside client requests, so a room's fate depended on somebody's browser
  # still polling. The server now sweeps on its own clock.
  ROOM_SWEEP_INTERVAL_MS = 15_000

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

    # Last tick/status actually put on the wire, per match.
    def snapshot_broadcast_state
      @snapshot_broadcast_state ||= {}
    end

    def snapshot_persist_at
      @snapshot_persist_at ||= {}
    end

    def connection_sync_at
      @connection_sync_at ||= {}
    end

    def forget_match(match_id)
      input_poll_at.delete(match_id)
      movement_plan.delete(match_id)
      snapshot_broadcast_at.delete(match_id)
      snapshot_broadcast_state.delete(match_id)
      snapshot_persist_at.delete(match_id)
      connection_sync_at.delete(match_id)
    end

    def presence_sweep_at
      @presence_sweep_at ||= 0
    end

    def orphan_sweep_at
      @orphan_sweep_at ||= 0
    end

    def claim_scan_at
      @claim_scan_at
    end

    # Latest broadcast frame per match, written by the owner in the same pass it
    # publishes. Action Cable reads it to seed a (re)connecting client without
    # touching the simulator mutex, the database, or encoding anything on a
    # socket worker thread. A plain Hash write is enough: a slightly stale or
    # even momentarily mixed frame is still a complete authoritative snapshot,
    # and the live stream corrects it within one tick.
    def live_frames
      @live_frames ||= {}
    end

    def live_frame(match_id)
      live_frames[match_id]
    end

    def supervisor
      @supervisor ||= Simulation::Supervisor.new(
        ownership: Ownership.new(token: token),
        checkpoint_every: CHECKPOINT_EVERY_TICKS,
        renew_interval_ms: RENEW_INTERVAL_MS,
        # A tick boundary may NEVER skip a fresh direction. The inter-tick
        # scheduler pass is opportunistic and throttled, but the input queue
        # must be completely drained immediately before movement.
        before_step: ->(world) { deliver_inputs(world, force: true) },
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
        connections = sync_connections(now: now, monotonic_ms: monotonic_ms)
        # Every step force-drains durable commands immediately before moving.
        # A second query on each inter-tick pass only competes with movement.
        report = supervisor.tick!(now_ms: monotonic_ms)
        publish_snapshots(now: now, monotonic_ms: monotonic_ms)
        # Housekeeping is server-owned but must not delay due movement or the
        # broadcast behind a room-wide sweep or orphan recovery.
        interrupted = recover_orphans(now: now, monotonic_ms: monotonic_ms)
        sweep_rooms(now: now, monotonic_ms: monotonic_ms)
        report.merge(claimed: claimed, connections: connections, presence: presence,
                     interrupted: interrupted)
      end
    end

    # Wake for the next actual movement deadline; the forced pre-step input
    # drain also fires at that boundary. A 30ms ceiling keeps freeze/resume and
    # new room claims responsive, without querying every active room's input
    # queue on every inter-tick pass. This is only a SERVER timer.
    def next_wake_ms(now_ms: Simulation::Scheduler.monotonic_ms)
      entries = supervisor.entries.values
      return 250 if entries.empty?

      deadlines = entries.filter_map do |entry|
        next unless entry.world.running?
        scheduler = entry.scheduler
        elapsed = [now_ms - (scheduler.last_at_ms || now_ms), 0].max
        scheduler.tick_ms - scheduler.accumulator_ms - elapsed
      end
      [1, [INPUT_POLL_INTERVAL_MS, deadlines.min || INPUT_POLL_INTERVAL_MS].min].max
    end

    # Applies any waiting direction intents to the owned worlds. Bounded by the
    # same 30 ms throttle used by the pre-tick drain, so this cannot turn into a
    # per-request query storm.
    def drain_inputs(now: Time.current, monotonic_ms: Simulation::Scheduler.monotonic_ms)
      drained = []
      supervisor.entries.each_value do |entry|
        next unless deliver_inputs(entry.world, now: now, monotonic_ms: monotonic_ms)

        drained << entry.world.id
      rescue StandardError => error
        Rails.logger.warn("Input pre-drain failed for match=#{entry.world.id}: " \
                          "#{error.class}: #{error.message}")
      end
      drained
    end

    # Newest in-memory frame for a match this process owns, or nil when another
    # process owns it (then the caller uses the durable frame). Lock-free on
    # purpose: a socket worker must NEVER wait on the simulator mutex, because
    # the simulator may itself be waiting for a database connection that this
    # worker is holding. Blocking here starves heartbeats for every player,
    # which freezes everybody's snake and can time the round out.
    def live_snapshot_for(match_id)
      live_frame(match_id)
    end

    # Applies the database's authoritative connection states to every owned
    # world. Entirely server-driven: a frozen snake stays put, a resumed one is
    # released, and an expired grace deadline unfreezes without killing.
    def sync_connections(now: Time.current, monotonic_ms: Simulation::Scheduler.monotonic_ms)
      changes = []
      supervisor.entries.each_value do |entry|
        match_id = entry.world.id
        last = connection_sync_at[match_id]
        next if last && monotonic_ms - last < CONNECTION_SYNC_INTERVAL_MS

        connection_sync_at[match_id] = monotonic_ms
        # The world stamps server time on every snapshot; keep it fresh even if
        # the transition pass runs less often than the broadcast.
        entry.world.server_time_ms ||= (now.to_f * 1000).round
        match = Match.find_by(id: match_id)
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
      stale_ids = MatchPresence.where("last_seen_at < ?", now - Match.presence_stale_seconds)
                               .distinct.pluck(:match_id)
      full = @presence_full_sweep_at &&
             monotonic_ms - @presence_full_sweep_at >= PRESENCE_FULL_SWEEP_INTERVAL_MS
      @presence_full_sweep_at ||= monotonic_ms
      @presence_full_sweep_at = monotonic_ms if full
      return {} if stale_ids.empty? && !full

      matches = full ? Match.live : Match.live.where(id: stale_ids)
      matches.find_each do |match|
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

    # Server-driven lobby maintenance: presence expiry, host succession and
    # idle expiry no longer wait for a player's browser to poll. Bounded, and it
    # never touches a room with a live match except to self-heal a stranded one.
    def sweep_rooms(now: Time.current, monotonic_ms: Simulation::Scheduler.monotonic_ms)
      return if monotonic_ms - room_sweep_at < ROOM_SWEEP_INTERVAL_MS

      @room_sweep_at = monotonic_ms
      Room.sweep_stale!(at: now, limit: 50)
      Room.heal_stranded_matches!(now: now)
    rescue StandardError => error
      Rails.logger.warn("Room sweep pass failed: #{error.class}: #{error.message}")
    end

    def room_sweep_at
      @room_sweep_at ||= 0
    end

    # Throttled, fenced drain of durable direction commands. Returns false when
    # the lease is gone; the supervisor then detaches without stepping.
    def deliver_inputs(world, now: Time.current,
                       monotonic_ms: Simulation::Scheduler.monotonic_ms, force: false)
      last = input_poll_at[world.id]
      # The pass between ticks is throttled, so dozens of concurrent clients
      # cannot turn a single match into a query storm. At a tick boundary this
      # early return is forbidden: otherwise a client command is acknowledged
      # and then skips an entire movement tick (105 ms normal, 165 ms Chill).
      return true if !force && last && monotonic_ms - last < INPUT_POLL_INTERVAL_MS

      input_poll_at[world.id] = monotonic_ms
      match = Match.find_by(id: world.id)
      return false unless match

      applied = []
      rejected = match.apply_queued_inputs!(world: world, token: token, now: now,
                                             on_applied: ->(event) { applied << event })
      return false unless rejected

      applied.each do |event|
        MatchChannel.broadcast_event(world.id, {
          type: "input_applied", v: Simulation::Protocol::SNAPSHOT_VERSION,
          match: world.id, participant: event[:participant], seq: event[:seq],
          status: "applied", tick: event[:tick]
        })
      end
      rejected.each do |failure|
        MatchChannel.broadcast_event(world.id, {
          type: "input_rejected", v: Simulation::Protocol::SNAPSHOT_VERSION,
          match: world.id, participant: failure[:participant], seq: failure[:seq],
          status: "rejected", reason: failure[:reason].to_s, tick: failure[:tick]
        })
      end
      true
    end

    # Broadcast one complete frame per movement tick, entirely in memory, and
    # persist only every couple of seconds. Broadcasts never wait on a
    # PostgreSQL write, and the simulator cannot drop movement ticks because a
    # jsonb UPDATE + row reload is in flight.
    def publish_snapshots(now: Time.current, monotonic_ms: Simulation::Scheduler.monotonic_ms)
      supervisor.entries.each do |match_id, entry|
        begin
          world = entry.world
          state = [world.tick, world.status]
          last_state = snapshot_broadcast_state[match_id]
          last_at = snapshot_broadcast_at[match_id]
          # A tick advanced, the status changed, or the board has been idle
          # long enough to warrant a re-sync frame.
          due = last_state != state ||
                last_at.nil? ||
                monotonic_ms - last_at >= SNAPSHOT_KEEPALIVE_INTERVAL_MS
          if due
            world.server_time_ms = (now.to_f * 1000).round
            frame = Simulation::Protocol.encode(world)
            # live_frames is the reconnect seed and must always be COMPLETE, so
            # it is written from the full encoding regardless of what goes on the
            # wire.
            live_frames[match_id] = frame
            publish_frame(world, frame)
            snapshot_broadcast_state[match_id] = state
            snapshot_broadcast_at[match_id] = monotonic_ms
          end

          last_persist = snapshot_persist_at[match_id]
          next unless last_persist.nil? || monotonic_ms - last_persist >= SNAPSHOT_PERSIST_INTERVAL_MS

          match = Match.find_by(id: match_id)
          unless match && match.persist_snapshot!(world, token: token, now: now)
            supervisor.detach(match_id)
            forget_match(match_id)
            next
          end
          snapshot_persist_at[match_id] = monotonic_ms
        rescue StandardError => error
          Rails.logger.warn("MatchRunner snapshot broadcast failed match=#{match_id}: " \
                            "#{error.class}: #{error.message}")
        end
      end
    end

    # Step 3 wire policy, in one place.
    #
    # Classic: one complete snapshot per published frame, byte for byte what this
    # method has always sent. Nothing about the Classic stream changes.
    #
    # Responsive: complete snapshots stay the recovery channel, but between them
    # the frame is reduced to the parts that actually moved. A structural change
    # (elimination, freeze/unfreeze, status) or the periodic full interval forces
    # a complete snapshot, because those are exactly the moments a client cannot
    # safely reconstruct from head+length alone.
    def publish_frame(world, full_frame)
      unless world.presentation_strategy == "responsive"
        movement_plan.delete(world.id)
        MatchChannel.broadcast_snapshot(world.id, full_frame)
        return :snapshot
      end

      signature = frame_signature(world)
      plan = movement_plan[world.id]
      due_full = plan.nil? || plan[:signature] != signature ||
                 world.tick - plan[:full_tick] >= MOVEMENT_FULL_INTERVAL_TICKS
      if !due_full && MatchChannel.broadcast_movement(world.id, Simulation::Protocol.encode_movement(world))
        return :movement
      end

      MatchChannel.broadcast_snapshot(world.id, full_frame)
      movement_plan[world.id] = { signature: signature, full_tick: world.tick }
      :snapshot
    ensure
      movement_plan.delete(world.id) if world.status != :running
    end

    def frame_signature(world)
      [world.status, world.end_reason, world.snakes.map { |snake| [snake.alive, snake.frozen?] }]
    end

    def movement_plan
      @movement_plan ||= {}
    end

    def claim_matches(now:, monotonic_ms:, limit:)
      claimed = []
      # With live matches the old scan ran at every 1–30ms wake, even when no
      # match was claimable. First call still claims immediately; subsequent
      # scans are bounded without involving any browser or room leader.
      return claimed if claim_scan_at && monotonic_ms - claim_scan_at < CLAIM_SCAN_INTERVAL_MS
      @claim_scan_at = monotonic_ms
      Match.claimable(now).order(:id).limit(limit).each do |match|
        next if supervisor.attach?(match.id)

        # A match that had started but never checkpointed cannot be replayed
        # from scratch: abandon it rather than silently restarting the round.
        if match.checkpoint.blank? && match.status != "pending"
          # No checkpoint means no recoverable progress. Abandoning would leave
          # the room stuck in_match with a dead match; interrupting returns the
          # lobby to the players and records no fabricated result.
          match.interrupt!(reason: "owner_lost", now: now)
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
      @presence_full_sweep_at = nil
      @orphan_sweep_at = 0
      @room_sweep_at = 0
      @claim_scan_at = nil
      @live_frames = {}
      @movement_plan = {}
      input_poll_at.clear
      snapshot_broadcast_at.clear
      snapshot_broadcast_state.clear
      snapshot_persist_at.clear
      connection_sync_at.clear
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
      @presence_full_sweep_at = nil
      @claim_scan_at = nil
      live_frames.clear
      movement_plan.clear
      input_poll_at.clear
      snapshot_broadcast_at.clear
      snapshot_broadcast_state.clear
      snapshot_persist_at.clear
      connection_sync_at.clear
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
