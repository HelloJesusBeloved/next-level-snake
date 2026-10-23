namespace :multiplayer do
  desc "Advance the authoritative simulation once (claims free matches)"
  task tick: :environment do
    report = MatchRunner.tick_once
    puts "claimed=#{report[:claimed].inspect} steps=#{report[:steps]} " \
         "completed=#{report[:completed].inspect} lost=#{report[:lost].inspect} " \
         "checkpoints=#{report[:checkpoints].inspect}"
  end

  desc "Run the authoritative simulator until interrupted (one owner per match)"
  task simulate: :environment do
    stopping = false
    %w[INT TERM].each { |signal| trap(signal) { stopping = true } }
    puts "Simulating matches as owner token #{MatchRunner.token}. Ctrl-C to stop."
    until stopping
      report = MatchRunner.tick_once
      if report[:steps].positive? || report[:completed].any?
        puts "steps=#{report[:steps]} completed=#{report[:completed].inspect} claimed=#{report[:claimed].inspect}"
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
      puts "abandoned match=#{match.id}"
    end
  end
end
