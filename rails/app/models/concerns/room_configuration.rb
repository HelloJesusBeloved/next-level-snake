# Step 6: all color/board mutations serialize on the SAME room row used by
# joins/start. Configuration state + version commit together; tiny cable events
# are delivered only after commit. HTTP remains the sole mutation transport.
module RoomConfiguration
  extend ActiveSupport::Concern

  included do
    validates :brawl_columns, numericality: { only_integer: true, in: RoomBoard::COLUMNS }
    validates :brawl_rows, numericality: { only_integer: true, in: RoomBoard::ROWS }
    validate :validate_frozen_configuration
  end

  def reserved_color_slots(except: nil)
    slots = room_memberships.active.where.not(id: except).pluck(:color_slot).compact
    if in_match?
      slots |= Array(match_configuration&.fetch("participants", [])).map { |p| p["color_slot"] }
    end
    slots.uniq
  end

  def available_color_for!(membership)
    taken = reserved_color_slots(except: membership.id)
    available = (0...RoomPalette::CAPACITY).to_a - taken
    if available.size <= RoomPalette::SPARE_OPTIONS
      raise Room::NotJoinable, "Room color capacity reached. Wait for this Brawl to finish or join another room."
    end
    available.include?(membership.color_slot) ? membership.color_slot : available.first
  end

  def palette_payload
    seated = room_memberships.active.pluck(:id, :display_name, :color_slot)
    reserved = reserved_color_slots
    # Grow the offered palette in hue-first blocks as seats/options are used.
    needed = [12, reserved.size + RoomPalette::SPARE_OPTIONS, reserved.max.to_i + 1].max
    count = [(needed / 12.0).ceil * 12, RoomPalette::CAPACITY].min
    { capacity: RoomPalette::CAPACITY, spare: RoomPalette::SPARE_OPTIONS,
      options: (0...count).map do |slot|
        owner = seated.find { |member| member[2] == slot }
        RoomPalette.color(slot).merge(taken_by: owner&.first, player: owner&.second,
                                     locked: reserved.include?(slot) && owner.nil?)
      end }
  end

  def choose_color!(actor, slot)
    with_lock do
      member = configuration_member!(actor)
      raise Room::InvalidTransition, "Colors are locked until this match finishes." if in_match?
      raise Room::InvalidTransition, "This room is closed." if closed?
      unless slot.is_a?(Integer) && palette_payload[:options].any? { |option| option[:slot] == slot }
        raise ArgumentError, "Choose one of the offered color options."
      end
      return member if member.color_slot == slot
      if reserved_color_slots(except: member.id).include?(slot)
        raise Room::InvalidTransition, "That color was just claimed. Choose another color."
      end
      member.update!(color_slot: slot)
      configuration_changed!("member_color", member: member.id)
      member
    end
  end

  def report_capabilities!(actor, client_id:, capabilities:, at: Time.current)
    unless client_id.is_a?(String) && client_id.match?(RoomBoard::CLIENT_ID)
      raise ArgumentError, "A valid per-tab client id is required."
    end
    with_lock do
      member = configuration_member!(actor)
      before = board_payload(at: at)
      reports = member.device_reports.select { |_, report| report["seen_at"].to_i > at.to_i - RoomBoard::REPORT_TTL }
      if !reports.key?(client_id) && reports.size >= RoomBoard::MAX_CLIENTS
        # Bound storage without throwing away a still-mobile tab or granting
        # desktop eligibility to an unreported extra client. The sentinel is
        # not a valid client id and expires only after the overflow stops.
        reports["overflow"] = { "kind" => "unknown", "seen_at" => at.to_i }
      else
        reports[client_id] = { "kind" => RoomBoard.classify(capabilities), "seen_at" => at.to_i }
      end
      member.update_columns(device_reports: reports, last_seen_at: at)
      # Telemetry refreshes do not spam the room, but policy changes do. During
      # a match the frozen board ignores reports; these inform the NEXT round.
      configuration_changed!("board_changed") if before != board_payload(at: at)
      member
    end
  end

  # Presentation is a Brawl renderer choice, separate from game mode. It is
  # room-owned for the next match and can never alter a running match's frozen
  # configuration. As of step 3 BOTH strategies are implemented, so this is a
  # real preference rather than a reserved slot: the host's choice is frozen into
  # the match configuration on start, and the next Brawl may choose differently.
  def update_presentation_strategy!(actor, strategy:)
    selected = strategy.to_s.strip.downcase
    unless Room::PRESENTATION_STRATEGIES.include?(selected)
      raise ArgumentError, "Choose Classic Brawl or Responsive Brawl."
    end

    with_lock do
      member = configuration_member!(actor)
      raise Room::InvalidTransition, "Only the host can change the Brawl presentation." unless host?(member)
      raise Room::InvalidTransition, "Presentation strategy is available only for Brawls." unless mode == "brawl"
      raise Room::InvalidTransition, "The current match is locked. Choose a strategy for the next Brawl." if in_match?
      raise Room::InvalidTransition, "This room is closed." if closed?
      raise Room::InvalidTransition, "Presentation strategy can only be changed for the next Brawl." unless lobby? || finished?

      if presentation_strategy != selected
        update!(presentation_strategy: selected)
        configuration_changed!("presentation_strategy_changed", presentation_strategy: selected)
      end
    end
    self
  end

  def update_board!(actor, columns:, rows:, at: Time.current)
    dimensions = RoomBoard.dimensions!(columns, rows)
    with_lock do
      member = configuration_member!(actor)
      raise Room::InvalidTransition, "Only the host can change the board." unless host?(member)
      raise Room::InvalidTransition, "Only a Brawl lobby can change its board." unless lobby? && mode == "brawl"
      policy = board_payload(at: at)
      raise Room::InvalidTransition, policy[:reason] unless policy[:custom_allowed]
      update!(brawl_columns: dimensions[:columns], brawl_rows: dimensions[:rows])
      configuration_changed!("board_changed")
    end
    self
  end

  def board_payload(at: Time.current)
    players = eligible_players(at: at)
    kinds = players.map { |member| member.device_kind(at: at) }
    all_desktop = kinds.any? && kinds.all? { |kind| kind == "desktop" }
    forced = !all_desktop || mode != "brawl"
    dims = forced ? RoomBoard::DEFAULT : { columns: brawl_columns, rows: brawl_rows }
    frozen = in_match? && match_configuration.present?
    if frozen
      dims = match_configuration.slice("columns", "rows").symbolize_keys
      forced = match_configuration["mobile_default"]
    end
    reason = if frozen
               "This match is locked. Changes and new arrivals apply only to the next Brawl."
             elsif mode != "brawl"
               "Custom dimensions are available only for Brawls."
             elsif !all_desktop
               "Mobile or unverified participation requires the single-player default (24 × 18). All eligible players must report desktop capabilities for custom sizes."
             else
               "All eligible players are on desktop. The host may choose the next Brawl's grid."
             end
    dims.merge(custom_allowed: !frozen && lobby? && !forced, frozen: !!frozen,
               mobile_required: !!forced, reason: reason,
               participants: players.size, mobile: kinds.count("mobile"), unknown: kinds.count("unknown"),
               requested: { columns: brawl_columns, rows: brawl_rows }, presets: RoomBoard::PRESETS,
               recommendation: RoomBoard.recommendation(players.size))
  end

  private

  def configuration_member!(actor)
    member = room_memberships.active.find_by(id: actor&.id)
    raise Room::InvalidTransition, "You are no longer a member of this room." unless member

    member
  end

  def configuration_changed!(event, **fields)
    update_columns(version: version + 1, updated_at: Time.current)
    payload = { code: invitation_code, event: event, v: version }.merge(fields)
    stream = RoomChannel.stream_for(self)
    ActiveRecord.after_all_transactions_commit { ActionCable.server.broadcast(stream, payload) }
  end

  def validate_frozen_configuration
    if persisted? && state_in_database == "in_match" && will_save_change_to_match_configuration?
      errors.add(:match_configuration, "cannot change after the match starts")
    end
    if persisted? && state_in_database == "in_match" && will_save_change_to_presentation_strategy?
      errors.add(:presentation_strategy, "cannot change after the match starts")
    end
  end
end
