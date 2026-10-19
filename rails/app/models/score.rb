# A finished run. Scores are only ever compared inside the same combination of
# modifiers (speed x growth), so the combination key is stored on the row and
# used for every "best" lookup. Modifiers are either presets
# (speed 1..6, growth 1..5) or custom 0..100 values; a run is "custom mode"
# when at least one modifier is custom and earns its own leaderboard.
#
# Every stored run belongs to a signed-in player. Guest runs are never saved.
class Score < ApplicationRecord
  SPEED_PRESET_RANGE = (1..6).freeze
  GROWTH_PRESET_RANGE = (1..5).freeze
  CUSTOM_RANGE = (0..100).freeze
  MAX_SCORE = 1_000_000
  BOARD_LIMIT = 25
  END_STATE_MAX_DIMENSION = 64

  belongs_to :user

  validates :score, numericality: {
    only_integer: true,
    greater_than_or_equal_to: 0,
    less_than_or_equal_to: MAX_SCORE
  }
  validate :validate_speed!
  validate :validate_growth!
  validate :validate_quit_score!
  before_validation :assign_combo

  def is_custom?
    speed_custom.present? || growth_custom.present?
  end

  # A quit needs more than 10 points to become a logged game. Completed runs
  # continue to power records, rank and XP; eligible quits count only as log entries.
  scope :completed, -> { where("end_state IS NULL OR COALESCE(end_state->>'cause', '') <> 'quit'") }
  scope :recorded, -> { where("end_state IS NULL OR COALESCE(end_state->>'cause', '') <> 'quit' OR score > 10") }

  # Best run for each combination, newest record wins ties.
  scope :best_per_combo, lambda {
    completed.select(
      "DISTINCT ON (speed_level, speed_custom, growth, growth_custom) " \
      "speed_level, speed_custom, growth, growth_custom, score, created_at"
    ).order(
      "speed_level NULLS FIRST, speed_custom NULLS FIRST, " \
      "growth NULLS FIRST, growth_custom NULLS FIRST, score DESC, created_at DESC"
    )
  }

  # Parses a leaderboard filter from the query string into [kind, value]:
  #   "all" -> [:all, nil]      "3"    -> [:preset, 3]
  #   "c"   -> [:custom, nil]   "c42"  -> [:custom, 42]
  # Returns nil for anything else, so callers can answer 400.
  def self.parse_filter(raw, preset_range)
    text = raw.to_s.strip.downcase
    return [:all, nil] if text.empty? || text == "all"
    return [:custom, nil] if text == "c"

    if (match = text.match(/\Ac(\d{1,3})\z/))
      value = match[1].to_i
      return CUSTOM_RANGE.cover?(value) ? [:custom, value] : nil
    end

    if text.match?(/\A\d\z/)
      value = text.to_i
      return preset_range.cover?(value) ? [:preset, value] : nil
    end

    nil
  end

  # One filter dimension -> [sql_fragment, binds]. Column names are fixed
  # constants chosen by the caller; every value is a bound parameter.
  def self.filter_sql(filter, level_column, custom_column)
    kind, value = filter
    case kind
    when :preset then ["#{level_column} = ?", [value]]
    when :custom then value.nil? ? ["#{custom_column} IS NOT NULL", []] : ["#{custom_column} = ?", [value]]
    else ["TRUE", []]
    end
  end

  # Public leaderboard: each player's best run per combination, ranked by score.
  # board: :standard (presets only) or :custom (any custom slider).
  # Each row carries a `total` (the number of matching rows before the limit).
  def self.leaderboard(board: :standard, speed: [:all, nil], growth: [:all, nil], limit: BOARD_LIMIT)
    board_sql =
      if board == :custom
        "(best.speed_custom IS NOT NULL OR best.growth_custom IS NOT NULL)"
      else
        "(best.speed_custom IS NULL AND best.growth_custom IS NULL)"
      end
    speed_sql, speed_binds = filter_sql(speed, "best.speed_level", "best.speed_custom")
    growth_sql, growth_binds = filter_sql(growth, "best.growth", "best.growth_custom")

    sql = <<~SQL.squish
      SELECT
        u.username,
        best.speed_level, best.speed_custom, best.growth, best.growth_custom,
        best.score,
        best.created_at,
        (COUNT(*) OVER ())::int AS total
      FROM (
        SELECT DISTINCT ON (user_id, speed_level, speed_custom, growth, growth_custom)
          user_id, speed_level, speed_custom, growth, growth_custom, score, created_at
        FROM scores
        WHERE end_state IS NULL OR COALESCE(end_state->>'cause', '') <> 'quit'
        ORDER BY user_id,
          speed_level NULLS FIRST, speed_custom NULLS FIRST,
          growth NULLS FIRST, growth_custom NULLS FIRST,
          score DESC, created_at DESC
      ) best
      JOIN users u ON u.id = best.user_id
      WHERE #{board_sql} AND #{speed_sql} AND #{growth_sql}
      ORDER BY best.score DESC, best.created_at ASC
      LIMIT ?
    SQL

    find_by_sql([sql, *speed_binds, *growth_binds, limit])
  end

  # Rebuilds the ending snapshot from validated pieces, or returns nil.
  # Cells are y * cols + x indexes, head first. Never trust the client: a bad
  # snapshot is dropped, and must not stop the score itself from being saved.
  def self.sanitize_end_state(raw)
    raw = raw.to_unsafe_h if raw.respond_to?(:to_unsafe_h)
    return nil unless raw.is_a?(Hash)

    raw = raw.stringify_keys
    cols = raw["cols"]
    rows = raw["rows"]
    dimension = 2..END_STATE_MAX_DIMENSION
    return nil unless cols.is_a?(Integer) && rows.is_a?(Integer)
    return nil unless dimension.cover?(cols) && dimension.cover?(rows)

    cells = cols * rows
    snake = raw["snake"]
    return nil unless snake.is_a?(Array) && snake.length.between?(1, cells)
    return nil unless snake.all? { |cell| cell.is_a?(Integer) && cell >= 0 && cell < cells }
    return nil unless snake.uniq.length == snake.length

    cell_or_nil = ->(value) { value.is_a?(Integer) && value >= 0 && value < cells ? value : nil }
    crash = cell_or_nil.call(raw["crash"])

    {
      "cols" => cols,
      "rows" => rows,
      "snake" => snake,
      "food" => cell_or_nil.call(raw["food"]),
      "crash" => crash,
      "cause" => raw["cause"] == "crash" && crash ? "crash" : "quit"
    }
  end

  # XP counts completed preset runs only: custom sliders and quits earn none.
  # Weights match public/profile.js and src/lib/xp.ts.
  XP_WEIGHT = { 1 => 0.6, 2 => 0.8, 3 => 1.0, 4 => 1.3, 5 => 1.6, 6 => 2.0 }.freeze

  def self.xp_total(user)
    rows = where(user_id: user.id, speed_custom: nil, growth_custom: nil)
           .completed
           .pluck(:score, :speed_level)
    rows.sum do |score, speed_level|
      weight = BigDecimal(XP_WEIGHT.fetch(speed_level, 1.0).to_s)
      (BigDecimal(score) * weight).round(0, :half_up).to_i
    end
  end

  # Level L needs 100*(L-1)^2 cumulative XP (the same curve as src/lib/xp.ts).
  # Keys are camelCase because public/app.js reads them directly.
  def self.level_progress(xp)
    xp = [xp.to_i, 0].max
    level = Math.sqrt(xp / 100.0).floor + 1
    base = 100 * (level - 1)**2
    nxt = 100 * level**2
    span = nxt - base
    into = xp - base
    { xp: xp, level: level, into: into, span: span, toNext: nxt - xp,
      pct: span.zero? ? 0 : into.fdiv(span) }
  end

  def self.combo_key(speed_level, speed_custom, growth, growth_custom)
    s = speed_custom.present? ? "c#{speed_custom}" : speed_level.to_s
    g = growth_custom.present? ? "c#{growth_custom}" : growth.to_s
    "#{s}-#{g}"
  end

  private

  def validate_speed!
    if exactly_one_of?(speed_level, speed_custom)
      errors.add(:speed_level, "must be 1-6") unless speed_level.blank? || SPEED_PRESET_RANGE.include?(speed_level)
      errors.add(:speed_custom, "must be 0-100") unless speed_custom.blank? || CUSTOM_RANGE.include?(speed_custom)
    else
      errors.add(:speed_level, "set exactly one of speed_level or speed_custom")
    end
  end

  def validate_growth!
    if exactly_one_of?(growth, growth_custom)
      errors.add(:growth, "must be 1-5") unless growth.blank? || GROWTH_PRESET_RANGE.include?(growth)
      errors.add(:growth_custom, "must be 0-100") unless growth_custom.blank? || CUSTOM_RANGE.include?(growth_custom)
    else
      errors.add(:growth, "set exactly one of growth or growth_custom")
    end
  end

  def validate_quit_score!
    return unless end_state.is_a?(Hash) && end_state["cause"] == "quit"

    errors.add(:score, "must be over 10 to record a quit") if score.to_i <= 10
  end

  def exactly_one_of?(a, b)
    (a.present? && b.blank?) || (a.blank? && b.present?)
  end

  def assign_combo
    return if speed_level.blank? && speed_custom.blank? && growth.blank? && growth_custom.blank?

    self.combo = self.class.combo_key(speed_level, speed_custom, growth, growth_custom)
  end
end
