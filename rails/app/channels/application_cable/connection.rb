# The WebSocket handshake (step 4). A socket is opened only by somebody the
# server already recognises, using the exact same credentials as the HTTP API:
#
#   * signed-in players  -> session[:user_id] (the existing Rails login cookie)
#   * guests             -> the httpOnly, encrypted snake_guest cookie issued
#                           when they created or joined a room (steps 2/3)
#
# A browser with neither credential is rejected outright. Nothing identity-
# bearing is ever read from the URL, query string, or request body, so a
# client cannot act as another member.
#
# Multi-tab use falls out of this design: every tab of one browser shares one
# guest cookie (one account shares one session), so all of that browser's
# sockets carry the same identity and map to the same single room membership.
# Opening a second socket never creates a second member.
module ApplicationCable
  class Connection < ActionCable::Connection::Base
    identified_by :current_user, :current_guest_session

    def connect
      self.current_user = find_verified_user
      self.current_guest_session = find_verified_guest
      reject_unauthorized_connection unless current_user || current_guest_session
    end

    private

    # Same lookup as ApplicationController#current_user, so a connection
    # cannot out-rank or out-live the session it was opened with.
    def find_verified_user
      user_id = request.session[:user_id]
      user_id ? User.find_by(id: user_id) : nil
    end

    # Cookie reads and token verification live with the credential itself:
    # GuestSession.authenticate resolves only live, unrevoked, unclaimed
    # tokens to their row.
    def find_verified_guest
      GuestSession.authenticate(cookies.encrypted[:snake_guest])
    end
  end
end
