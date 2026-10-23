module Simulation
  # Deterministic xorshift64* — identical sequences on every Ruby/platform for a
  # given seed. Keeping the generator inside the engine (instead of Ruby's
  # Random) makes replays, checkpoints and failure reports reproducible.
  class Rng
    MASK = (2**64) - 1
    MULTIPLIER = 0x2545F4914F6CDD1D
    NON_ZERO = 0x9E3779B97F4A7C15

    attr_reader :state

    def initialize(seed)
      value = Integer(seed) & MASK
      @state = value.zero? ? NON_ZERO : value
    end

    def self.restore(state)
      rng = allocate
      rng.instance_variable_set(:@state, Integer(state) & MASK)
      rng
    end

    def next_u64
      x = @state
      x ^= (x >> 12) & MASK
      x ^= (x << 25) & MASK
      x ^= (x >> 27) & MASK
      @state = x & MASK
      (x * MULTIPLIER) & MASK
    end

    # Uniform-ish index in 0...limit (modulo bias is irrelevant for food/spawns).
    def below(limit)
      raise ArgumentError, "limit must be positive" unless limit.is_a?(Integer) && limit.positive?

      next_u64 % limit
    end

    # In-place Fisher-Yates so candidate order is reproducible.
    def shuffle!(array)
      (array.length - 1).downto(1) do |i|
        j = below(i + 1)
        array[i], array[j] = array[j], array[i]
      end
      array
    end
  end
end
