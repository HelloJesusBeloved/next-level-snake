namespace :multiplayer do
  desc "Advance the authoritative simulation once (claims free matches)"
  task tick: :environment do
    report = MatchRunner.tick_once
    puts "claimed=#{report[:claimed].inspect} steps=#{report[:steps]} " \
         "completed=#{report[:completed].inspect} lost=#{report[:lost].inspect} " \
         "checkpoints=#{report[:checkpoints].inspect} errors=#{report[:errors].inspect}"
  end

  desc "Run the authoritative simulator until interrupted (one owner per match)"
  task simulate: :environment do
    stopping = false
    %w[INT TERM].each { |signal| trap(signal) { stopping = true } }
    puts "Simulating matches as owner token #{MatchRunner.token}. Ctrl-C to stop."
    until stopping
      begin
        report = MatchRunner.tick_once
        if report[:steps].positive? || report[:completed].any? || report[:claimed].any? ||
           report[:lost].any? || report[:errors].any?
          puts "steps=#{report[:steps]} claimed=#{report[:claimed].inspect} " \
               "completed=#{report[:completed].inspect} lost=#{report[:lost].inspect} " \
               "errors=#{report[:errors].inspect}"
        end
      rescue StandardError => error
        # Transient database/network trouble must not kill the only simulator.
        # Leases expire on their own and are re-claimed on the next iteration.
        warn "tick failed: #{error.class}: #{error.message}"
      end
      sleep 0.05
    end
    MatchRunner.shutdown!
    puts "Simulator stopped."
  end

  desc "Show live matches, lease owners and checkpoint ticks"
  task status: :environment do
    Match.live.order(:id).each do |match|
      puts format("match=%d room=%s status=%s tick=%d checkpoint=%d owner=%s lease_until=%s",
                  match.id, match.room.invitation_code, match.status, match.tick,
                  match.checkpoint_tick, match.owner_token || "-", match.lease_expires_at || "-")
    end
    puts "No live matches." if Match.live.none?
  end

  desc "Abandon live matches whose lease expired without a checkpoint"
  task reap: :environment do
    Match.live.where("lease_expires_at IS NOT NULL AND lease_expires_at < ?", Time.current).find_each do |match|
      next if match.checkpoint.present?

      match.abandon!(reason: "owner_lost")
      puts "abandoned match=#{match.id} (no checkpoint; no standings were invented)"
    end
  end
end
