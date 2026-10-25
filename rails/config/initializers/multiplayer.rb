# Multiplayer tuning knobs (step 3). Every value is seconds and can be
# overridden per install through the environment, like DATABASE_* elsewhere.
#
# There is no background job runner in this app (no Sidekiq/Solid Queue), so
# presence, host succession and room expiry are swept lazily on the HTTP
# requests that touch a room — see Room#sweep! and Room.sweep_stale!.
# Real-time pushes arrive in the next step and will reuse the same values.
Rails.application.config.x.multiplayer = ActiveSupport::OrderedOptions.new.tap do |cfg|
  def cfg.seconds(key, default)
    value = ENV[key].to_s.strip
    value.match?(/\A\d+\z/) && value.to_i.positive? ? value.to_i : default
  end

  def cfg.integer(key, default)
    value = ENV[key].to_s.strip
    value.match?(/\A\d+\z/) ? value.to_i : default
  end

  # A member is "online" while seen within this window. The page polls well
  # inside it, so one missed poll does not make somebody vanish.
  cfg.presence_timeout = cfg.seconds("MULTIPLAYER_PRESENCE_TIMEOUT", 90)

  # How long a silent host keeps the crown before leadership passes on.
  # An explicit leave transfers immediately; this covers crashes and closed
  # laptops ("disconnects permanently").
  cfg.host_grace = cfg.seconds("MULTIPLAYER_HOST_GRACE", 120)

  # A silent member keeps their seat this long (so a refresh, a tunnel or a
  # phone call never costs the seat), then the seat is released. Their guest
  # identity survives, so they can rejoin the same row later.
  cfg.member_drop = cfg.seconds("MULTIPLAYER_MEMBER_DROP", 600)

  # An empty, untouched room is disbanded as "expired" after this.
  cfg.room_idle = cfg.seconds("MULTIPLAYER_ROOM_IDLE", 1800)

  # ---- Brawl disconnection handling (step 10) ------------------------------
  # A MatchChannel socket is considered lost once no heartbeat has arrived for
  # this long. Two open tabs keep the player connected as long as either one
  # beats; only losing ALL of them starts the freeze.
  cfg.match_presence_timeout = cfg.seconds("MULTIPLAYER_MATCH_PRESENCE_TIMEOUT", 90)

  # The server-owned grace window. A disconnected snake is frozen exactly this
  # long, then resumes moving in its last valid direction. It is never killed
  # for failing to reconnect.
  cfg.brawl_freeze_grace = cfg.seconds("MULTIPLAYER_BRAWL_FREEZE_GRACE", 30)

  # Anti-abuse: at most this many grace windows per participant per match, and
  # never two within the cooldown. Further drops leave the snake unattended
  # (moving) instead of granting another free freeze.
  cfg.brawl_freeze_windows = cfg.integer("MULTIPLAYER_BRAWL_FREEZE_WINDOWS", 2)
  cfg.brawl_freeze_cooldown = cfg.seconds("MULTIPLAYER_BRAWL_FREEZE_COOLDOWN", 60)

  # A live match with no lease, no recoverable checkpoint and no progress for
  # this long cannot be resumed safely; it is marked interrupted (never with
  # invented standings or a winner). Completed matches are never touched.
  cfg.orphan_match_grace = cfg.seconds("MULTIPLAYER_ORPHAN_MATCH_GRACE", 60)

  # Rooms create small and expand by themselves as players arrive (you are
  # never asked for a size); this is the hard ceiling they can expand into.
  cfg.max_capacity = cfg.seconds("MULTIPLAYER_MAX_ROOM_SIZE", 64)

  # Canonical origin for shareable invitations (share links, QR codes):
  # e.g. "https://play.example.com" — no path, no trailing slash. Set it on
  # real deployments so a share never points at an internal host; unset (or
  # invalid) falls back to the origin the request itself arrived on, which
  # keeps plain localhost development working. Never a hardcoded URL.
  # The parser is a lambda so tests can exercise exactly what production runs.
  cfg.origin_from_env = lambda do |raw|
    value = raw.to_s.strip.chomp("/")
    # scheme + host[:port] only — reject anything that could carry a path,
    # credentials or whitespace into an invitation link.
    value.match?(%r{\Ahttps?://[A-Za-z0-9.-]+(:[0-9]+)?\z}) ? value : nil
  end
  cfg.public_origin = cfg.origin_from_env.call(ENV["MULTIPLAYER_PUBLIC_ORIGIN"])

  # Client poll interval handed to the page (real-time replaces it next step).
  cfg.poll_interval = cfg.seconds("MULTIPLAYER_POLL_INTERVAL", 5)

  # Upper bound on rooms examined by one lazy global sweep.
  cfg.sweep_batch = cfg.seconds("MULTIPLAYER_SWEEP_BATCH", 25)
end
