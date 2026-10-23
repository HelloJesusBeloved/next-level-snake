module Simulation
  # Final standings. The winning rule is explicit and non-negotiable:
  #
  #   1. FINAL POINTS  (food eaten)          <- primary
  #   2. survival time (completed ticks)     <- first tiebreaker
  #   3. longest snake (cells)               <- second tiebreaker
  #   4. participant id                      <- stable deterministic fallback
  #
  # Survival is deliberately *not* primary: an eliminated player with more
  # points outranks the last snake standing. Tests pin that behaviour.
  module Ranking
    Entry = Struct.new(:id, :name, :color_hex, :color_slot, :score, :survived_ticks,
                       :longest_length, :alive, :eliminated_at_tick, :placement,
                       keyword_init: true) do
      def to_h
        { id: id, name: name, color_hex: color_hex, color_slot: color_slot,
          score: score, survived_ticks: survived_ticks, longest_length: longest_length,
          alive: alive, eliminated_at_tick: eliminated_at_tick, placement: placement }
      end
    end

    def self.rank(snakes)
      ordered = snakes.sort_by do |snake|
        [-snake.score, -snake.survived_ticks, -snake.longest_length, snake.id]
      end
      ordered.each_with_index.map do |snake, index|
        Entry.new(id: snake.id, name: snake.name, color_hex: snake.color_hex,
                  color_slot: snake.color_slot, score: snake.score,
                  survived_ticks: snake.survived_ticks, longest_length: snake.longest_length,
                  alive: snake.alive, eliminated_at_tick: snake.eliminated_at_tick,
                  placement: index + 1)
      end
    end

    def self.winner(snakes)
      rank(snakes).first
    end
  end
end
