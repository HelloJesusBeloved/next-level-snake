module Api
  class ScoresController < BaseController
    # The signed-in player's own best run per modifier combination
    # (empty for guests).
    def index
      render json: { best: best_map(current_user), xp: xp_payload(current_user) }
    end

    # Only signed-in runs are stored. A guest gets a refusal, never a row.
    def create
      unless current_user
        return render json: { error: "Sign in to save your score" }, status: :unauthorized
      end

      record = Score.new(score_params)
      record.user = current_user
      record.end_state = Score.sanitize_end_state(params[:end_state])

      if record.save
        render json: { ok: true, best: best_map(current_user), xp: xp_payload(current_user) },
               status: :created
      else
        render json: { ok: false, error: record.errors.full_messages.first,
                       errors: record.errors.full_messages },
               status: :unprocessable_entity
      end
    end

    private

    def score_params
      {
        score: params[:score].to_i,
        speed_level: optional_int(params[:speed_level]),
        speed_custom: optional_int(params[:speed_custom]),
        growth: optional_int(params[:growth]),
        growth_custom: optional_int(params[:growth_custom]),
        theme: params[:theme].to_s.presence,
        end_state: Score.sanitize_end_state(params[:end_state])
      }
    end

    def optional_int(value)
      value.present? ? value.to_i : nil
    end

    def xp_payload(user)
      return nil unless user

      Score.level_progress(Score.xp_total(user))
    end

    def best_map(user)
      return {} unless user

      Score.where(user_id: user.id).best_per_combo.each_with_object({}) do |row, memo|
        memo[Score.combo_key(row.speed_level, row.speed_custom, row.growth, row.growth_custom)] = row.score
      end
    end
  end
end
