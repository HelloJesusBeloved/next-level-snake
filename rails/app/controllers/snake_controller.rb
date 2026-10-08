class SnakeController < ApplicationController
  # The whole game lives in one view. public/game.js runs the canvas and
  # public/app.js wires the HUD, scoreboard, modifiers, accounts and the
  # leaderboards to the JSON API, so there is nothing to load here.
  def index; end
end
