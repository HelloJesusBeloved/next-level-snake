Rails.application.routes.draw do
  # Invitation codes are drawn from Room::INVITATION_CODE_ALPHABET; hyphens and
  # lower case are accepted because people retype and paste them by hand
  # (Room.find_by_invitation_code normalizes before looking anything up).
  ROOM_CODE = /[A-Za-z0-9\-]{4,24}/

  root "snake#index"
  get "play", to: "snake#index"
  get "multiplayer", to: "snake#multiplayer", as: :multiplayer
  # Invitation URL: the page opens straight onto the room's join prompt.
  get "multiplayer/:code", to: "snake#multiplayer", as: :multiplayer_room,
      constraints: { code: ROOM_CODE }
  get "profile", to: "profile#show"
  get "profile/:username", to: "profile#show", as: :user_profile

  namespace :api do
    get "scores", to: "scores#index"
    post "scores", to: "scores#create"
    get "leaderboard", to: "leaderboard#index"
    get "profile", to: "profile#show"
    patch "profile", to: "profile#update"
    delete "games/:id", to: "games#destroy"

    # Multiplayer rooms (step 3): plain HTTP; real-time sync comes next.
    post "rooms", to: "rooms#create"
    get "rooms/current", to: "rooms#current"
    post "rooms/claim", to: "rooms#claim"
    get "rooms/:code", to: "rooms#show", constraints: { code: ROOM_CODE }
    post "rooms/:code/join", to: "rooms#join", constraints: { code: ROOM_CODE }
    post "rooms/:code/ready", to: "rooms#ready", constraints: { code: ROOM_CODE }
    post "rooms/:code/color", to: "rooms#color", constraints: { code: ROOM_CODE }
    post "rooms/:code/capabilities", to: "rooms#capabilities", constraints: { code: ROOM_CODE }
    post "rooms/:code/board", to: "rooms#board", constraints: { code: ROOM_CODE }
    post "rooms/:code/leave", to: "rooms#leave", constraints: { code: ROOM_CODE }
    post "rooms/:code/start", to: "rooms#start", constraints: { code: ROOM_CODE }
    post "rooms/:code/lobby", to: "rooms#lobby", constraints: { code: ROOM_CODE }
    post "rooms/:code/disband", to: "rooms#disband", constraints: { code: ROOM_CODE }
    post "rooms/:code/host", to: "rooms#transfer_host", constraints: { code: ROOM_CODE }

    post "auth/signup", to: "auth#signup"
    post "auth/login", to: "auth#login"
    post "auth/logout", to: "auth#logout"
    get "auth/me", to: "auth#me"
  end

  # Liveness probe used by install.sh, compose healthchecks and systemd tooling.
  get "up" => "rails/health#show", as: :rails_health_check
end
