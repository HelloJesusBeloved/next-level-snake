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
    # Strict window for direct in-memory calls (tests, single-process use).
    INPUT_TICK_WINDOW = 2
    # Wide window for DURABLY QUEUED inputs. A client can only name the tick of
    # the last snapshot it received, which is broadcast at 10 Hz while the
    # engine ticks every 40-1000 ms, and which lags the owner's in-memory tick
    # by the checkpoint interval plus scheduler catch-up. Ordering is NOT
    # governed by this tick at all: the durable queue is consumed strictly in
    # per-participant sequence order, one row at a time. The tick only rejects
    # clearly ancient or far-future commands.
    QUEUED_INPUT_TICK_WINDOW = 30
    START_LENGTH = 3

    StepResult = Struct.new(:tick, :status, :eliminated, :eaten, keyword_init: true) do
      def completed?
        status == :completed
      end
    end

    attr_reader :id, :config, :rules, :snakes, :tick, :status, :end_reason,
                :started_at_tick, :ended_at_tick, :columns, :rows, :presentation_strategy,
                :food_events
    # Ticks on which at least one alive snake could actually move. Kept so a
    # fully frozen board is still distinguishable from a live one. It must
    # not finish the match: a duration cap stopped snakes that were still
    # moving.
    attr_accessor :active_ticks
    # Server wall clock (epoch ms) stamped onto each snapshot by the leased
    # owner. Clients may render a countdown from it; they never decide when a
    # freeze starts or ends.
    attr_accessor :server_time_ms
    # Host pause, copied from the match row by the simulator. Not part of the
    # checkpoint: the database columns are the source of truth.
    attr_accessor :host_pause, :host_pause_until_ms, :hidden_participant_ids

    def initialize(id:, config:, participants:, state: nil, presentation_strategy: "classic")
      @id = id
      @presentation_strategy = %w[classic responsive].include?(presentation_strategy.to_s) ?
        presentation_strategy.to_s : "classic"
      @config = config
      @rules = config.rules
      @columns = config.columns
      @rows = config.rows
      @server_time_ms = nil
      @host_pause = nil
      @host_pause_until_ms = nil
      @hidden_participant_ids = []
      @food_events = []
      @responsive_frames = []
      @responsive_noted_tick = nil
      @rng = state ? Rng.restore(state.fetch("rng")) : Rng.new(config.seed)
      @snakes = []
      @shared_food = []
      @active_ticks = 0
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

    def self.restore(id:, config:, participants:, state:, presentation_strategy: "classic")
      new(id: id, config: config, participants: participants, state: state,
          presentation_strategy: presentation_strategy)
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
    def apply_input(player_id:, direction:, tick:, seq:, window: INPUT_TICK_WINDOW)
      snake = snakes.find { |candidate| candidate.id == player_id }
      return :not_a_participant unless snake
      return :match_not_running unless running?
      return :eliminated unless snake.alive
      # Step 10: a disconnected player's commands are never authoritative.
      # Frozen and unattended snakes keep moving (or stay still) without any
      # browser input until the server observes a live connection again.
      return :frozen if snake.frozen?
      return :disconnected unless snake.connection_state == "connected"
      unless tick.is_a?(Integer) && tick.between?(@tick - window, @tick + window)
        return :invalid_tick
      end
      return :stale_sequence unless seq.is_a?(Integer) && seq.positive? && seq > snake.last_seq

      # A valid envelope consumes its sequence number even when the turn itself
      # is ignored (duplicate/reversal/queue full). Otherwise one sequence could
      # be replayed later with a different direction.
      snake.last_seq = seq
      outcome = snake.queue_direction(direction, capacity: rules.max_queued_directions)
      if outcome == :accepted
        snake.last_applied_seq = seq
        # Input is drained immediately before a logical step. Report the exact
        # authoritative movement tick that will consume the queued direction.
        snake.last_applied_tick = @tick + 1
      end
      outcome
    end

    # Responsive only. The browser already moved into `cell`; this queues that
    # cell so the next step can paint it for everyone else. It does not choose
    # a different cell from the direction. `cell` is an [x, y] pair.
    #
    # A cell that is not one orthogonal step is still queued. The client is the
    # authority for its own snake: dropping a report (or the server being a
    # cell behind) must not freeze the snake for the rest of the match. A
    # jump is painted as the cell the browser is actually on.
    def enqueue_pose!(player_id:, cell:, direction:, tick:, seq:)
      snake = snakes.find { |candidate| candidate.id == player_id }
      return :not_a_participant unless snake
      return :match_not_running unless running?
      return :eliminated unless snake.alive
      return :frozen if snake.frozen?
      return :disconnected unless snake.connection_state == "connected"
      return :invalid_tick unless tick.is_a?(Integer) && tick >= 0
      return :stale_sequence unless seq.is_a?(Integer) && seq.positive? && seq > snake.last_seq
      return :pose_queue_full if snake.poses.length >= Snake::MAX_POSE_QUEUE
      return :invalid_cell unless cell.is_a?(Array) && cell.length == 2 &&
                                  cell[0].is_a?(Integer) && cell[1].is_a?(Integer) &&
                                  cell[0].between?(0, @columns - 1) && cell[1].between?(0, @rows - 1)

      snake.last_seq = seq
      snake.enqueue_pose(cell, direction, seq: seq, tick: tick)
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

      # Responsive snakes move only by adopting a cell the browser already
      # stepped into. A direction queued the Classic way must not invent a
      # different corner, and an empty pose queue holds the snake: the server
      # does not keep walking it in a straight line.
      return step_relay! if presentation_strategy == "responsive"

      step_authored!
    end

    # Classic movement. One queued direction, one wrapped cell, then the same
    # collisions and food rules this method has always applied. Responsive
    # matches do not enter here.
    def step_authored!
      raise StateError, "match is #{status}" unless running?

      next_tick = @tick + 1
      @food_events = []
      # Frozen snakes are present but immobile. They are NOT elimination
      # candidates and they never accrue survival ticks while frozen.
      movers = alive_snakes.reject { |snake| snake.frozen? || snake.held? }
      frozen_snakes.each { |snake| snake.frozen_ticks += 1 if snake.alive? }
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
      # Movement progress, not wall-clock passes: frozen-only rounds are idle.
      @active_ticks += 1 if movers.any?
      complete_if_over!
      StepResult.new(tick: @tick, status: status, eliminated: eliminated,
                     eaten: consumed.map { |snake, _food| snake.id })
    end

    # Responsive movement. One queued pose per snake: the cell the browser
    # already entered. A missing pose holds. A pose that is more than one cell
    # away is still adopted — that is a dropped report, not a reason to freeze
    # the snake for the rest of the match. Classic never calls this.
    def step_relay!
      next_tick = @tick + 1
      @food_events = []
      movers = alive_snakes.reject { |snake| snake.frozen? || snake.held? }
      frozen_snakes.each { |snake| snake.frozen_ticks += 1 if snake.alive? }
      targets = {}
      movers.each do |snake|
        pose = snake.poses.first
        next unless pose

        snake.poses.shift
        cell = [pose.cell[0], pose.cell[1]]
        snake.last_applied_seq = pose.seq
        snake.last_applied_tick = next_tick
        # A reload reports the cell this snake already occupies. The head is
        # always in surviving_cells, so painting that report as a step is a
        # self-collision in the open, not only when the head touches the tail.
        next if cell == snake.head

        snake.direction = pose.direction
        targets[snake.id] = cell
      end

      blocking = {}
      targets.each_key { |player_id| blocking[player_id] = player!(player_id).surviving_cells }
      if rules.solid_opponents?
        alive_snakes.each do |snake|
          next if targets.key?(snake.id)

          blocking[snake.id] = snake.body.dup
        end
      end

      eliminated = {}
      targets.each do |player_id, cell|
        snake = player!(player_id)
        # One missed report is two cells along a straight line. The tail
        # would have vacated both by the time the head arrived. Judging the
        # final cell against today's body kills a snake that is exactly as
        # tall as the board: the cell in front of its head is still its body.
        eliminated[player_id] = :self_collision if cells_blocking_reported_arrival(snake, cell).include?(cell)
      end

      if rules.solid_opponents?
        targets.each_key do |player_id|
          next if eliminated.key?(player_id)

          cell = targets.fetch(player_id)
          blocking.each do |other_id, cells|
            next if other_id == player_id
            next unless cells.include?(cell)

            eliminated[player_id] = :body_collision
            break
          end
        end

        movers.select { |snake| targets.key?(snake.id) && !eliminated.key?(snake.id) }
              .group_by { |snake| targets.fetch(snake.id) }
              .each_value do |group|
          next unless group.length > 1

          group.each { |snake| eliminated[snake.id] = :head_on }
        end
      end

      survivors = targets.keys.map { |player_id| player!(player_id) }.reject { |snake| eliminated.key?(snake.id) }
      consumed = consume_food!(survivors, targets, next_tick)
      eaten_growth = consumed.to_h { |snake, _food| [snake.id, config.growth] }
      survivors.each do |snake|
        advance_reported!(snake, targets.fetch(snake.id), growth_added: eaten_growth.fetch(snake.id, 0))
      end
      consumed.each { |_snake, food| @shared_food.delete(food) } if rules.shared_food?
      survivors.each { |snake| snake.survived_ticks += 1 }
      eliminated.each do |player_id, reason|
        player!(player_id).eliminate!(at_tick: next_tick, reason: reason)
      end
      respawn_food!(consumed) if rules.per_player_food?
      shrink_food!(next_tick) if rules.shared_food? && rules.shrinking?

      @tick = next_tick
      @active_ticks += 1 if movers.any?
      complete_if_over!
      StepResult.new(tick: @tick, status: status, eliminated: eliminated,
                     eaten: consumed.map { |snake, _food| snake.id })
    end

    # ---- world information ---------------------------------------------------

    # ---- connection lifecycle (step 10) -------------------------------------
    #
    # Every method below takes SERVER time in epoch milliseconds. The Rails
    # adapter (Match#sync_connection_states!) is the only caller; no state
    # transition is ever driven by the disconnected browser.

    # Freezes an alive snake in place until the server-owned deadline. Position,
    # length, direction, points, food and queued turns are all preserved.
    def freeze_player!(player_id, now_ms:, until_ms:)
      snake = player(player_id)
      return :not_a_participant unless snake
      return :eliminated unless snake.alive?

      snake.freeze!(until_ms: until_ms)
      :frozen
    end

    # Reconnection within grace (or later while still alive): restore control.
    # Poses left by the socket that just died are not steps the new page
    # agreed to. Leaving them queued plays one extra cell. The reloaded page
    # then reports that same cell, and the head blocks it. That death does
    # not depend on the head touching the tail.
    def resume_player!(player_id)
      snake = player(player_id)
      return :not_a_participant unless snake

      # A dead participant reconnects as an eliminated spectator; it can never
      # be handed back control of a body that no longer moves.
      snake.unfreeze!(connection_state: "connected")
      if snake.alive? && presentation_strategy == "responsive"
        snake.poses.clear
        snake.queue.clear
      end
      snake.alive? ? :resumed : :eliminated
    end

    # Grace expired: the snake is UNFROZEN and keeps moving in its last valid
    # direction. It is never eliminated merely for failing to reconnect.
    def release_player!(player_id)
      snake = player(player_id)
      return :not_a_participant unless snake
      return :eliminated unless snake.alive?

      snake.unfreeze!(connection_state: "unattended")
      :released
    end

    # Server-owned deadline sweep: called by the leased owner on its own clock.
    def expire_freezes!(now_ms:)
      released = []
      snakes.each do |snake|
        next unless snake.frozen?
        next if snake.frozen_until_ms.nil? || snake.frozen_until_ms > now_ms

        snake.unfreeze!(connection_state: "unattended")
        released << snake.id
      end
      released
    end

    def frozen_snakes
      snakes.select(&:frozen?)
    end

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

    # Responsive frames are recorded at the tick they describe, then drained by
    # the broadcaster. A catch-up of several steps therefore cannot collapse
    # into one frame: each step has already been encoded. Classic never notes
    # a frame, so its byte stream is untouched.
    def note_responsive_frame!
      return [] unless presentation_strategy == "responsive"
      # A tick is noted once. Draining the buffer for broadcast must not make
      # the next scheduler pass emit the same snapshot again.
      return @responsive_frames if @responsive_noted_tick == tick

      @responsive_noted_tick = tick
      @responsive_frames << Protocol.encode(self)
    end

    def drain_responsive_frames
      frames = @responsive_frames
      @responsive_frames = []
      frames
    end

    # Full checkpoint state — includes queued turns and the RNG cursor so an
    # owner can resume after a lease hand-over without replaying randomness.
    def to_state
      {
        "tick" => @tick, "active_ticks" => @active_ticks,
        "status" => @status.to_s, "reason" => @end_reason&.to_s,
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
      # A round ends when one or fewer snakes are left. It does not end
      # because a clock ran out. The old `tick_limit` (180s of movement)
      # stopped every snake that was still going, which is not a finished
      # brawl. The host can still restart or disband.
      finish!(reason: :last_standing) if snakes.length > 1 && alive_count <= 1
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
        @food_events << {
          owner: snake.id, generation: food.generation, tick: next_tick,
          cell: food.index(@columns)
        }
        [snake, food]
      end
    end

    # Brawl: immediately place a fresh owned food (single-player behaviour).
    def respawn_food!(eaten)
      eaten.each do |snake, food|
        next unless snake.alive?

        snake.food = pick_free_cell&.then { |cell|
          Food.new(x: cell[0], y: cell[1], owner_id: snake.id, generation: food.generation + 1)
        }
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

    # A reported cell that skipped a straight run (a dropped report) still lands
    # on the cell the browser is on. The cells in between are filled and the
    # tail is popped once per skipped step, so the body does not keep a hole
    # plus a stale segment. A turn during the gap is not a straight line: the
    # head still jumps, because inventing the corner would be a guess.
    def advance_reported!(snake, cell, growth_added:)
      gap = straight_intermediates(snake.head, cell)
      if gap && !gap.empty?
        pending = snake.grow - growth_added
        snake.grow = pending.positive? ? pending : 0
        gap.each { |step| snake.advance!(step) }
        snake.grow += growth_added
      end
      snake.advance!(cell)
    end

    # Cells that still block the cell a browser reported, after every tail
    # pop a straight run of that length would have taken. A one-cell step
    # matches Snake#surviving_cells. A skipped straight step frees one more
    # tail cell, so following your own head around a full column lives.
    def cells_blocking_reported_arrival(snake, cell)
      gap = straight_intermediates(snake.head, cell)
      steps = gap.nil? ? 1 : gap.length + 1
      pops = [steps - snake.grow, 0].max
      return snake.body.dup if pops <= 0

      snake.body[0...-pops]
    end

    # Cells strictly between two points on one row or one column, along the
    # short way around the board. Empty when the points are already one step
    # apart. Nil when the jump is diagonal or too long to be one dropped run.
    def straight_intermediates(from, to)
      dx, dy = step_delta(from, to)
      return [] if dx.abs + dy.abs <= 1
      return nil unless dx.zero? || dy.zero?

      distance = dx.abs + dy.abs
      return nil if distance > 8

      sx = dx <=> 0
      sy = dy <=> 0
      x, y = from
      (distance - 1).times.map do
        x = (x + sx) % @columns
        y = (y + sy) % @rows
        [x, y]
      end
    end

    def wrap(x, y)
      [x % @columns, y % @rows]
    end

    # Shortest one-cell delta on the torus, each component in -columns/2..columns/2.
    # [0, 0] is the same cell. Anything whose absolute components sum to 1 is a
    # legal orthogonal step, including a wrap.
    def step_delta(from, to)
      dx = (to[0] - from[0]) % @columns
      dy = (to[1] - from[1]) % @rows
      dx -= @columns if dx * 2 > @columns
      dy -= @rows if dy * 2 > @rows
      [dx, dy]
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

      cells.none? do |cx, cy|
        (-1..1).any? do |dx|
          (-1..1).any? do |dy|
            neighbour = [cx + dx, cy + dy]
            neighbour != [cx, cy] && taken.include?(neighbour)
          end
        end
      end
    end

    def restore_state!(state, participants)
      metadata = participants.to_h { |p| [p.fetch(:id), p] }
      @tick = Integer(state.fetch("tick"))
      @active_ticks = Integer(state.fetch("active_ticks") || @tick)
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
