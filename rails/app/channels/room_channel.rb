# The live lobby subscription (step 4).
#
# One stream per room ("rooms:<code>"), shared by every connected member and
# every tab they have open. Events are tiny — { code, event, v, …fields } —
# never a whole roster: PostgreSQL caps a NOTIFY at 8000 bytes, and a client
# that sees a version it does not recognise fetches the authoritative snapshot
# (GET /api/rooms/:code) instead of trusting deltas blindly.
#
# Versioning contract (see rails/docs/multiplayer-transport.md):
#   * every visible change bumps rooms.version exactly once
#   * a client applies an event only when v > its snapshot version
#   * v <= snapshot version -> stale replay, dropped
#   * on (re)connect the snapshot is fetched BEFORE any buffered event applies
class RoomChannel < ApplicationCable::Channel
  def self.stream_for(room)
    "rooms:#{room.invitation_code}"
  end

  # ActionCable's class-level broadcast_to resolves the stream through
  # broadcasting_for, while a subscription names it through stream_for; both
  # must agree or events are emitted onto a stream nobody joined.
  def self.broadcasting_for(room)
    stream_for(room)
  end

  # Emits one already-versioned event. Callers bump rooms.version first (see
  # Room#notify_events!); this method only serialises and broadcasts.
  def self.emit(room, event, fields = {})
    payload = { code: room.invitation_code, event: event, v: room.version }
              .merge(fields || {})
              .compact
    broadcast_to(room, payload)
  end

  # ---- subscription (authorization happens here) -----------------------------

  def subscribed
    @room = Room.find_by_invitation_code(params[:code])
    return reject_with("room_not_found", "That invitation code does not exist. Check it and try again.") unless @room

    # Reading a room may change it (presence drop, host grace, idle expiry).
    # Sweep first so a subscription can never attach to a room that should
    # already be gone, and so clients see that change as an event.
    @room.sweep!
    @room.reload
    return reject_with("room_closed", @room.closed_reason_message) if @room.closed?

    membership = membership_in(@room)
    return reject_with("not_a_member", "You are not in this room.") unless membership&.active?

    stream_from self.class.stream_for(@room)
    membership.mark_seen! # this socket is proof of life right now
  end

  # ---- channel actions (re-authorized on every call) --------------------------

  # The client's heartbeat: keeps presence (and therefore seat and crown
  # stability) alive while the socket is the primary transport. If the seat is
  # gone — kicked, expired, disbanded — the client is told to re-sync through
  # the HTTP API, which is authoritative.
  def heartbeat
    membership = current_membership(@room)
    unless membership
      return transmit({ event: "resync", error: "not_a_member",
                        message: "You are no longer in this room." })
    end

    membership.mark_seen!
    transmit({ event: "heartbeat", v: @room.reload.version })
  end
end
