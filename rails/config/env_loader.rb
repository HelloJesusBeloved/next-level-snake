# frozen_string_literal: true

# Minimal .env loader — deliberately dependency free (no dotenv gem).
# Values already present in the real environment always win.
env_file = File.expand_path("../.env", __dir__)

if File.exist?(env_file)
  File.foreach(env_file) do |line|
    line = line.strip
    next if line.empty? || line.start_with?("#")

    key, value = line.split("=", 2)
    next if key.nil? || value.nil?

    key = key.strip
    value = value.strip.sub(/\A["']/, "").sub(/["']\z/, "")
    next if key.empty?

    ENV[key] ||= value
  end
end
