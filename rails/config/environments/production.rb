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

  # Keep the asset/secret surface small: no host allow-list by default so the
  # game is reachable on whatever hostname or LAN IP you deploy it under.
  config.hosts.clear
end
