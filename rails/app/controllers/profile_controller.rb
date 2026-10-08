# The profile page. It is a shell: public/profile.js draws everything from
# GET /api/profile, so there is nothing to load here.
class ProfileController < ApplicationController
  def show
    @username = params[:username]
  end
end
