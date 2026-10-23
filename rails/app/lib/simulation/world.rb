require "set"

module Simulation
  # One independent match instance. This object is the single source of truth
  # for everything that happens inside a round: it is deliberately free of
  # ActiveRecord, Action Cable, controllers and rendering, and advances only
  # when the owner calls #step! (one discrete logical tick).
  #
  # Rules mirrored from public/game.js:
  #   * head moves one cell, wrapping with modulo on both axes
  #   * at most two queued turns, duplicates and 180-degree reversals ignored
  #   * the tail blocks while growing, otherwise it vacates its cell
  #   * each food is +1 point and += growth segments
  #   * speed is a fixed logical tick interval (server floor in Config)
  #
  # Multiplayer additions (kept in Rules, not sprinkled through the loop):
  #   * brawl: non-solid snakes, per-player colored food that respawns
  #   * duel:  solid snakes and a shared food supply that shrinks
  class World
    STATUSES = %i[pending running paused completed].freeze
    # How many ticks behind the current tick an input may still target. Bounds
    # how long a delayed packet can influence the match.
    INPUT_TICK_WINDOW = 2
    START_LENGTH = 3

    StepResult = Struct.new(:tick, :status, :eliminated, :eaten, keyword_init: true) do
      def completed?
        status == :completed
      end
    end

    attr_reader :id, :config, :rules, :snakes, :tick, :status, :end_reason,
                :started_at_tick, :ended_at_tick, :columns, :rows

    def initialize(id:, config:, participants:, state: nil)
      @id = id
      @config = config
      @rules = config.rules
      @columns = config.columns
      @rows = config.rows
      @rng = state ? Rng.restore(state.fetch("rng")) : Rng.new(config.seed)
      @snakes = []
      @shared_food = []
      if state
        restore_state!(state, participants)
      else
        @tick = 0
        @status = :pending
        @end_reason = nil
        @started_at_tick = nil
        @ended_at_tick = nil
        @snakes = spawn_snakes!(participants)
        seed_food!
      end
    end

    def self.restore(id:, config:, participants:, state:)
      new(id: id, config: config, participants: participants, state: state)
    end

    # ---- lifecycle -----------------------------------------------------------

    def start!
      raise StateError, "match already started" unless pending?

      @status = :running
      @started_at_tick = @tick
      self
    end

    def pause!
      raise StateError, "only a running match can pause" unless running?

      @status = :paused
      self
    end

    def resume!
      raise StateError, "only a paused match can resume" unless paused?

      @status = :running
      self
    end

    # Terminal. Safe to call from a rule (last standing / tick limit) or by the
    # owner (abandoned). Repeated calls are idempotent.
    def finish!(reason: :completed)
      return self if completed?

      @status = :completed
      @end_reason = reason.to_sym
      @ended_at_tick = @tick
      self
    end

    def completed?
      status == :completed
    end

    def running?
      status == :running
    end

    def paused?
      status == :paused
    end

    def pending?
      status == :pending
    end

    def live?
      pending? || running? || paused?
    end

    # ---- input ---------------------------------------------------------------

    # The ONLY mutation a client may request. `player_id` must be derived on the
    # server from the authenticated membership — never from the payload. The
    # engine refuses unknown players, non-running matches, eliminated snakes,
    # stale ticks, replayed sequences and illegal turns.
    def apply_input(player_id:, direction:, tick:, seq:)
      snake = snakes.find { |candidate| candidate.id == player_id }
      return :not_a_participant unless snake
      return :match_not_running unless running?
      return :eliminated unless snake.alive
      return :invalid_tick unless tick.is_a?(Integer) && tick.between?(@tick - INPUT_TICK_WINDOW, @tick + 1)
      return :stale_sequence unless seq.is_a?(Integer) && seq.positive? && seq > snake.last_seq

      outcome = snake.queue_direction(direction)
      snake.last_seq = seq if outcome == :accepted
      outcome
    end

    # Removes a participant from the simulation (left the room / grace expired).
    # Score is frozen as their final points, matching the ranking rule.
    def remove_player!(player_id, reason: :left, at_tick: @tick)
      snake = snakes.find { |candidate| candidate.id == player_id }
      return false unless snake&.alive?

      snake.eliminate!(at_tick: at_tick, reason: reason)
      finish!(reason: :last_standing) if live? && @snakes.length > 1 && alive_count <= 1
      true
    end

    # ---- simulation ----------------------------------------------------------

    def step!
      raise StateError, "match is #{status}" unless running?

      next_tick = @tick + 1
      movers = alive_snakes
      targets = {}
      movers.each do |snake|
        direction = snake.next_direction!
        targets[snake.id] = wrap(snake.head[0] + direction.dx, snake.head[1] + direction.dy)
      end

      blocking = movers.to_h { |snake| [snake.id, snake.surviving_cells] }
      eliminated = {}
      movers.each do |snake|
        eliminated[snake.id] = :self_collision if blocking.fetch(snake.id).include?(targets.fetch(snake.id))
      end

      if rules.solid_opponents?
        movers.each do |snake|
          next if eliminated.key?(snake.id)

          movers.each do |other|
            next if other.id == snake.id || eliminated.key?(other.id)

            if blocking.fetch(other.id).include?(targets.fetch(snake.id))
              eliminated[snake.id] = :body_collision
              break
            end
          end
        end

        movers.reject { |snake| eliminated.key?(snake.id) }
              .group_by { |snake| targets.fetch(snake.id) }
              .each_value do |group|
          next unless group.length > 1

          group.each { |snake| eliminated[snake.id] = :head_on }
        end
      end

      survivors = movers.reject { |snake| eliminated.key?(snake.id) }
      consumed = consume_food!(survivors, targets, next_tick)
      survivors.each { |snake| snake.advance!(targets.fetch(snake.id)) }
      consumed.each { |_snake, food| @shared_food.delete(food) } if rules.shared_food?
      survivors.each { |snake| snake.survived_ticks += 1 }
      eliminated.each do |player_id, reason|
        player!(player_id).eliminate!(at_tick: next_tick, reason: reason)
      end
      respawn_food!(consumed) if rules.per_player_food?
      shrink_food!(next_tick) if rules.shared_food? && rules.shrinking?

      @tick = next_tick
      complete_if_over!
      StepResult.new(tick: @tick, status: status, eliminated: eliminated,
                     eaten: consumed.map { |snake, _food| snake.id })
    end

    # ---- world information ---------------------------------------------------

    def player(player_id)
      snakes.find { |snake| snake.id == player_id }
    end

    def alive_snakes
      snakes.select(&:alive?)
    end

    def alive_count
      alive_snakes.length
    end

    def foods
      rules.per_player_food? ? snakes.filter_map(&:food) : @shared_food.dup
    end

    def standings
      Ranking.rank(snakes)
    end

    def winner
      standings.first
    end

    # Compact, versioned wire snapshot (see Simulation::Protocol).
    def snapshot
      Protocol.encode(self)
    end

    # Full checkpoint state — includes queued turns and the RNG cursor so an
    # owner can resume after a lease hand-over without replaying randomness.
    def to_state
      {
        "tick" => @tick, "status" => @status.to_s, "reason" => @end_reason&.to_s,
        "rng" => @rng.state, "started_at" => @started_at_tick, "ended_at" => @ended_at_tick,
        "snakes" => @snakes.map(&:to_state),
        "shared_food" => @shared_food.map(&:to_state)
      }
    end

    def to_h
      { id: id, tick: tick, status: status, end_reason: end_reason, standings: standings.map(&:to_h) }
    end

    private

    def player!(player_id)
      player(player_id) || raise(StateError, "unknown participant #{player_id}")
    end

    def complete_if_over!
      if snakes.length > 1 && alive_count <= 1
        finish!(reason: :last_standing)
      elsif @tick >= config.max_ticks
        finish!(reason: :tick_limit)
      end
    end

    def consume_food!(survivors, targets, next_tick)
      claimed = []
      survivors.filter_map do |snake|
        target = targets.fetch(snake.id)
        food = rules.per_player_food? ? (snake.food if snake.food&.cell == target) :
                                        @shared_food.find { |item| item.cell == target && !claimed.include?(item) }
        next unless food

        claimed << food

        snake.score += 1
        snake.grow += config.growth
        snake.food_eaten_at_tick = next_tick
        [snake, food]
      end
    end

    # Brawl: immediately place a fresh owned food (single-player behaviour).
    def respawn_food!(eaten)
      eaten.each do |snake, _food|
        next unless snake.alive?

        snake.food = pick_free_cell&.then { |cell| Food.new(x: cell[0], y: cell[1], owner_id: snake.id) }
      end
    end

    # Duel: shared supply only shrinks. Consumption removes the item outright;
    # every shrink_every_ticks the oldest item disappears until one remains.
    def shrink_food!(at_tick)
      return if rules.shrink_every_ticks.nil? || at_tick.zero?
      return unless (at_tick % rules.shrink_every_ticks).zero?

      @shared_food.shift if @shared_food.length > 1
    end

    def seed_food!
      if rules.per_player_food?
        @snakes.each do |snake|
          cell = pick_free_cell
          snake.food = cell && Food.new(x: cell[0], y: cell[1], owner_id: snake.id)
        end
      else
        occupied = Set.new
        rules.starting_food_count(@snakes.length).times do
          cell = pick_free_cell(occupied: occupied)
          break unless cell

          @shared_food << Food.new(x: cell[0], y: cell[1])
          occupied << cell
        end
      end
    end

    def pick_free_cell(occupied: nil)
      taken = occupied ? Set.new(occupied) : Set.new
      snakes.each { |snake| snake.body.each { |cell| taken << cell } }
      foods.each { |food| taken << food.cell }
      free = []
      @rows.times do |y|
        @columns.times do |x|
          cell = [x, y]
          free << cell unless taken.include?(cell)
        end
      end
      return nil if free.empty?

      free[@rng.below(free.length)]
    end

    def wrap(x, y)
      [x % @columns, y % @rows]
    end

    # Deterministic, non-overlapping spawns. Bodies extend left from the head
    # (like single player) and point right into open space. Candidate cells are
    # shuffled with the match RNG so a seed reproduces the exact layout.
    def spawn_snakes!(participants)
      raise CapacityError, "a match needs at least one participant" if participants.empty?

      avoid_adjacent = rules.solid_opponents?
      candidates = (0...@rows).flat_map { |y| (0...@columns).map { |x| [x, y] } }
      @rng.shuffle!(candidates)
      taken = Set.new
      participants.map do |participant|
        head = candidates.find { |cell| spawn_clear?(cell, taken, avoid_adjacent) }
        raise CapacityError, "board too small for #{participants.length} players" unless head

        body = Array.new(START_LENGTH) { |offset| wrap(head[0] - offset, head[1]) }
        body.each { |cell| taken << cell }
        Snake.new(id: participant.fetch(:id), name: participant.fetch(:name),
                  color_hex: participant.fetch(:color_hex), color_slot: participant.fetch(:color_slot),
                  body: body, direction: Direction.parse("right"),
                  longest_length: START_LENGTH)
      end
    end

    def spawn_clear?(head, taken, avoid_adjacent)
      cells = Array.new(START_LENGTH) { |offset| wrap(head[0] - offset, head[1]) }
      return false if cells.any? { |cell| taken.include?(cell) }
      return true unless avoid_adjacent

      cells.any? do |cx, cy|
        (-1..1).any? do |dx|
          (-1..1).any? do |dy|
            neighbour = [cx + dx, cy + dy]
            neighbour != [cx, cy] && taken.include?(neighbour)
          end
        end
      end ? false : true
    end

    def restore_state!(state, participants)
      metadata = participants.to_h { |p| [p.fetch(:id), p] }
      @tick = Integer(state.fetch("tick"))
      @status = state.fetch("status").to_sym
      @end_reason = state["reason"]&.to_sym
      @started_at_tick = state["started_at"]
      @ended_at_tick = state["ended_at"]
      @snakes = state.fetch("snakes").map do |snake_state|
        id = Integer(snake_state.fetch("id"))
        raise StateError, "checkpoint references unknown participant #{id}" unless metadata.key?(id)

        restored = Snake.from_state(snake_state)
        meta = metadata.fetch(id)
        # Frozen database metadata wins over anything in a checkpoint.
        restored.instance_variable_set(:@name, meta.fetch(:name).to_s)
        restored.instance_variable_set(:@color_hex, meta.fetch(:color_hex).to_s)
        restored.instance_variable_set(:@color_slot, Integer(meta.fetch(:color_slot)))
        restored
      end
      @shared_food = Array(state["shared_food"]).map { |f| Food.from_state(f) }
      self
    end
  end
end
