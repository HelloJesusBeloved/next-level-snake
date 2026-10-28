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
    # A Brawl is played on a phone with a swipe pad. A fast L- or Z-shaped
    # gesture can legitimately produce three or four turns inside one movement
    # tick, and dropping the tail of that burst is exactly the "I swiped and the
    # snake went somewhere else" report. Duels keep the single-player depth of
    # two: solid bodies make a deeper buffer a hazard rather than a help.
    BRAWL_QUEUE = 4
    DUEL_QUEUE = 2

    attr_reader :mode, :food_policy, :shrink_every_ticks, :max_queued_directions

    def self.for(mode)
      case mode.to_sym
      when :brawl then new(mode: :brawl, solid: false, food_policy: :per_player,
                           shrink_every_ticks: nil, max_queued_directions: BRAWL_QUEUE)
      when :duel then new(mode: :duel, solid: true, food_policy: :shared,
                          shrink_every_ticks: 120, max_queued_directions: DUEL_QUEUE)
      else raise ConfigError, "unknown mode #{mode.inspect}"
      end
    end

    def initialize(mode:, solid:, food_policy:, shrink_every_ticks:,
                   max_queued_directions: DUEL_QUEUE)
      @mode = mode.to_sym
      @solid_opponents = solid
      @food_policy = food_policy.to_sym
      @shrink_every_ticks = shrink_every_ticks
      @max_queued_directions = Integer(max_queued_directions)
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
