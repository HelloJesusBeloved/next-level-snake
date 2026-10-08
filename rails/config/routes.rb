Rails.application.routes.draw do
  root "snake#index"
  get "play", to: "snake#index"
  get "profile", to: "profile#show"
  get "profile/:username", to: "profile#show", as: :user_profile

  namespace :api do
    get "scores", to: "scores#index"
    post "scores", to: "scores#create"
    get "leaderboard", to: "leaderboard#index"
    get "profile", to: "profile#show"
    patch "profile", to: "profile#update"
    delete "games/:id", to: "games#destroy"

    post "auth/signup", to: "auth#signup"
    post "auth/login", to: "auth#login"
    post "auth/logout", to: "auth#logout"
    get "auth/me", to: "auth#me"
  end

  # Liveness probe used by install.sh, compose healthchecks and systemd tooling.
  get "up" => "rails/health#show", as: :rails_health_check
end
