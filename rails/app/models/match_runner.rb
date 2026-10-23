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
      @supervisor ||= Simulation::Supervisor.new(ownership: Ownership.new(token: token),
                                                 checkpoint_every: CHECKPOINT_EVERY_TICKS)
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
        world.start! if world.pending?
        match.save_progress!(world, token: token, now: now)
        supervisor.attach(world, now_ms: monotonic_ms)
        claimed << match.id
      rescue Simulation::Error, ActiveRecord::RecordInvalid => error
        Rails.logger.warn("MatchRunner could not claim match=#{match.id}: #{error.class}: #{error.message}")
        match.abandon!(reason: "invalid_state") rescue nil
      end
      claimed
    end

    # Test helper: forget in-process worlds (does not release database leases).
    def reset!
      @mutex = Mutex.new
      @supervisor = nil
      @token = nil
      true
    end

    def shutdown!
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
    end

    def complete!(world)
      match = Match.find_by(id: world.id)
      return false unless match

      match.complete_from_world!(world, token: @token)
    end

    def release!(match_id)
      match = Match.find_by(id: match_id)
      return false unless match

      match.release_lease!(token: @token)
    end
  end
end
