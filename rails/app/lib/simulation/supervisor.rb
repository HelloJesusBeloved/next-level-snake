module Simulation
  # In-process registry of matches this process is allowed to simulate, plus the
  # per-match monotonic schedulers. It is intentionally ignorant of Rails: the
  # ownership object is injected and answers whether we still hold a match.
  #
  # Ownership model (implemented by the Rails adapter MatchLease):
  #   renew!(match_id)      -> true while this process holds the lease
  #   checkpoint!(world)    -> periodic durable snapshot (NOT every tick)
  #   complete!(world)      -> persist final standings + free the lease
  #   release!(match_id)    -> give the lease back without results
  #
  # A process that loses its lease is detached immediately and stops advancing
  # that world, so two Puma workers can never simulate the same match.
  class Supervisor
    Entry = Struct.new(:world, :scheduler, :last_checkpoint_tick, :last_stepped_at_ms,
                       :last_renewed_at_ms, keyword_init: true)

    attr_reader :ownership, :checkpoint_every, :renew_interval_ms, :entries

    # Renewal is intentionally throttled: the lease is a database write, and the
    # requirement is to keep PostgreSQL out of the tick path. It is still much
    # shorter than the lease TTL, so ownership is refreshed well before it lapses.
    def initialize(ownership:, checkpoint_every: 20, renew_interval_ms: 2_000)
      raise ArgumentError, "checkpoint_every must be positive" unless checkpoint_every.is_a?(Integer) && checkpoint_every.positive?
      raise ArgumentError, "renew_interval_ms must not be negative" unless renew_interval_ms.is_a?(Integer) && renew_interval_ms >= 0

      @ownership = ownership
      @checkpoint_every = checkpoint_every
      @renew_interval_ms = renew_interval_ms
      @entries = {}
    end

    def attach(world, now_ms: Scheduler.monotonic_ms)
      entry = Entry.new(world: world, scheduler: Scheduler.new(tick_ms: world.config.tick_ms, now_ms: now_ms),
                        last_checkpoint_tick: world.tick, last_stepped_at_ms: now_ms,
                        last_renewed_at_ms: now_ms)
      @entries[world.id] = entry
      entry
    end

    def attach?(match_id)
      @entries.key?(match_id)
    end

    def detach(match_id)
      @entries.delete(match_id)
    end

    def match_ids
      @entries.keys
    end

    def shutdown!
      @entries.clear
    end

    # Advances every owned match. Returns a compact report used by the rake
    # loop and by tests. No database work per tick beyond the periodic
    # checkpoint and the (cheap) lease renewal.
    def tick!(now_ms: Scheduler.monotonic_ms)
      report = { steps: 0, completed: [], lost: [], checkpoints: [], dropped: {} }
      @entries.values.each do |entry|
        match_id = entry.world.id
        if renewal_due?(entry, now_ms) && !@ownership.renew!(match_id)
          # The lease is gone (expired, stolen, or the database refused us).
          # Stop immediately: never advance a match we cannot prove we own.
          report[:lost] << match_id
          detach(match_id)
          next
        end
        entry.last_renewed_at_ms = now_ms

        steps = entry.scheduler.advance(now_ms: now_ms)
        report[:dropped][match_id] = entry.scheduler.dropped_ticks if entry.scheduler.dropped_ticks.positive?
        steps.times do
          break unless entry.world.running?

          entry.world.step!
          report[:steps] += 1
          if entry.world.completed?
            @ownership.complete!(entry.world)
            report[:completed] << match_id
            detach(match_id)
            break
          end
        end
        next unless @entries.key?(match_id)

        entry.last_stepped_at_ms = now_ms
        if entry.world.tick - entry.last_checkpoint_tick >= checkpoint_every
          @ownership.checkpoint!(entry.world)
          entry.last_checkpoint_tick = entry.world.tick
          report[:checkpoints] << match_id
        end
      end
      report
    end

    private

    def renewal_due?(entry, now_ms)
      entry.last_renewed_at_ms.nil? || (now_ms - entry.last_renewed_at_ms) >= renew_interval_ms
    end
  end
end
