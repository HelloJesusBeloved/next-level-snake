module Simulation
  # Immutable, validated match configuration. Board bounds mirror
  # RoomBoard (the Rails adapter) and the speed presets mirror the LEVELS table
  # in public/game.js. Rails-side tests pin both relationships so the engine and
  # the game page cannot drift silently.
  class Config
    # public/game.js LEVELS: Chill/Easy/Normal/Fast/Insane/Ludicrous.
    SPEED_PRESETS = { 1 => 165, 2 => 130, 3 => 105, 4 => 80, 5 => 60, 6 => 42 }.freeze
    DEFAULT_SPEED_LEVEL = 3
    # Server-side floor: many matches share one process, so sub-frame custom
    # speeds from single player (which may be <16ms) are clamped. Documented.
    MIN_TICK_MS = 40
    MAX_TICK_MS = 1_000
    MIN_GROWTH = 0
    MAX_GROWTH = 100
    DEFAULT_GROWTH = 1
    MIN_COLUMNS = 24
    MAX_COLUMNS = 96
    MIN_ROWS = 18
    MAX_ROWS = 72
    DEFAULT_COLUMNS = 24
    DEFAULT_ROWS = 18
    # Hard ceiling on logical ticks executed in one scheduler pass.
    MAX_CATCHUP_TICKS = 5
    MIN_MAX_TICKS = 10
    MAX_MAX_TICKS = 100_000
    DEFAULT_MAX_TICKS = 1_800

    attr_reader :columns, :rows, :tick_ms, :growth, :mode, :seed, :max_ticks, :speed_level, :rules

    def initialize(columns: DEFAULT_COLUMNS, rows: DEFAULT_ROWS, speed_level: nil, tick_ms: nil,
                   growth: DEFAULT_GROWTH, mode: :brawl, seed: 0, max_ticks: DEFAULT_MAX_TICKS)
      @columns = integer!(columns, MIN_COLUMNS..MAX_COLUMNS, "columns")
      @rows = integer!(rows, MIN_ROWS..MAX_ROWS, "rows")
      @mode = sym!(mode, Rules::MODES, "mode")
      @rules = Rules.for(@mode)
      @speed_level = speed_level.nil? ? nil : integer!(speed_level, SPEED_PRESETS.keys.min..SPEED_PRESETS.keys.max, "speed_level")
      @growth = integer!(growth, MIN_GROWTH..MAX_GROWTH, "growth")
      @seed = integer!(seed, 0..(2**63 - 1), "seed")
      @max_ticks = integer!(max_ticks, MIN_MAX_TICKS..MAX_MAX_TICKS, "max_ticks")
      @tick_ms = resolve_tick_ms(tick_ms)
      freeze
    end

    def to_h
      { columns: columns, rows: rows, speed_level: speed_level, tick_ms: tick_ms,
        growth: growth, mode: mode.to_s, seed: seed, max_ticks: max_ticks }
    end

    private

    def resolve_tick_ms(custom)
      return SPEED_PRESETS.fetch(@speed_level) if @speed_level

      value = custom.nil? ? SPEED_PRESETS.fetch(DEFAULT_SPEED_LEVEL) : custom
      value = Integer(value)
      value.clamp(MIN_TICK_MS, MAX_TICK_MS)
    rescue ArgumentError, TypeError
      raise ConfigError, "tick_ms must be an integer"
    end

    def integer!(value, range, name)
      number = value.is_a?(Integer) ? value : Integer(value)
      raise ConfigError, "#{name} must be within #{range}" unless range.cover?(number)

      number
    rescue ArgumentError, TypeError
      raise ConfigError, "#{name} must be an integer"
    end

    def sym!(value, allowed, name)
      symbol = value.to_s.to_sym
      raise ConfigError, "#{name} must be one of #{allowed.join(', ')}" unless allowed.include?(symbol)

      symbol
    end
  end
end
