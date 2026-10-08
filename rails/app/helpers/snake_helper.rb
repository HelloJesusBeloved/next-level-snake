module SnakeHelper
  # Mirror of public/game.js — one table, two hosts (Rails and the preview).
  SPEED_LEVELS = [
    { id: 1, label: "Chill", ms: 165 },
    { id: 2, label: "Easy", ms: 130 },
    { id: 3, label: "Normal", ms: 105 },
    { id: 4, label: "Fast", ms: 80 },
    { id: 5, label: "Insane", ms: 60 },
    { id: 6, label: "Ludicrous", ms: 42 }
  ].freeze

  MONTHS = %w[Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec].freeze

  def speed_level_for(id)
    SPEED_LEVELS.find { |level| level[:id] == id.to_i } || SPEED_LEVELS[2]
  end

  def speed_description(row)
    return "Custom · #{row.speed_custom} ms" if row.speed_custom.present?

    level = speed_level_for(row.speed_level)
    "#{level[:label]} · #{level[:ms]} ms"
  end

  def growth_description(row)
    return "×#{row.growth_custom} (custom)" if row.growth_custom.present?

    "×#{row.growth}"
  end

  def fmt_date(time)
    return "—" if time.blank?

    "#{time.day} #{MONTHS[time.month - 1]} #{time.year}"
  end
end
