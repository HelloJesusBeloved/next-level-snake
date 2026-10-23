module Simulation
  # Mode rules for the two multiplayer formats. Balance values are provisional;
  # the important part is that the differences live in data, not in branches
  # scattered through the simulation.
  #
  # brawl: non-solid opponents. Snakes may share cells; only self-collisions
  #        eliminate. Each player owns one food item (in their color) that
  #        respawns immediately, exactly like single player.
  # duel:  solid opponents (head/body contact eliminates) with a shared food
  #        supply that shrinks over time (provisional reading of "shrinking
  #        food": the supply only ever decreases, forcing confrontation).
  class Rules
    MODES = %i[brawl duel].freeze

    attr_reader :mode, :food_policy, :shrink_every_ticks

    def self.for(mode)
      case mode.to_sym
      when :brawl then new(mode: :brawl, solid: false, food_policy: :per_player,
                           shrink_every_ticks: nil)
      when :duel then new(mode: :duel, solid: true, food_policy: :shared,
                          shrink_every_ticks: 120)
      else raise ConfigError, "unknown mode #{mode.inspect}"
      end
    end

    def initialize(mode:, solid:, food_policy:, shrink_every_ticks:)
      @mode = mode.to_sym
      @solid_opponents = solid
      @food_policy = food_policy.to_sym
      @shrink_every_ticks = shrink_every_ticks
      freeze
    end

    def solid_opponents?
      @solid_opponents
    end

    def shared_food?
      food_policy == :shared
    end

    def per_player_food?
      food_policy == :per_player
    end

    # Duel starts with a modest shared supply; brawl never uses this.
    def starting_food_count(players)
      return 0 unless shared_food?

      [[players * 3, 3].max, 12].min
    end

    def shrinking?
      !shrink_every_ticks.nil?
    end
  end
end
