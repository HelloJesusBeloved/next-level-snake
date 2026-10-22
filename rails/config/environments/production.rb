require "active_support/core_ext/integer/time"

Rails.application.configure do
  # Settings specified here will take precedence over those in config/application.rb.

  # Code is not reloaded between requests.
  config.enable_reloading = false

  # Eager load code on boot for performance.
  config.eager_load = true

  # Full error pages are not shown to the public.
  config.consider_all_requests_local = false

  # public/ holds the game engine and stylesheet — always serve it.
  config.public_file_server.enabled = true

  # Log to STDOUT so journald picks it up when run under systemd.
  config.logger = ActiveSupport::Logger.new($stdout)
    .tap  { |logger| logger.formatter = Logger::Formatter.new }
    .then { |logger| ActiveSupport::TaggedLogging.new(logger) }
  config.log_tags = [:request_id]
  config.log_level = ENV.fetch("RAILS_LOG_LEVEL", "info")

  # Fallback to the default locale if a translation is missing.
  config.i18n.fallbacks = true

  # Do not dump schema after migrations.
  config.active_record.dump_schema_after_migration = false

  # Set to "true" when terminating TLS in front of Puma (e.g. nginx + certbot).
  config.force_ssl = ENV["RAILS_FORCE_SSL"] == "true"

  # ---- Action Cable (step 4) --------------------------------------------------
  # The page dials the relative /cable path, so behind nginx or a Cloudflare
  # Tunnel the browser upgrades to wss:// on its own once the page is https.
  #
  #   ACTION_CABLE_URL          absolute ws(s):// URL when the socket is served
  #                             from another host/port (e.g. wss://play.example.com/cable)
  #   ACTION_CABLE_ALLOWED_ORIGINS
  #                             comma-separated origins allowed to open a socket
  #                             when a proxy rewrites the origin away from
  #                             REQUEST_URI (defaults to same-origin)
  #   ACTION_CABLE_WORKER_POOL  channel worker threads per process
  config.action_cable.url = ENV["ACTION_CABLE_URL"].presence if ENV["ACTION_CABLE_URL"].present?
  if ENV["ACTION_CABLE_ALLOWED_ORIGINS"].present?
    config.action_cable.allowed_request_origins =
      ENV["ACTION_CABLE_ALLOWED_ORIGINS"].split(",").map(&:strip).reject(&:empty?)
  end
  config.action_cable.worker_pool_size =
    ENV.fetch("ACTION_CABLE_WORKER_POOL", 4).to_i

  # Keep the asset/secret surface small: no host allow-list by default so the
  # game is reachable on whatever hostname or LAN IP you deploy it under.
  config.hosts.clear
end
