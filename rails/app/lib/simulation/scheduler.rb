module Simulation
  # Elapsed-time scheduling on a MONOTONIC clock, fully decoupled from network
  # arrivals. One instance belongs to one match owner; the broadcaster decides
  # its own cadence independently.
  #
  # The accumulator is capped so a paused process, a laptop lid or a slow
  # request cannot make a match "catch up" for minutes at once: at most
  # max_catchup_ticks steps run per call and the excess is dropped (and
  # reported) rather than queued forever.
  class Scheduler
    attr_reader :tick_ms, :max_catchup_ticks, :accumulator_ms, :dropped_ticks, :last_at_ms

    def initialize(tick_ms:, max_catchup_ticks: Config::MAX_CATCHUP_TICKS, now_ms: nil)
      raise ArgumentError, "tick_ms must be positive" unless tick_ms.is_a?(Integer) && tick_ms.positive?
      raise ArgumentError, "max_catchup_ticks must be positive" unless max_catchup_ticks.is_a?(Integer) && max_catchup_ticks.positive?

      @tick_ms = tick_ms
      @max_catchup_ticks = max_catchup_ticks
      @accumulator_ms = 0
      @dropped_ticks = 0
      @last_at_ms = now_ms
    end

    # Returns how many logical ticks the caller should run now.
    def advance(now_ms:)
      raise ArgumentError, "monotonic time must be numeric" unless now_ms.is_a?(Numeric)

      if @last_at_ms.nil?
        @last_at_ms = now_ms
        return 0
      end

      delta = now_ms - @last_at_ms
      @last_at_ms = now_ms
      delta = 0 unless delta.is_a?(Numeric) && delta.positive?

      # Cap the *input* delta as well; a long stall must not accumulate credit.
      cap = @tick_ms * @max_catchup_ticks
      if delta > cap
        @dropped_ticks += ((delta - cap) / @tick_ms).floor
        delta = cap
      end
      @accumulator_ms += delta
      steps = (@accumulator_ms / @tick_ms).floor
      if steps > @max_catchup_ticks
        @dropped_ticks += steps - @max_catchup_ticks
        steps = @max_catchup_ticks
        @accumulator_ms = 0
      else
        @accumulator_ms -= steps * @tick_ms
      end
      steps
    end

    def reset!(now_ms: nil)
      @accumulator_ms = 0
      @last_at_ms = now_ms
      self
    end

    # Monotonic milliseconds — never wall-clock, so NTP jumps and DST cannot
    # rewind a match.
    def self.monotonic_ms
      Process.clock_gettime(Process::CLOCK_MONOTONIC, :float_millisecond)
    end
  end
end
