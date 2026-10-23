# The authoritative simulator for this process.
#
# Ownership strategy (documented in docs/multiplayer-step-07-server-engine.md):
# every live match has a database lease (`matches.owner_token` +
# `lease_expires_at`). A process may only attach a match after winning the
# conditional-UPDATE claim, and it renews the lease on every supervisor tick.
# All checkpoint/completion writes are fenced on the token, so an owner that
# paused (GC, laptop suspend, lost network) can never overwrite newer state or
# publish results after another process took over.
#
# The simulation itself runs in memory, one discrete tick at a time. PostgreSQL
# is touched only for the lease and for checkpoints every
# CHECKPOINT_EVERY_TICKS — never once per tick.
class MatchRunner
  LEASE_TTL_SECONDS = 6
  CHECKPOINT_EVERY_TICKS = 20
  MAX_CLAIMS_PER_TICK = 10

  class << self
    def token
      @token ||= SecureRandom.hex(16)
    end

    def supervisor
      @supervisor ||= Simulation::Supervisor.new(
        ownership: Ownership.new(token: token),
        checkpoint_every: CHECKPOINT_EVERY_TICKS,
        on_error: lambda do |match_id, error|
          Rails.logger.error("Match #{match_id} detached after simulation error: " \
                             "#{error.class}: #{error.message}")
        end
      )
    end

    def mutex
      @mutex ||= Mutex.new
    end

    # One scheduler pass: claim free matches, then advance everything owned.
    # `monotonic_ms` is injectable so tests never sleep on a real clock.
    def tick_once(now: Time.current, monotonic_ms: Simulation::Scheduler.monotonic_ms, limit: MAX_CLAIMS_PER_TICK)
      mutex.synchronize do
        claimed = claim_matches(now: now, monotonic_ms: monotonic_ms, limit: limit)
        supervisor.tick!(now_ms: monotonic_ms).merge(claimed: claimed)
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

      match.save_progress!(world, token: @token)
    rescue ActiveRecord::ActiveRecordError => error
      Rails.logger.warn("MatchRunner checkpoint failed for match=#{world.id}: #{error.class}: #{error.message}")
      false
    end

    def complete!(world)
      match = Match.find_by(id: world.id)
      return false unless match

      match.complete_from_world!(world, token: @token)
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
