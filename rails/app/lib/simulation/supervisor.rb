module Simulation
  # In-process registry of matches this process is allowed to simulate, plus the
  # per-match monotonic schedulers. It is intentionally ignorant of Rails: the
  # ownership object is injected and answers whether we still hold a match.
  #
  # Ownership model (implemented by the Rails adapter MatchLease/MatchRunner):
  #   renew!(match_id)      -> true while this process holds the lease
  #   checkpoint!(world)    -> periodic durable snapshot (NOT every tick)
  #   complete!(world)      -> persist final standings + free the lease
  #   release!(match_id)    -> give the lease back without results
  #
  # A process that loses its lease — or whose fenced write is refused — is
  # detached immediately and stops advancing that world, so two Puma workers can
  # never simulate the same match. Errors raised while ticking one match are
  # isolated: they detach that match (fail closed) and never stop the others.
  class Supervisor
    Entry = Struct.new(:world, :scheduler, :last_checkpoint_tick, :last_stepped_at_ms,
                       :last_renewed_at_ms, keyword_init: true)

    attr_reader :ownership, :checkpoint_every, :renew_interval_ms, :entries

    # Renewal is intentionally throttled: the lease is a database write, and the
    # requirement is to keep PostgreSQL out of the tick path. It is still much
    # shorter than the lease TTL, so ownership is refreshed well before it lapses.
    def initialize(ownership:, checkpoint_every: 20, renew_interval_ms: 2_000, on_error: nil, before_step: nil)
      raise ArgumentError, "checkpoint_every must be positive" unless checkpoint_every.is_a?(Integer) && checkpoint_every.positive?
      raise ArgumentError, "renew_interval_ms must not be negative" unless renew_interval_ms.is_a?(Integer) && renew_interval_ms >= 0
      raise ArgumentError, "on_error must respond to #call" if on_error && !on_error.respond_to?(:call)
      raise ArgumentError, "before_step must respond to #call" if before_step && !before_step.respond_to?(:call)

      @ownership = ownership
      @checkpoint_every = checkpoint_every
      @renew_interval_ms = renew_interval_ms
      @on_error = on_error
      @before_step = before_step
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
    # checkpoint and the (throttled) lease renewal.
    def tick!(now_ms: Scheduler.monotonic_ms)
      report = { steps: 0, completed: [], lost: [], checkpoints: [], dropped: {}, errors: [] }
      @entries.values.each do |entry|
        match_id = entry.world.id
        tick_entry(entry, now_ms, report)
      rescue StandardError => error
        # One wedged match must never stop the simulator. Fail closed: detach it
        # (its lease expires and a healthy process can resume from checkpoint).
        report[:errors] << [match_id, "#{error.class}: #{error.message}"]
        @on_error&.call(match_id, error)
        detach(match_id)
      end
      report
    end

    private

    def tick_entry(entry, now_ms, report)
      match_id = entry.world.id

      if renewal_due?(entry, now_ms)
        unless @ownership.renew!(match_id)
          # The lease is gone (expired, stolen, or the database refused us).
          # Stop immediately: never advance a match we cannot prove we own.
          report[:lost] << match_id
          return detach(match_id)
        end
        # Only a SUCCESSFUL renewal advances the clock. Updating this on every
        # pass would keep deferring the next renewal forever, letting the lease
        # expire while this process still simulated the match.
        entry.last_renewed_at_ms = now_ms
      end

      steps = entry.scheduler.advance(now_ms: now_ms)
      report[:dropped][match_id] = entry.scheduler.dropped_ticks if entry.scheduler.dropped_ticks.positive?
      steps.times do
        break unless entry.world.running?
        # Inputs are drained by the owner immediately before each logical tick,
        # never driven by Action Cable arrival timing. Returning false means the
        # database lease disappeared; do not take another simulation step.
        if @before_step && !@before_step.call(entry.world)
          report[:lost] << match_id
          return detach(match_id)
        end

        entry.world.step!
        report[:steps] += 1
        next unless entry.world.completed?

        # Report a completion only when the fenced write actually persisted it.
        # Otherwise another owner must finish from the last checkpoint.
        persisted = @ownership.complete!(entry.world)
        (persisted ? report[:completed] : report[:lost]) << match_id
        return detach(match_id)
      end
      # A world can already be completed when the pass begins (e.g. restored
      # from a final checkpoint). Finalize it even when no step runs this pass.
      if entry.world.completed? && @entries.key?(match_id)
        persisted = @ownership.complete!(entry.world)
        (persisted ? report[:completed] : report[:lost]) << match_id
        return detach(match_id)
      end
      return unless @entries.key?(match_id)

      entry.last_stepped_at_ms = now_ms
      return unless entry.world.tick - entry.last_checkpoint_tick >= checkpoint_every

      if @ownership.checkpoint!(entry.world)
        entry.last_checkpoint_tick = entry.world.tick
        report[:checkpoints] << match_id
      else
        # A refused (fenced) checkpoint means we no longer own the match.
        report[:lost] << match_id
        detach(match_id)
      end
    end

    def renewal_due?(entry, now_ms)
      entry.last_renewed_at_ms.nil? || (now_ms - entry.last_renewed_at_ms) >= renew_interval_ms
    end
  end
end
