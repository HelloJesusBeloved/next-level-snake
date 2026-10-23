module Simulation
  # One player's snake inside a match. All mutable game state lives here; the
  # wire snapshot only ever *reads* it, and client input only ever touches
  # #queue_direction.
  class Snake
    MAX_QUEUED_DIRECTIONS = 2 # matches public/game.js pushDir capacity

    attr_reader :id, :name, :color_hex, :color_slot, :body, :queue
    attr_accessor :direction, :grow, :score, :alive, :eliminated_at_tick,
                  :survived_ticks, :longest_length, :last_seq, :food, :food_eaten_at_tick,
                  :elimination_reason

    def initialize(id:, name:, color_hex:, color_slot:, body:, direction:,
                   grow: 0, score: 0, alive: true, eliminated_at_tick: nil,
                   survived_ticks: 0, longest_length: nil, last_seq: 0,
                   food: nil, food_eaten_at_tick: nil, queue: [],
                   elimination_reason: nil)
      @id = Integer(id)
      @name = name.to_s
      @color_hex = color_hex.to_s
      @color_slot = Integer(color_slot)
      @body = body.map { |cell| [Integer(cell[0]), Integer(cell[1])] }
      @direction = direction
      @grow = Integer(grow)
      @score = Integer(score)
      @alive = alive
      @eliminated_at_tick = eliminated_at_tick
      @survived_ticks = Integer(survived_ticks)
      @longest_length = longest_length || @body.length
      @last_seq = Integer(last_seq)
      @food = food
      @food_eaten_at_tick = food_eaten_at_tick
      @queue = queue.dup
      @elimination_reason = elimination_reason
    end

    def alive?
      @alive
    end

    def head
      body.first
    end

    def length
      body.length
    end

    # Cells that still block movement after this snake takes one step. When the
    # snake is growing the tail stays put, so it blocks too — exactly the
    # `limit = grow > 0 ? length : length - 1` loop in public/game.js.
    def surviving_cells
      grow.positive? ? body.dup : body[0...-1]
    end

    # Direction intake enforces the same rules as the single player:
    # no duplicates, no 180-degree reversal, and at most two queued turns.
    # Returns :accepted or a rejection symbol (the caller reports it).
    def queue_direction(direction)
      reference = queue.last || self.direction
      return :duplicate_direction if direction.same_as?(reference)
      return :reversal if direction.reverse_of?(reference)
      return :queue_full if queue.length >= MAX_QUEUED_DIRECTIONS

      queue << direction
      :accepted
    end

    # Consumes one queued turn at tick time and defends against a reversal that
    # slipped in (neck direction is the final authority).
    def next_direction!
      candidate = queue.shift
      return direction unless candidate
      return direction if direction.reverse_of?(candidate)

      self.direction = candidate
    end

    def advance!(cell)
      body.unshift(cell)
      if grow.positive?
        self.grow -= 1
      else
        body.pop
      end
      self.longest_length = [longest_length, body.length].max
      self
    end

    def eliminate!(at_tick:, reason:)
      self.alive = false
      self.eliminated_at_tick = at_tick
      self.elimination_reason = reason
      self.food = nil
      self.queue.clear
    end

    def occupied_cells
      body
    end

    def to_state
      {
        "id" => id, "name" => name, "color" => color_hex, "slot" => color_slot,
        "body" => body, "dir" => direction.name, "queue" => queue.map(&:name),
        "grow" => grow, "score" => score, "alive" => alive,
        "eliminated_at" => eliminated_at_tick, "reason" => elimination_reason&.to_s,
        "survived" => survived_ticks, "longest" => longest_length,
        "last_seq" => last_seq, "food" => food&.to_state, "ate_at" => food_eaten_at_tick
      }
    end

    def self.from_state(state)
      new(
        id: state.fetch("id"), name: state.fetch("name"), color_hex: state.fetch("color"),
        color_slot: state.fetch("slot"),
        body: state.fetch("body").map { |x, y| [x, y] },
        direction: Direction.parse(state.fetch("dir")),
        queue: Array(state["queue"]).map { |name| Direction.parse(name) },
        grow: state.fetch("grow"), score: state.fetch("score"), alive: state.fetch("alive"),
        eliminated_at_tick: state["eliminated_at"], elimination_reason: state["reason"]&.to_sym,
        survived_ticks: state.fetch("survived"), longest_length: state["longest"],
        last_seq: state["last_seq"], food: state["food"] && Food.from_state(state["food"]),
        food_eaten_at_tick: state["ate_at"]
      )
    end
  end
end
