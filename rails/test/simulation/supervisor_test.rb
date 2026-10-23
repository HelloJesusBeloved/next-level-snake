require_relative "simulation_helper"

class SupervisorTest < Minitest::Test
  include SimulationTestSupport

  class FakeOwnership
    attr_reader :renewals, :checkpoints, :completions, :releases

    def initialize(renew: true)
      @renew = renew
      @renewals = []
      @checkpoints = []
      @completions = []
      @releases = []
    end

    def renew!(match_id)
      @renewals << match_id
      @renew.respond_to?(:call) ? @renew.call(match_id) : @renew
    end

    def checkpoint!(world)
      @checkpoints << [world.id, world.tick]
      true
    end

    def complete!(world)
      @completions << [world.id, world.tick, world.standings.map(&:id)]
      true
    end

    def release!(match_id)
      @releases << match_id
      true
    end
  end

  def big_world(id: 1, max_ticks: 1_000)
    build_world(id: id, participants: 2, seed: id, max_ticks: max_ticks,
                columns: 96, rows: 72, speed_level: 6)
  end

  def test_attaches_only_what_it_owns_and_steps_on_the_monotonic_clock
    ownership = FakeOwnership.new
    supervisor = Simulation::Supervisor.new(ownership: ownership, checkpoint_every: 5,
                                            renew_interval_ms: 0)
    world = big_world
    supervisor.attach(world, now_ms: 0)

    report = supervisor.tick!(now_ms: 0)
    assert_equal 0, report[:steps]
    assert_empty report[:completed]

    report = supervisor.tick!(now_ms: world.config.tick_ms * 3)
    assert_equal 3, report[:steps]
    assert_equal 3, world.tick
    assert supervisor.attach?(world.id)
    assert_equal [world.id], ownership.renewals.uniq
  end

  def test_renews_the_lease_on_an_interval_instead_of_every_tick
    ownership = FakeOwnership.new
    supervisor = Simulation::Supervisor.new(ownership: ownership, renew_interval_ms: 2_000)
    world = big_world
    supervisor.attach(world, now_ms: 0)
    tick = world.config.tick_ms

    10.times { |call| supervisor.tick!(now_ms: tick * 3 * (call + 1)) }
    assert_equal 30, world.tick
    assert_operator ownership.renewals.length, :<=, 6,
                    "lease renewal is a database write: throttle it well below the tick rate"
  end

  def test_checkpoints_periodically_not_every_tick
    ownership = FakeOwnership.new
    supervisor = Simulation::Supervisor.new(ownership: ownership, checkpoint_every: 5)
    world = big_world
    supervisor.attach(world, now_ms: 0)
    tick = world.config.tick_ms
    4.times { |call| supervisor.tick!(now_ms: tick * 3 * (call + 1)) }
    assert_equal 12, world.tick
    ticks = ownership.checkpoints.map(&:last)
    assert_equal 2, ticks.length, "checkpoints every ~5 ticks, never every tick"
    ticks.each_cons(2) { |earlier, later| assert_operator later - earlier, :>=, 5 }
    assert_operator ticks.length, :<, world.tick
  end

  def test_completes_once_and_detaches
    ownership = FakeOwnership.new
    supervisor = Simulation::Supervisor.new(ownership: ownership, checkpoint_every: 5)
    world = big_world(max_ticks: Simulation::Config::MIN_MAX_TICKS)
    supervisor.attach(world, now_ms: 0)
    tick = world.config.tick_ms
    completed = []
    4.times do |call|
      report = supervisor.tick!(now_ms: tick * 3 * (call + 1))
      completed.concat(report[:completed])
    end
    assert_equal Simulation::Config::MIN_MAX_TICKS, world.tick
    assert_equal [world.id], completed
    assert_equal 1, ownership.completions.length
    refute supervisor.attach?(world.id)
  end

  def test_losing_the_lease_stops_simulation_immediately
    ownership = FakeOwnership.new(renew: ->(_id) { false })
    supervisor = Simulation::Supervisor.new(ownership: ownership, renew_interval_ms: 0)
    world = big_world
    supervisor.attach(world, now_ms: 0)
    report = supervisor.tick!(now_ms: world.config.tick_ms * 5)
    assert_equal [world.id], report[:lost]
    refute supervisor.attach?(world.id)
    assert_equal 0, world.tick, "a match is never advanced without its lease"
  end

  def test_independent_matches_advance_separately_and_can_be_detached
    ownership = FakeOwnership.new
    supervisor = Simulation::Supervisor.new(ownership: ownership)
    first = big_world(id: 1)
    second = big_world(id: 2)
    supervisor.attach(first, now_ms: 0)
    supervisor.attach(second, now_ms: 0)
    supervisor.tick!(now_ms: first.config.tick_ms * 3)
    assert_equal 3, first.tick
    assert_equal 3, second.tick
    supervisor.detach(second.id)
    supervisor.tick!(now_ms: first.config.tick_ms * 6)
    assert_equal 6, first.tick
    assert_equal 3, second.tick
    assert_equal [first.id], supervisor.match_ids
    supervisor.shutdown!
    assert_empty supervisor.match_ids
  end
end
