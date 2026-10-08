# frozen_string_literal: true

# Load .env before Puma reads PORT / RAILS_ENV.
require_relative "env_loader"

max_threads_count = ENV.fetch("RAILS_MAX_THREADS", 5).to_i
min_threads_count = ENV.fetch("RAILS_MIN_THREADS") { max_threads_count }.to_i
threads min_threads_count, max_threads_count

port ENV.fetch("PORT", 3000)
environment ENV.fetch("RAILS_ENV", "development")

workers ENV.fetch("WEB_CONCURRENCY", 0).to_i
preload_app! if ENV.fetch("WEB_CONCURRENCY", 0).to_i.positive?

# Allow puma to be restarted by `bin/rails restart` command when you restart the server.
plugin :tmp_restart
