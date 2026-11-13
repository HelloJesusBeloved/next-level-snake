module Api
  class AuthController < BaseController
    def signup
      user = User.new(username: params[:username], password: params[:password])

      if user.save
        reset_session
        session[:user_id] = user.id
        render json: { user: account_json(user) }, status: :created
      else
        status = User.exists?(["LOWER(username) = ?", params[:username].to_s.strip.downcase]) ? :conflict : :unprocessable_entity
        render json: { error: user.errors.full_messages.first || "Could not create the account" }, status: status
      end
    end

    def login
      user = User.authenticate!(params[:username], params[:password])

      if user
        reset_session # session fixation protection
        session[:user_id] = user.id
        render json: { user: account_json(user) }
      else
        render json: { error: "Invalid username or password" }, status: :unauthorized
      end
    end

    def logout
      reset_session
      render json: { ok: true }
    end

    def me
      if current_user
        render json: { user: account_json(current_user) }
      else
        render json: { user: nil }
      end
    end

    private

    def account_json(user)
      {
        username: user.username,
        favorite_theme: user.favorite_theme,
        apply_favorite_theme: user.apply_favorite_theme?
      }
    end
  end
end
