module Api
  # GET   /api/profile  — the signed-in player's account and full game log
  # PATCH /api/profile  — { favorite_theme: "violet" | null }
  class ProfileController < BaseController
    # The profile page charts everything it is given, so cap the payload.
    MAX_GAMES = 1000

    def show
      if params[:username].present?
        target_user = User.find_by("LOWER(username) = ?", params[:username].to_s.strip.downcase)
        return render json: { error: "No player with that name" }, status: :not_found unless target_user

        is_you = current_user ? (current_user.id == target_user.id) : false
        return render_profile(target_user, is_you)
      end

      return render_unauthorized("Sign in to see your profile") unless current_user
      render_profile(current_user, true)
    end

    def update
      return render_unauthorized("Sign in to edit your profile") unless current_user
      return render json: { error: "Nothing to update" }, status: :bad_request unless params.key?(:favorite_theme)

      current_user.favorite_theme = params[:favorite_theme].presence

      if current_user.save
        render_profile(current_user, true)
      else
        render json: { error: current_user.errors.full_messages.first || "Unknown theme" },
               status: :bad_request
      end
    end

    private

    def render_profile(user, is_you)
      games = user.scores.order(created_at: :desc, id: :desc).limit(MAX_GAMES)
      
      # Rank calculation: 1 + number of players whose sum of completed scores
      # (excluding quits) is strictly greater.
      # First, find user's total score (completed runs only).
      user_total = user.scores.where("end_state IS NULL OR end_state->>'cause' <> 'quit'").sum(:score)
      
      # Count users who have a strictly greater sum.
      greater_count = Score.find_by_sql([<<-SQL.squish, user_total])
        SELECT COUNT(*) AS count
        FROM (
          SELECT user_id, SUM(score) AS total
          FROM scores
          WHERE (end_state IS NULL OR end_state->>'cause' <> 'quit')
          GROUP BY user_id
          HAVING SUM(score) > ?
        ) ranked
      SQL
      rank = (greater_count.first&.count || 0) + 1

      render json: {
        user: {
          username: user.username,
          favorite_theme: user.favorite_theme,
          created_at: user.created_at,
          rank: rank,
          is_you: is_you,
          games: games.map { |game| game_json(game) }
        }
      }
    end

    def render_unauthorized(message)
      render json: { error: message }, status: :unauthorized
    end

    def game_json(game)
      {
        id: game.id,
        score: game.score,
        speed_level: game.speed_level,
        speed_custom: game.speed_custom,
        growth: game.growth,
        growth_custom: game.growth_custom,
        theme: game.theme,
        end_state: game.end_state,
        created_at: game.created_at
      }
    end
  end
end
