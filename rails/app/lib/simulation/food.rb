module Simulation
  # One edible cell. Brawl food is owned by a player (rendered in their color);
  # Duel food belongs to a shared, shrinking supply (owner_id nil).
  #
  # `generation` is identity, not a rule. It starts at 1 and increases by exactly
  # one when that owner's pellet is eaten and respawned. A client can then tell
  # "eaten and replaced" from "still the same pellet" without guessing.
  class Food
    attr_reader :x, :y, :owner_id, :generation

    def initialize(x:, y:, owner_id: nil, generation: 1)
      @x = Integer(x)
      @y = Integer(y)
      @owner_id = owner_id&.to_i
      @generation = Integer(generation)
      raise ArgumentError, "generation must be positive" unless @generation.positive?

      freeze
    end

    def cell
      [x, y]
    end

    def index(columns)
      y * columns + x
    end

    def to_state
      { "x" => x, "y" => y, "owner" => owner_id, "g" => generation }
    end

    def self.from_state(state)
      new(x: state.fetch("x"), y: state.fetch("y"), owner_id: state["owner"],
          generation: state["g"] || 1)
    end
  end
end
