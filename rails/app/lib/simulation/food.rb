module Simulation
  # One edible cell. Brawl food is owned by a player (rendered in their color);
  # Duel food belongs to a shared, shrinking supply (owner_id nil).
  class Food
    attr_reader :x, :y, :owner_id

    def initialize(x:, y:, owner_id: nil)
      @x = Integer(x)
      @y = Integer(y)
      @owner_id = owner_id&.to_i
      freeze
    end

    def cell
      [x, y]
    end

    def index(columns)
      y * columns + x
    end

    def to_state
      { "x" => x, "y" => y, "owner" => owner_id }
    end

    def self.from_state(state)
      new(x: state.fetch("x"), y: state.fetch("y"), owner_id: state["owner"])
    end
  end
end
