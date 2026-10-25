# Independent per-match Brawl stream. RoomChannel stays the lobby transport;
# this stream carries compact full snapshots and input acknowledgements. Only
# sessions/guest cookies mapped to frozen match participants may subscribe or
# submit direction intents.
class MatchChannel < ApplicationCable::Channel
  def self.stream_for(match_id)
    "matches:#{Integer(match_id)}"
  end

  def self.broadcast_snapshot(match_id, snapshot)
    ActionCable.server.broadcast(stream_for(match_id), snapshot.merge("type" => "snapshot"))
  end

  def self.broadcast_event(match_id, event)
    ActionCable.server.broadcast(stream_for(match_id), event)
  end

  def subscribed
    @match = Match.find_by(id: params[:match]) if params[:match].to_s.match?(/\A\d+\z/)
    return reject_with("match_not_found", "This Brawl no longer exists.") unless @match
    return reject_with("match_unavailable", "This Brawl is no longer available.") if @match.abandoned?

    @membership = current_membership(@match.room)
    return reject_with("not_a_member", "You are not an active member of this room.") unless @membership

    @participant = @match.match_participants.find_by(room_membership_id: @membership.id)
    # Late joiners (active room members without a frozen seat) watch as
    # spectators: they receive the same authoritative snapshots but every
    # direction intent is refused in #input below.
    @spectator = @participant.nil? || @membership.spectator?
    stream_from self.class.stream_for(@match.id)
    # Seed a reconnect/new tab from the latest complete simulator snapshot.
    if @match.live_snapshot.present?
      transmit(@match.live_snapshot.merge("type" => "snapshot", "spectator" => @spectator))
    elsif @match.checkpoint.present?
      transmit(Simulation::Protocol.encode(@match.build_world).merge("type" => "snapshot", "spectator" => @spectator))
    else
      transmit({ type: "waiting", match: @match.id, tick: @match.tick, spectator: @spectator })
    end
  end

  # ActionCable dispatches the untrusted action hash here. There are no actions
  # for client movement/state changes: only Protocol v1 direction intent.
  def input(data)
    membership = current_membership(@match.room)
    return input_ack(nil, false, :not_a_member) unless membership
    return input_ack(nil, false, :spectator) if membership.spectator?
    participant = @match.match_participants.find_by(room_membership_id: membership.id)
    return input_ack(nil, false, :not_a_participant) unless participant

    input = Simulation::Protocol.parse_input(data.to_h.except("action", :action))
    return input_ack(input.seq, false, :wrong_match) unless input.match_id == @match.id

    outcome = @match.accept_direction!(membership: membership, input: input)
    input_ack(input.seq, outcome == :queued, outcome)
  rescue Simulation::InvalidInput => error
    transmit({ type: "input_ack", accepted: false, reason: error.reason.to_s,
               message: error.message })
  rescue ActiveRecord::RecordNotUnique
    input_ack(input&.seq, false, :stale_sequence)
  rescue ActiveRecord::RecordNotFound
    input_ack(input&.seq, false, :match_unavailable)
  end

  private

  def input_ack(seq, accepted, reason)
    transmit({ type: "input_ack", match: @match.id, participant: @participant&.id,
               seq: seq, accepted: accepted, reason: reason.to_s })
  end
end
