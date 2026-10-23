# Authoritative multiplayer Snake rules (step 7).
#
# This namespace is deliberately plain Ruby: no ActiveRecord, no Action Cable,
# no Rails helpers, no canvas. The rules can be exercised with
#   ruby -Itest test/simulation/world_test.rb
# without booting Rails or opening a WebSocket.
#
# Movement, wrapping, direction-queue rules, growth and scoring mirror the
# verified behaviour of public/game.js (the single-player authority for *rules*,
# never a network authority). See docs/multiplayer-step-07-server-engine.md.
module Simulation
  # Wire/checkpoint format version. Bump when snapshot or input shapes change;
  # mismatched clients are rejected instead of being guessed at.
  VERSION = 1

  class Error < StandardError; end
  class ConfigError < Error; end
  class StateError < Error; end
  class CapacityError < Error; end
  class InvalidInput < Error
    attr_reader :reason

    def initialize(reason, message = nil)
      @reason = reason.to_sym
      super(message || "input rejected: #{reason}")
    end
  end
end
