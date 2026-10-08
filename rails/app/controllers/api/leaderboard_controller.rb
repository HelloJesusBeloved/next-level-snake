module Api
  # GET /api/leaderboard?board=standard|custom&speed=all|1..6|c|cNN&growth=...
  # Each signed-in player's best run per modifier combination, ranked.
  class LeaderboardController < BaseController
    def index
      board = params[:board] == "custom" ? :custom : :standard
      speed = Score.parse_filter(params[:speed], Score::SPEED_PRESET_RANGE)
      growth = Score.parse_filter(params[:growth], Score::GROWTH_PRESET_RANGE)

      if speed.nil? || growth.nil?
        return render json: { error: "Invalid filter. Use all, a preset number, c, or cNN." },
                      status: :bad_request
      end

      rows = Score.leaderboard(board: board, speed: speed, growth: growth)

      render json: {
        board: board,
        total: rows.first&.total.to_i,
        rows: rows.map do |row|
          {
            username: row.username,
            speed_level: row.speed_level,
            speed_custom: row.speed_custom,
            growth: row.growth,
            growth_custom: row.growth_custom,
            score: row.score,
            created_at: row.created_at
          }
        end
      }
    end
  end
end
