require 'test_helper'

# Controllable monotonic clocks, no sleeps and no client/host driving time.
class MatchWakeDeadlineTest < ActiveSupport::TestCase
  setup { MatchRunner.reset! }
  teardown { MatchRunner.reset! }

  def attach(id: 1, tick_ms: 105)
    config = Simulation::Config.new(tick_ms: tick_ms, seed: 7, max_ticks: 1_000)
    world = Simulation::World.new(id: id, config: config,
                                 participants: [{ id: id, name: 'P', color_hex: '#00FF00', color_slot: 0 }])
    world.start!
    MatchRunner.supervisor.attach(world, now_ms: 0)
    MatchRunner.input_poll_at[id] = 0
    world
  end

  test 'an idle server does not spin on PostgreSQL' do
    assert_equal 250, MatchRunner.next_wake_ms(now_ms: 0)
  end

  test 'normal movement deadline is not rounded to a polling interval' do
    attach
    entry = MatchRunner.supervisor.entries.fetch(1)
    entry.scheduler.advance(now_ms: 90)
    MatchRunner.input_poll_at[1] = 90
    assert_equal 15, MatchRunner.next_wake_ms(now_ms: 90)
  end

  test 'database work already spent is subtracted instead of added to the sleep' do
    attach
    entry = MatchRunner.supervisor.entries.fetch(1)
    entry.scheduler.advance(now_ms: 90)
    MatchRunner.input_poll_at[1] = 90
    assert_equal 3, MatchRunner.next_wake_ms(now_ms: 102)
  end

  test 'input poll remains responsive between movement ticks' do
    attach
    assert_equal 30, MatchRunner.next_wake_ms(now_ms: 0)
    assert_equal 10, MatchRunner.next_wake_ms(now_ms: 20)
  end

  test 'a missed deadline cannot cause an unbounded busy spin' do
    attach
    assert_equal 1, MatchRunner.next_wake_ms(now_ms: 500)
  end

  test 'several matches wake on the earliest deadline, not one leader' do
    attach(id: 1, tick_ms: 105)
    attach(id: 2, tick_ms: 42)
    MatchRunner.supervisor.entries.each_value { |entry| entry.scheduler.advance(now_ms: 40) }
    MatchRunner.input_poll_at[1] = MatchRunner.input_poll_at[2] = 40
    assert_equal 2, MatchRunner.next_wake_ms(now_ms: 40)
  end
end
