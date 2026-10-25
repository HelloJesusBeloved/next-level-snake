module Api
  # Multiplayer rooms over plain HTTP (step 3). Real-time pushes land in the
  # next step; until then the page polls #current, which doubles as the
  # presence heartbeat and makes an ordinary browser refresh restore the exact
  # room state.
  #
  # Authorization rules, in one place:
  #   * identity comes only from the session cookie or the guest cookie
  #     (RoomIdentity) — never from the request body, so nobody can act as
  #     another member by posting their id or display name;
  #   * host-only actions (start, disband, hand over) go through
  #     #require_host!, which re-reads the host from the database;
  #   * every room read/write first sweeps that room, so presence, host
  #     succession and expiry stay correct without a job runner.
  class RoomsController < BaseController
    include RoomIdentity

    # Order matters: this request is itself a sign of life, so presence is
    # recorded *before* any sweep can decide the caller went quiet.
    before_action :touch_presence!
    before_action :sweep_stale_rooms!, only: %i[create show join current]
    before_action :load_room!, only: %i[show join ready leave start lobby disband transfer_host color capabilities board]

    # POST /api/rooms — create a room and become its host.
    def create
      return if conflicting_membership_blocks_request?

      user, guest = host_identity_for_create
      return if performed?

      room = Room.create_with_host!(
        user: user,
        guest_session: guest,
        display_name: params[:display_name],
        name: params[:name],
        mode: requested_mode,
        settings: params[:settings]
      )
      reset_current_membership!
      render json: state_payload(room, room.host_membership), status: :created
    rescue ActiveRecord::RecordInvalid => e
      render_error("invalid", e.record&.errors&.full_messages&.first || "Could not create the room",
                   :unprocessable_entity)
    rescue Room::NotJoinable => e
      render_error("not_joinable", e.message, :conflict)
    end

    # GET /api/rooms/:code — what an invitation code leads to. Members get the
    # full room state (so a refresh on /multiplayer/CODE is enough); everyone
    # else gets a small, honest preview of what they would be joining.
    def show
      membership = membership_in(@room)
      return render json: state_payload(@room, membership) if membership&.active?

      render json: { room: preview_payload(@room), member: nil, viewer: viewer_payload,
                     config: config_payload }
    end

    # POST /api/rooms/:code/join — join by code (the same path an invitation
    # URL takes). Idempotent for a member who is already seated, which is what
    # makes refreshing and reconnecting safe.
    def join
      return if conflicting_membership_blocks_request?(target: @room)

      user, guest = join_identity
      return if performed?

      membership = @room.join!(user: user, guest_session: guest,
                               display_name: params[:display_name])
      reset_current_membership!
      render json: state_payload(@room.reload, membership)
    rescue Room::NotJoinable => e
      render_not_joinable(e)
    rescue ActiveRecord::RecordInvalid => e
      render_error("invalid", e.record&.errors&.full_messages&.first || "Could not join the room",
                   :unprocessable_entity)
    rescue ActiveRecord::RecordNotUnique
      # Lost a race for the last seat, or for a display name.
      render_error("room_full", "That room just filled up.", :conflict)
    end

    # GET /api/rooms/current — the caller's seat, or nothing. Polled by the
    # page; also the heartbeat that keeps presence alive.
    def current
      membership = current_membership
      unless membership
        return render json: { room: nil, member: nil, viewer: viewer_payload,
                              config: config_payload, notice: last_room_notice }
      end

      room = membership.room
      room.sweep!
      membership.reload
      unless membership.active?
        reset_current_membership!
        return render json: { room: nil, member: nil, viewer: viewer_payload,
                              config: config_payload, notice: departed_notice(room) }
      end

      render json: state_payload(room, membership)
    end

    # POST /api/rooms/:code/ready — advisory readiness vote. The host can
    # start without unanimity; this only moves the caller's own seat.
    def ready
      membership = require_membership!
      return unless membership

      wants_ready = ActiveModel::Type::Boolean.new.cast(params[:ready]) != false
      if membership.state == "playing"
        return render_error("in_match", "You cannot change readiness during a match.", :conflict)
      end

      membership.mark_ready! if wants_ready && membership.state == "joined"
      membership.mark_not_ready! if !wants_ready && membership.state == "ready"
      render json: state_payload(@room.reload, membership.reload)
    rescue RoomMembership::InvalidTransition => e
      render_error("invalid_transition", e.message, :conflict)
    end

    # These writes derive the actor solely from RoomIdentity. member_id,
    # user_id and guest_session_id in request bodies cannot move another seat.
    def color
      member = require_membership!
      return unless member

      member = @room.choose_color!(member, params[:color_slot])
      render json: state_payload(@room, member)
    rescue ArgumentError => e
      render_error("invalid_color", e.message, :unprocessable_entity)
    rescue Room::InvalidTransition, ActiveRecord::RecordNotUnique => e
      render_error("color_conflict", e.message, :conflict)
    end

    def capabilities
      member = require_membership!
      return unless member

      member = @room.report_capabilities!(member, client_id: params[:client_id], capabilities: params[:capabilities])
      render json: state_payload(@room, member)
    rescue ArgumentError => e
      render_error("invalid_capabilities", e.message, :unprocessable_entity)
    rescue Room::InvalidTransition => e
      render_error("not_a_member", e.message, :forbidden)
    end

    def board
      member = require_host!
      return unless member

      @room.update_board!(member, columns: params[:columns], rows: params[:rows])
      render json: state_payload(@room, member)
    rescue ArgumentError => e
      render_error("invalid_board", e.message, :unprocessable_entity)
    rescue Room::InvalidTransition => e
      render_error("board_locked", e.message, :conflict)
    end

    # POST /api/rooms/:code/leave — give up the seat. The guest cookie is
    # deliberately kept, so the same browser can reconnect later.
    def leave
      membership = require_membership!
      return unless membership

      membership.leave!
      reset_current_membership!
      render json: { room: nil, member: nil, left: @room.invitation_code,
                     viewer: viewer_payload, config: config_payload }
    end

    # POST /api/rooms/:code/start — the current host starts a real,
    # server-authoritative Brawl. Ready votes are advisory; the room model
    # rechecks host/eligibility under its lock and freezes board + colors.
    def start
      membership = require_host!
      return unless membership

      # Step 10: a finished room may start the next Brawl directly (no reload,
      # no separate "back to lobby" round trip). Everyone's client switches to
      # the new match id as soon as this returns or RoomChannel announces it.
      rematch = @room.finished?
      @room.start_match!(actor: membership)
      @room.reload
      match = @room.live_match
      participant = match&.match_participants&.find_by(room_membership_id: membership.id)
      render json: state_payload(@room, membership.reload).merge(
        started: true,
        engine_ready: true,
        rematch: rematch,
        match: match&.client_summary(participant_id: participant&.id),
        notice: rematch ? "Next Brawl started — everyone is in the new round." :
                          "Brawl started — points decide the winner."
      ), status: :created
    rescue Room::InvalidTransition => error
      eligibility = @room&.start_eligibility || {}
      status = eligibility[:eligible] ? :conflict : :unprocessable_entity
      render json: { error: error.message,
                     code: eligibility[:eligible] ? "invalid_transition" : "not_eligible",
                     start: eligibility }, status: status
    rescue ActiveRecord::RecordInvalid, ActiveRecord::RecordNotUnique => error
      render_error("start_conflict", error.message, :conflict)
    end

    # POST /api/rooms/:code/lobby — host-only. Returns a finished room to the
    # lobby so another Brawl can start; the completed match is preserved.
    def lobby
      membership = require_host!
      return unless membership

      @room.return_to_lobby!(actor: membership)
      render json: state_payload(@room.reload, membership.reload)
    rescue Room::InvalidTransition => e
      render_error("invalid_transition", e.message, :conflict)
    end

    # POST /api/rooms/:code/disband — host-only. Ends the room for everybody.
    def disband
      membership = require_host!
      return unless membership

      @room.disband!(reason: "host_disbanded")
      reset_current_membership!
      render json: { room: nil, member: nil, disbanded: @room.invitation_code,
                     viewer: viewer_payload, config: config_payload }
    rescue Room::InvalidTransition => e
      render_error("invalid_transition", e.message, :conflict)
    end

    # POST /api/rooms/:code/host — host-only, hand the crown to a named member.
    def transfer_host
      membership = require_host!
      return unless membership

      successor = @room.room_memberships.active.find_by(id: params[:member_id])
      unless successor
        return render_error("member_not_found", "That player is not in this room.", :not_found)
      end

      @room.transfer_host_to!(successor)
      render json: state_payload(@room.reload, membership.reload)
    rescue Room::InvalidTransition => e
      render_error("invalid_transition", e.message, :conflict)
    end

    # POST /api/rooms/claim — attach the guest seat this browser is holding to
    # the account that just signed in (step 2's one-way claim).
    def claim
      unless current_user
        return render_error("unauthorized", "Sign in first.", :unauthorized)
      end

      guest = current_guest_session
      unless guest&.active_membership
        return render_error("nothing_to_claim", "This browser has no guest room to claim.", :not_found)
      end

      membership = guest.active_membership
      membership.claim_by!(current_user)
      forget_guest_session! # the token was revoked by the claim
      reset_current_membership!
      # Same seat, new owner: roster (name, role, position) did not move, so
      # other players only need to know the seat changed hands.
      membership.room.notify_events!([[:member_updated, { member: membership.id }]])
      render json: state_payload(membership.room.reload, membership.reload)
    rescue RoomMembership::ClaimError => e
      render_error("claim_failed", e.message, :conflict)
    end

    private

    # ---- loading and identity ----------------------------------------------

    def load_room!
      @room = Room.find_by_invitation_code(params[:code])
      unless @room
        return render_error("room_not_found",
                            "That invitation code does not exist. Check it and try again.",
                            :not_found)
      end

      @room.sweep!
      @room.reload
      return unless @room.closed?

      render_error("room_closed", @room.closed_reason_message, :gone)
    end

    def sweep_stale_rooms!
      Room.sweep_stale!
    end

    def membership_in(room)
      user, guest = room_identity
      return nil unless user || guest

      room.membership_for(user: user, guest_session: guest)
    end

    # The caller's seat in @room, or a refusal. Used by every member action, so
    # a request can only ever move the seat it actually owns.
    def require_membership!
      membership = membership_in(@room)
      return membership if membership&.active?

      render_error("not_a_member", "You are not in this room.", :forbidden)
      nil
    end

    def require_host!
      membership = require_membership!
      return nil unless membership
      return membership if @room.host?(membership)

      render_error("forbidden", "Only the host can do that.", :forbidden)
      nil
    end

    def host_identity_for_create
      return [current_user, nil] if current_user

      if params[:display_name].to_s.strip.empty?
        render_error("display_name_required", "Enter a name to play as.", :unprocessable_entity)
        return [nil, nil]
      end

      [nil, ensure_guest_session!]
    end

    def join_identity
      return [current_user, nil] if current_user

      if current_guest_session.nil? && params[:display_name].to_s.strip.empty?
        render_error("display_name_required", "Enter a name to play as.", :unprocessable_entity)
        return [nil, nil]
      end

      [nil, ensure_guest_session!]
    end

    # Requirement 12: joining a second room must be a deliberate act. The
    # server refuses with 409 and describes the room you are already in; the
    # page confirms, then retries with leave_current.
    def conflicting_membership_blocks_request?(target: nil)
      membership = current_membership
      return false unless membership&.active?
      return false if target && membership.room_id == target.id

      if ActiveModel::Type::Boolean.new.cast(params[:leave_current])
        membership.leave!
        reset_current_membership!
        return false
      end

      render json: {
        error: "You are already in a room.",
        code: "in_other_room",
        current: {
          code: membership.room.invitation_code,
          name: membership.room.name,
          host: @room.nil? ? membership.host? : membership.host?,
          members: membership.room.active_memberships.size
        }
      }, status: :conflict
      true
    end

    # ---- payloads -----------------------------------------------------------

    def state_payload(room, membership)
      room.with_lock do
        membership&.reload
        current_match = room.matches.order(id: :desc).first
        participant = current_match&.match_participants&.find_by(room_membership_id: membership&.id)
        {
          room: room_payload(room, membership),
          member: membership && member_payload(membership, membership,
                                                match_participant_id: participant&.id,
                                                last_input_seq: participant&.last_input_seq,
                                                connection: participant&.connection_payload),
          viewer: viewer_payload,
          config: config_payload
        }
      end
    end

    def room_payload(room, viewer_membership = nil, at: Time.current)
      members = room.active_memberships.to_a
      match = room.matches.order(id: :desc).first
      participants_by_membership = match ? match.match_participants.index_by(&:room_membership_id) : {}
      {
        code: room.invitation_code,
        # Monotonic state sequence: clients apply an event only when it is
        # exactly one ahead of this, and refetch the snapshot otherwise.
        version: room.version,
        name: room.name,
        mode: room.mode,
        state: room.state,
        max_members: room.max_members,
        settings: room.settings,
        colors: room.palette_payload,
        board: room.board_payload(at: at).then { |policy| policy.merge(editable: room.host?(viewer_membership) && policy[:custom_allowed]) },
        match_configuration: room.match_configuration,
        match: match&.client_summary,
        invite_url: invite_url_for(room),
        created_at: room.created_at,
        members: members.map do |member|
          participant = participants_by_membership[member.id]
          member_payload(member, viewer_membership, at: at,
                         match_participant_id: participant&.id,
                         last_input_seq: participant&.last_input_seq,
                         connection: participant&.connection_payload)
        end,
        counts: {
          members: members.size,
          online: members.count { |member| member.online?(at: at) },
          ready: members.count { |member| member.ready? && !member.spectator? },
          capacity: room.max_members
        },
        start: room.start_eligibility(at: at),
        host_grace_seconds: Room.config.host_grace,
        idle_expiry_seconds: Room.config.room_idle,
        freeze_grace_seconds: Match.freeze_grace_seconds,
        presence_timeout_seconds: Match.presence_stale_seconds
      }
    end

    # Deliberately small: ids are per-room and opaque, and no account names,
    # guest tokens or public ids are exposed to other players.
    def member_payload(member, viewer_membership = nil, at: Time.current,
                       match_participant_id: nil, last_input_seq: nil, connection: nil)
      {
        id: member.id,
        display_name: member.display_name,
        color: member.identity_color,
        spectator: member.spectator?,
        device: member.device_kind(at: at),
        match_participant_id: match_participant_id,
        last_input_seq: last_input_seq,
        connection: connection,
        host: member.host?,
        ready: member.ready?,
        state: member.state,
        online: member.online?(at: at),
        guest: member.guest?,
        joined_at: member.joined_at,
        you: viewer_membership.present? && member.id == viewer_membership.id
      }
    end

    # What a non-member sees for a code before committing to join.
    def preview_payload(room)
      members = room.active_memberships.to_a
      {
        code: room.invitation_code,
        name: room.name,
        mode: room.mode,
        state: room.state,
        joinable: room.joinable? && !room.full?,
        full: room.full?,
        invite_url: invite_url_for(room),
        host_name: room.host_membership&.display_name,
        counts: { members: members.size, capacity: room.max_members }
      }
    end

    def viewer_payload
      {
        signed_in: current_user.present?,
        username: current_user&.username,
        guest: current_user.nil? && current_guest_session.present?
      }
    end

    def config_payload
      { poll_interval: Room.config.poll_interval,
        min_players: Room::MIN_PLAYERS_TO_START,
        # The page needs the trusted origin to decide whether a scanned QR
        # URL is one of this application's room routes (see lobby.js).
        origin: public_origin }
    end

    # Where shareable invitations point. A deployment's configured public
    # origin (MULTIPLAYER_PUBLIC_ORIGIN) always wins, so share links and QR
    # codes carry the address outsiders can reach — never an internal or
    # localhost host — and never trust a spoofable Host header. Without the
    # config we fall back to the request's own origin (dev convenience).
    def public_origin
      Room.config.public_origin.presence || request.base_url
    end

    def invite_url_for(room)
      "#{public_origin}/multiplayer/#{room.invitation_code}"
    end

    # A member whose room vanished under them (host disbanded it, or it
    # expired) polls once more and deserves to be told why, exactly once.
    def last_room_notice
      user, guest = room_identity
      return nil unless user || guest

      scope = user ? user.room_memberships : guest.room_memberships
      recent = scope.where(state: RoomMembership::INACTIVE_STATES)
                    .where(left_at: 1.hour.ago..).order(left_at: :desc).includes(:room).first
      return nil unless recent&.room&.closed?

      recent.room.closed_reason_message
    end

    def departed_notice(room)
      return room.closed_reason_message if room.closed?

      "You were disconnected from that room. Rejoin whenever you like."
    end

    def start_blocker_message(eligibility)
      if eligibility[:blockers].include?("needs_#{Room::MIN_PLAYERS_TO_START}_players")
        "A Brawl needs at least #{Room::MIN_PLAYERS_TO_START} connected players."
      else
        "This room cannot start a Brawl right now."
      end
    end

    # ---- errors --------------------------------------------------------------

    def render_not_joinable(error)
      message = error.message
      code =
        case message
        when /color capacity/i then "color_capacity"
        when /full/ then "room_full"
        when /removed/ then "removed"
        when /guest session/ then "identity_expired"
        else "not_joinable"
        end
      status = code == "removed" ? :forbidden : :conflict
      render_error(code, humanized_join_error(code, message), status)
    end

    def humanized_join_error(code, fallback)
      case code
      when "room_full" then "That room reached the maximum of %s players." % Room.config.max_capacity
      when "removed" then "You were removed from that room."
      when "identity_expired" then "Your guest session expired. Reload the page and try again."
      when "not_joinable" then "That room is not open for joining right now."
      else fallback
      end
    end

    def render_error(code, message, status)
      render json: { error: message, code: code }, status: status
    end

    # ---- params ---------------------------------------------------------------

    # Duels arrive in a later step; only Brawls can be created today. Room
    # size is deliberately NOT a parameter: rooms expand by themselves.
    def requested_mode
      "brawl"
    end
  end
end
