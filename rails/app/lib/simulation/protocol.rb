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
