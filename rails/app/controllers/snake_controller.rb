class SnakeController < ApplicationController
  # The whole game lives in one view. public/game.js runs the canvas and
  # public/app.js wires the HUD, scoreboard, modifiers, accounts and the
  # leaderboards to the JSON API, so there is nothing to load here.
  def index; end

  # Lobby shell. public/multiplayer/lobby.js fetches the room state from
  # /api/rooms/*; an invitation code in the path is handed to it through a
  # data attribute so /multiplayer/CODE opens on the right room.
  def multiplayer
    @invitation_code = params[:code].to_s.strip.upcase.delete("-").presence
  end

  # Invitation link. Not the lobby: a name and a join button, then the
  # lobby once the server has seated them.
  def invitation
    @invitation_code = params[:code].to_s.strip.upcase.delete("-")
    @room = Room.find_by_invitation_code(@invitation_code)
    @joinable = @room&.joinable? && !@room.full?
  end
end
