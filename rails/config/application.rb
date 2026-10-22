require_relative "boot"

require "rails"
# Only the frameworks this app actually uses: database, controllers, views.
require "active_record/railtie"
require "action_controller/railtie"
require "action_view/railtie"
# Real-time lobby (step 4): Action Cable, auto-mounted at /cable by its engine.
require "action_cable/engine"

# Require the gems listed in Gemfile, including any gems
# you've limited to :test, :development, or :production.
Bundler.require(*Rails.groups)

module Snake
  class Application < Rails::Application
    # Initialize configuration defaults for originally generated Rails version.
    config.load_defaults 8.0

    # The game is timezone agnostic; keep everything on one clock.
    config.time_zone = "UTC"
    config.i18n.default_locale = :en

    # Signed cookie session for username-only accounts. 30 days, like the
    # preview's session table.
    # Application configuration loads before Integer#days is guaranteed to be
    # available. Use plain seconds so a production container boots reliably.
    config.session_store :cookie_store, key: "_snake_session", expire_after: 30 * 24 * 60 * 60

    # No API-only mode: we render HTML with ERB and a couple of JSON endpoints.
    config.api_only = false
  end
end
