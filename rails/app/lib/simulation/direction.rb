module Simulation
  # An immutable unit step on the logical grid. Directions are parsed from the
  # short names the client sends ("up", "down", "left", "right"); a client can
  # never submit a raw vector, position or delta.
  class Direction
    NAMES = %w[up down left right].freeze
    VECTORS = {
      "up" => [0, -1].freeze,
      "down" => [0, 1].freeze,
      "left" => [-1, 0].freeze,
      "right" => [1, 0].freeze
    }.freeze

    attr_reader :name, :dx, :dy

    def self.parse(value)
      name = value.to_s.strip.downcase
      raise InvalidInput.new(:invalid_direction, "unknown direction #{value.inspect}") unless NAMES.include?(name)

      new(name, *VECTORS.fetch(name))
    end

    def initialize(name, dx, dy)
      @name = name.to_s.freeze
      @dx = Integer(dx)
      @dy = Integer(dy)
      freeze
    end

    def reverse_of?(other)
      dx == -other.dx && dy == -other.dy
    end

    def same_as?(other)
      dx == other.dx && dy == other.dy
    end

    def to_s
      name
    end
  end
end
