# The default MUST match public/game.js: opts.cols || 24, opts.rows || 18.
# Browser capabilities are advisory telemetry, NOT authentication or evidence
# of hardware. The server classifies them conservatively and owns the final
# grid. An unreported/stale device never establishes desktop eligibility.
class RoomBoard
  DEFAULT = { columns: 24, rows: 18 }.freeze
  PRESETS = [DEFAULT.merge(key: "classic", label: "Classic · 24 × 18"),
             { key: "roomy", label: "Roomy · 40 × 30", columns: 40, rows: 30 },
             { key: "large", label: "Large · 48 × 36", columns: 48, rows: 36 },
             { key: "arena", label: "Arena · 64 × 48", columns: 64, rows: 48 }].map(&:freeze).freeze
  COLUMNS = (24..96).freeze
  ROWS = (18..72).freeze
  REPORT_TTL = 90
  MAX_CLIENTS = 12
  CLIENT_ID = /\A[a-zA-Z0-9_-]{16,64}\z/

  def self.recommendation(count)
    PRESETS.fetch(count <= 4 ? 0 : count <= 8 ? 1 : count <= 16 ? 2 : 3)
  end

  def self.classify(raw)
    raw = raw.to_unsafe_h if raw.respond_to?(:to_unsafe_h)
    return "unknown" unless raw.is_a?(Hash)

    raw = raw.stringify_keys
    integers = %w[width height screen_width screen_height touch_points]
    flags = %w[coarse fine hover]
    return "unknown" unless integers.all? { |key| raw[key].is_a?(Integer) && raw[key].between?(0, 16384) }
    return "unknown" unless flags.all? { |key| [true, false].include?(raw[key]) }
    return "unknown" if %w[width height screen_width screen_height].any? { |key| raw[key].zero? }
    return "mobile" if raw["width"] < 1024 || raw["screen_width"] < 1024 ||
                       raw["touch_points"].positive? || raw["coarse"] || !raw["fine"] ||
                       !raw["hover"] || raw["mobile_hint"] == true

    "desktop"
  end

  # Any mobile tab wins over desktop tabs belonging to the same identity.
  # Timings are assigned by the server, never accepted from the client.
  def self.device_kind(reports, at: Time.current)
    fresh = reports.to_h.values.select { |report| report["seen_at"].to_i > at.to_i - REPORT_TTL }
    return "unknown" if fresh.empty?
    return "mobile" if fresh.any? { |report| report["kind"] == "mobile" }
    return "unknown" if fresh.any? { |report| report["kind"] == "unknown" }

    fresh.all? { |report| report["kind"] == "desktop" } ? "desktop" : "unknown"
  end

  def self.dimensions!(columns, rows)
    unless columns.is_a?(Integer) && rows.is_a?(Integer) && COLUMNS.cover?(columns) && ROWS.cover?(rows)
      raise ArgumentError, "Board must be 24–96 columns and 18–72 rows (whole numbers)."
    end
    { columns: columns, rows: rows }
  end
end
