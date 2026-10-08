ENV["BUNDLE_GEMFILE"] ||= File.expand_path("../Gemfile", __dir__)

# Load rails/.env before anything reads the environment.
require_relative "env_loader"

require "bundler/setup" # Set up gems listed in the Gemfile.
