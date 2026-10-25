# Independent per-match Brawl stream. RoomChannel stays the lobby transport;
# this stream carries compact full snapshots, input acknowledgements and
# step-10 connection transitions.
#
# Disconnection is a SERVER concern:
#   * every socket (tab) owns one MatchPresence row; the player is only gone
#     when no fresh row remains, so closing one of several tabs is harmless;
#   * a disconnect writes the authoritative deadline to match_participants and
#     broadcasts it immediately; the leased simulator owner applies the freeze,
#     unfreezes on the deadline (30 s by default) or on reconnection;
#   * on subscribe the channel re-attaches the tab, clears stale queued
#     commands, then seeds the client with a complete authoritative snapshot.
#     It never trusts or replays client-side state from before the gap.
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
    return reject_with("match_interrupted", "That Brawl was interrupted and has no result.") if @match.interrupted?

    @membership = current_membership(@match.room)
    return reject_with("not_a_member", "You are not an active member of this room.") unless @membership

    @participant = @match.match_participants.find_by(room_membership_id: @membership.id)
    @spectator = @participant.nil? || @membership.spectator? || @participant.spectator?
    @socket_token = SecureRandom.uuid
    stream_from self.class.stream_for(@match.id)

    # One row per tab. register_presence! immediately clears a freeze caused by
    # an earlier lost socket and discards commands queued for that connection.
    _presence, reconnected = @match.register_presence!(membership: @membership,
                                                       socket_token: @socket_token)
    @participant = reconnected || @participant
    @membership.mark_seen!
    @match.reconnect_after_game!(membership: @membership) unless @match.live?

    # ONE complete authoritative frame first (never a delta, never a replay of
    # pre-disconnect client state)…
    transmit(seed_payload)
    # …then the explicit status the UI needs for Reconnecting/Resumed/spectator.
    transmit(connection_payload)
  end

  def unsubscribed
    release_presence!
  end

  # Action Cable also tears subscriptions down on a closed socket; keep this
  # idempotent so a normal unsubscribe cannot double-freeze the player.
  def disconnected
    release_presence!
  end

  # Socket heartbeat. Presence goes stale only if EVERY tab stops beating, and
  # the simulator owner's sweeper then starts the authoritative grace window.
  def heartbeat
    now = Time.current
    touch_presence!(now: now)
    transmit({ type: "presence", at: now.iso8601(6), participant: @participant&.id,
               connection: @participant&.connection_state })
  end

  # ActionCable dispatches the untrusted action hash here. There are no actions
  # for client movement/state changes: only Protocol v1 direction intent.
  def input(data)
    touch_presence!(now: Time.current)
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

  # PERFORMANCE (step 10 perf): a direction intent used to cost two extra
  # UPDATEs just to refresh presence, so fast steering produced 7+ write
  # queries per key and contended with the simulator. Presence only needs to
  # be accurate to the presence window (90 s), so writes are throttled per
  # socket; the first intent after a reconnect still refreshes immediately.
  def touch_presence!(now: Time.current)
    last = self.class.presence_touched_at[@socket_token]
    return if last && now.to_f - last < self.class::PRESENCE_WRITE_INTERVAL_SECONDS

    self.class.presence_touched_at[@socket_token] = now.to_f
    MatchPresence.where(socket_token: @socket_token).update_all(last_seen_at: now, updated_at: now) if @socket_token
    @membership&.mark_seen_throttled!(at: now, interval: 15)
    @participant&.update_columns(last_seen_at: now, updated_at: now)
  end

  PRESENCE_WRITE_INTERVAL_SECONDS = 10

  def self.presence_touched_at
    @presence_touched_at ||= {}
  end

  def release_presence!
    return if @presence_released

    @presence_released = true
    return unless @socket_token

    @match&.release_presence!(socket_token: @socket_token, now: Time.current)
  end

  # A reconnecting client is seeded from the latest COMPLETE authoritative
  # frame. That frame already contains every body, score, direction, frozen
  # flag and deadline; the browser never computes them.
  def seed_payload
    payload =
      # Fastest, freshest path: when this Puma process is the leased owner, the
      # in-memory world is current to the tick. Reconnecting players therefore
      # see the true board immediately instead of a frame up to 2 s old.
      if (live = MatchRunner.live_snapshot_for(@match.id))
        live
      elsif @match.live_snapshot.present?
        @match.live_snapshot
      elsif @match.checkpoint.present?
        Simulation::Protocol.encode(@match.build_world)
      else
        { "type" => "waiting", "match" => @match.id, "tick" => @match.tick }
      end
    payload.merge(
      "type" => "snapshot",
      "spectator" => @spectator,
      "spectator_reason" => (@participant.nil? ? "late_join" : (@participant.spectator? ? "eliminated" : nil)),
      "you" => @participant&.id,
      "match_status" => @match.status,
      "grace_seconds" => Match.freeze_grace_seconds,
      "presence_timeout" => Match.presence_stale_seconds
    ).compact
  end

  def connection_payload
    participant = @participant
    {
      type: "connection", match: @match.id, participant: participant&.id,
      state: participant ? participant.connection_state : "spectator",
      spectator: @spectator,
      reason: @spectator && @participant.nil? ? "late_join" : nil,
      frozen: participant ? participant.frozen? : false,
      grace_deadline_at: participant&.freeze_deadline_at&.iso8601(6),
      grace_seconds: Match.freeze_grace_seconds,
      freezes_used: participant&.freeze_windows_used,
      at: Time.current.iso8601(6)
    }.compact
  end

  def input_ack(seq, accepted, reason)
    transmit({ type: "input_ack", match: @match.id, participant: @participant&.id,
               seq: seq, accepted: accepted, reason: reason.to_s })
  end
end
