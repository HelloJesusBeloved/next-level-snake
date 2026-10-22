# Shared behaviour for every multiplayer channel.
#
# The transport is split by concern so later steps can add independent
# subscriptions without touching this one:
#
#   RoomChannel         -> the lobby: membership, readiness, host, room state
#                          (stream "rooms:<code>")
#   (later) BrawlChannel / DuelChannel -> one stream per running match
#                          (e.g. "matches:<id>"), same authorization style,
#                          match-specific rules
#
# Authorization runs on the server for BOTH the subscription
# (RoomChannel#subscribed) and every channel action (e.g. #heartbeat):
# parameters are hints, the identity comes from the connection.
module ApplicationCable
  class Channel < ActionCable::Channel::Base
    private

    # Tells the client *why* it was rejected before dropping the subscription.
    # The client just sent `subscribe` and is still listening, so it can show
    # the real reason ("That room was disbanded by its host.") instead of a
    # generic failure.
    def reject_with(code, message)
      transmit({ error: code, message: message })
      reject
    end

    # The caller's active seat in +room+, or nil. The connection carries at
    # most one identity (a signed-in player is never also treated as a guest).
    def membership_in(room)
      if current_user
        room.membership_for(user: current_user, guest_session: nil)
      elsif current_guest_session
        room.membership_for(user: nil, guest_session: current_guest_session)
      end
    end

    # Fresh read on every action, so a socket whose owner was kicked or whose
    # room was disbanded while idle is refused even if it subscribed earlier.
    def current_membership(room)
      membership = membership_in(room)
      membership&.active? ? membership : nil
    end
  end
end
