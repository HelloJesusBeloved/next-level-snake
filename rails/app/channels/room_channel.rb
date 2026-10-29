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
    # This socket is proof of life right now. A reconnecting lobby player keeps
    # their seat, their crown (inside host grace) and their prepared colors;
    # nothing about a dropped socket disbands the party.
    @room.touch_member_presence!(membership)
  end

  # ---- channel actions (re-authorized on every call) --------------------------

  # Accept only a direction command. Identity is resolved from the connection
  # and the existing active membership; positions, scores and participant ids
  # remain server-owned. The command is queued durably and applied by the
  # match's single leased simulator owner.
  def input(data)
    membership = current_membership(@room)
    return transmit({ type: "input_ack", v: Simulation::Protocol::SNAPSHOT_VERSION,
                      accepted: false, status: "rejected", reason: "not_a_member" }) unless membership

    match = @room.live_match
    return transmit({ type: "input_ack", v: Simulation::Protocol::SNAPSHOT_VERSION,
                      accepted: false, status: "rejected", reason: "no_live_match" }) unless match

    input = Simulation::Protocol.parse_input(data.to_h.except("action", :action))
    unless input.match_id == match.id
      return transmit({ type: "input_ack", v: Simulation::Protocol::SNAPSHOT_VERSION,
                        match: match.id, participant: match.match_participants.find_by(room_membership_id: membership.id)&.id,
                        seq: input.seq, accepted: false, status: "rejected", reason: "wrong_match",
                        tick: authoritative_tick(match) })
    end

    outcome = match.accept_direction!(membership: membership, input: input)
    participant = match.match_participants.find_by(room_membership_id: membership.id)
    queued = outcome == :queued
    transmit({ type: "input_ack", v: Simulation::Protocol::SNAPSHOT_VERSION,
               match: match.id, participant: participant&.id, seq: input.seq,
               accepted: queued, status: queued ? "queued" : "rejected",
               reason: outcome.to_s, tick: authoritative_tick(match) })
  rescue Simulation::InvalidInput => error
    transmit({ type: "input_ack", v: Simulation::Protocol::SNAPSHOT_VERSION,
               match: @room.live_match&.id, accepted: false, status: "rejected",
               reason: error.reason.to_s, message: error.message })
  rescue ActiveRecord::RecordNotUnique
    transmit({ type: "input_ack", v: Simulation::Protocol::SNAPSHOT_VERSION,
               match: @room.live_match&.id, accepted: false, status: "rejected",
               reason: "stale_sequence" })
  rescue ActiveRecord::RecordNotFound
    transmit({ type: "input_ack", v: Simulation::Protocol::SNAPSHOT_VERSION,
               match: @room.live_match&.id, accepted: false, status: "rejected",
               reason: "match_unavailable" })
  end

  # The client's heartbeat: keeps presence (and therefore seat and crown
  # stability) alive while the socket is the primary transport. If the seat is
  # gone — kicked, expired, disbanded — the client is told to re-sync through
  # the HTTP API, which is authoritative.
  def authoritative_tick(match)
    frame = MatchRunner.live_snapshot_for(match.id)
    ticks = [match.tick, match.snapshot_tick, match.live_snapshot&.dig("t"), frame&.dig("t")]
    ticks.compact.select { |tick| tick.is_a?(Integer) }.max || 0
  end

  def heartbeat
    membership = current_membership(@room)
    unless membership
      return transmit({ event: "resync", error: "not_a_member",
                        message: "You are no longer in this room." })
    end

    @room.touch_member_presence!(membership)
    transmit({ event: "heartbeat", v: @room.reload.version })
  end
end
