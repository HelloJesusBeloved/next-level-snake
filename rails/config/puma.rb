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

# One simulation loop in the Puma master (single mode) or cluster master; never
# one thread per request or web worker. Every match still requires a renewable
# PostgreSQL lease, so multiple Puma instances arbitrate rather than
# double-stepping a match. Operators running `rails multiplayer:simulate`
# separately can disable this embedded loop with MULTIPLAYER_SIMULATOR=false.
simulator_thread = nil
simulator_stop_mutex = Mutex.new
simulator_stop = false
simulator_stopping = -> { simulator_stop_mutex.synchronize { simulator_stop } }

after_booted do
  enabled = ENV.fetch("MULTIPLAYER_SIMULATOR", "true").to_s.downcase
  unless %w[0 false off no].include?(enabled)
    simulator_thread = Thread.new do
      Thread.current.name = "nls-match-simulator" if Thread.current.respond_to?(:name=)
      until simulator_stopping.call
        begin
          Rails.application.executor.wrap { MatchRunner.tick_once }
        rescue StandardError => error
          Rails.logger.error("Multiplayer simulator pass failed: #{error.class}: #{error.message}")
        end
        sleep 0.05
      end
    end
  end
end

after_stopped do
  simulator_stop_mutex.synchronize { simulator_stop = true }
  simulator_thread&.join(5)
  MatchRunner.shutdown! if defined?(MatchRunner)
end
