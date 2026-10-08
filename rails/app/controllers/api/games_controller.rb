module Api
  # DELETE /api/games/:id — remove one of your own games from your log.
  # The log and the leaderboards are the same data, so a removed game also
  # leaves the leaderboard.
  class GamesController < BaseController
    def destroy
      return render json: { error: "Sign in to remove games" }, status: :unauthorized unless current_user

      # Scoped to the caller, so someone else's id looks exactly like a missing one.
      game = current_user.scores.find_by(id: params[:id])
      return render json: { error: "Game not found" }, status: :not_found unless game

      game.destroy!
      render json: { ok: true }
    end
  end
end
