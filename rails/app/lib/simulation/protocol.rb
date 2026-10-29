module Simulation
  # Compact, versioned wire format. Snapshots are read-only views; inputs are
  # strict — unknown or gameplay-authority fields are rejected, so a browser can
  # never submit a position, score, body or winner.
  module Protocol
    SNAPSHOT_VERSION = VERSION
    INPUT_TYPE = "input".freeze
    INPUT_KEYS = %w[v type match tick seq dir].freeze
    FORBIDDEN_INPUT_KEYS = %w[
      player player_id membership membership_id position positions body bodies cells
      score scores score_delta winner winners alive length grow food head x y
    ].freeze

    Input = Struct.new(:match_id, :direction, :tick, :seq, keyword_init: true)

    module_function

    def encode(world)
      {
        "v" => SNAPSHOT_VERSION,
        "m" => world.id,
        # Presentation metadata only; it never changes the authoritative rules.
        "strategy" => world.presentation_strategy,
        "s" => world.status.to_s,
        "t" => world.tick,
        "r" => world.rules.mode.to_s,
        "b" => { "c" => world.columns, "r" => world.rows },
        "e" => world.end_reason&.to_s,
        "w" => world.winner&.id,
        "q" => world.standings.map { |entry| { "i" => entry.id, "p" => entry.placement,
                                                "sc" => entry.score, "sv" => entry.survived_ticks,
                                                "lg" => entry.longest_length } },
        "p" => world.snakes.map { |snake| encode_player(snake, world.columns) },
        "f" => world.foods.map { |food| encode_food(food, world.columns) },
        # Server wall clock for the grace countdown. The browser may render a
        # countdown from this, but transitions remain server-owned.
        "ts" => (world.server_time_ms || 0)
      }
    end

    def encode_player(snake, columns)
      {
        "i" => snake.id, "n" => snake.name, "c" => snake.color_hex,
        "sc" => snake.score, "l" => snake.length, "a" => snake.alive,
        "d" => snake.direction.name, "b" => snake.body.map { |x, y| y * columns + x },
        "sv" => snake.survived_ticks, "lg" => snake.longest_length,
        # Applied input is separate from the socket's queued acknowledgement.
        # `t` on the frame is the authoritative state version for this match.
        "is" => snake.last_applied_seq, "it" => snake.last_applied_tick,
        "el" => snake.eliminated_at_tick, "er" => snake.elimination_reason&.to_s,
        # Step 10 connection state. "fr" drives the red loading ring on the
        # head; "gu" is the absolute server deadline (epoch ms); "cy" is the
        # server's authoritative connection classification.
        "fr" => snake.frozen?, "gu" => snake.frozen_until_ms, "cy" => snake.connection_state,
        "fz" => snake.frozen_ticks
      }
    end

    def encode_food(food, columns)
      { "c" => food.index(columns), "o" => food.owner_id }
    end

    # ---- step 3: compact, tick-ordered movement frames ----------------------
    #
    # A Brawl broadcasts one frame per movement tick. The overwhelming majority
    # of that traffic was metadata that does not change between ticks: board
    # dimensions, rules mode, standings, names, colours, placement, longest
    # length. A "movement" frame carries only what changes when a snake moves —
    # the head cell, direction, length, score, liveness, freeze state and the
    # food cells — and the browser rebuilds each body from its own confirmed
    # history (segment i follows what segment i-1 vacated).
    #
    # This is lossless for MOVEMENT: the head sequence plus length fully
    # determines the body, so Right -> Up -> Left is preserved turn by turn and
    # wrapping is preserved because the head is a real cell, never a delta.
    # It is NOT self-sufficient: a client that has never seen the match, or that
    # detects a tick gap, needs a complete snapshot. Responsive matches therefore
    # still broadcast full snapshots periodically and on every structural change
    # (elimination, freeze/unfreeze, status), and every client can ask for one
    # with MatchChannel#resync. Classic matches never receive movement frames at
    # all — their byte stream is exactly what it was before step 3.
    MOVEMENT_TYPE = "movement".freeze

    def encode_movement(world)
      {
        "v" => SNAPSHOT_VERSION,
        "type" => MOVEMENT_TYPE,
        "m" => world.id,
        "strategy" => world.presentation_strategy,
        "s" => world.status.to_s,
        "t" => world.tick,
        "ts" => (world.server_time_ms || 0),
        "f" => world.foods.map { |food| encode_food(food, world.columns) },
        "p" => world.snakes.map { |snake| encode_movement_player(snake, world.columns) }
      }
    end

    def encode_movement_player(snake, columns)
      head = snake.body.first
      {
        "i" => snake.id,
        "h" => head && (head[1] * columns + head[0]),
        "d" => snake.direction.name, "l" => snake.length, "sc" => snake.score,
        "a" => snake.alive, "fr" => snake.frozen?, "gu" => snake.frozen_until_ms,
        "cy" => snake.connection_state, "is" => snake.last_applied_seq,
        "it" => snake.last_applied_tick, "el" => snake.eliminated_at_tick,
        "er" => snake.elimination_reason&.to_s
      }
    end

    # Rebuilds a body from a movement frame and the previous confirmed body.
    # Used by the Rails tests to prove the compact frame is lossless, and mirrored
    # exactly by public/multiplayer/playback.js. `len` can only grow by one per
    # tick (Simulation::Snake#advance! moves the head and pops at most one tail
    # cell), so the previous body is the whole story.
    def rebuild_body(head:, length:, previous:)
      return [] if head.nil?
      return [head] if previous.nil? || previous.empty?

      ([head] + Array(previous).first([Integer(length) - 1, 0].max)).first([Integer(length), 1].max)
    end

    # Strictly parses an inbound input message. Raises InvalidInput with a
    # machine-readable reason. Identity (`player_id`) is NOT accepted from the
    # payload: the channel/controller must derive it from the session.
    def parse_input(payload)
      raise InvalidInput.new(:invalid_payload, "input must be an object") unless payload.respond_to?(:to_h)

      data = payload.to_h.transform_keys(&:to_s)
      forbidden = data.keys & FORBIDDEN_INPUT_KEYS
      raise InvalidInput.new(:forbidden_field, "clients may not send #{forbidden.join(', ')}") if forbidden.any?

      unknown = data.keys - INPUT_KEYS
      raise InvalidInput.new(:unknown_field, "unknown fields #{unknown.join(', ')}") if unknown.any?
      raise InvalidInput.new(:invalid_version, "unsupported protocol version") unless data["v"].to_i == SNAPSHOT_VERSION
      raise InvalidInput.new(:invalid_type, "type must be \"input\"") unless data["type"] == INPUT_TYPE

      match_id = data["match"]
      raise InvalidInput.new(:invalid_match) unless match_id.is_a?(Integer) || match_id.to_s.match?(/\A\d+\z/)

      tick = data["tick"]
      raise InvalidInput.new(:invalid_tick) unless tick.is_a?(Integer) && tick >= 0

      seq = data["seq"]
      raise InvalidInput.new(:invalid_sequence) unless seq.is_a?(Integer) && seq.positive?

      Input.new(match_id: match_id.to_i, direction: Direction.parse(data["dir"]), tick: tick, seq: seq)
    end
  end
end
