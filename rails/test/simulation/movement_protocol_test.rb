require_relative "simulation_helper"

# Step 3 wire format: compact, tick-ordered movement frames.
#
# The point of these tests is that the lighter frame is LOSSLESS for movement.
# They step the real engine and prove that a chain of movement frames, rebuilt
# with Simulation::Protocol.rebuild_body, reconstructs byte-identical bodies to
# the full snapshots the same world produced. If a rule ever changes in a way
# that a head+length cannot express, this fails instead of the browser drifting.
class MovementProtocolTest < Minitest::Test
  include SimulationTestSupport

  def world_with(participants: 2, seed: 11, strategy: "responsive", growth: 1)
    config = Simulation::Config.new(columns: 24, rows: 18, seed: seed, max_ticks: 900,
                                    mode: :brawl, growth: growth, speed_level: 3)
    people = Array.new(participants) do |index|
      { id: index + 1, name: "P#{index + 1}", color_hex: SimulationTestSupport::COLORS[index],
        color_slot: index }
    end
    world = Simulation::World.new(id: 77, config: config, participants: people,
                                  presentation_strategy: strategy)
    world.start!
    world
  end

  def rebuild(frames, columns)
    # frames: [{tick:, movement:}], ascending and contiguous
    bodies = {}
    frames.each do |entry|
      entry[:movement]["p"].each do |player|
        previous = bodies[player["i"]]
        bodies[player["i"]] = Simulation::Protocol.rebuild_body(
          head: player["h"], length: player["l"], previous: previous
        )
      end
    end
    bodies
  end

  def test_movement_frames_are_compact_and_still_versioned
    world = world_with
    full = Simulation::Protocol.encode(world)
    movement = Simulation::Protocol.encode_movement(world)

    assert_equal full["v"], movement["v"]
    assert_equal "movement", movement["type"]
    assert_equal full["m"], movement["m"]
    assert_equal full["t"], movement["t"]
    assert_equal full["strategy"], movement["strategy"]
    # The metadata a moving frame does not need is absent, not empty.
    %w[q b r e w].each { |key| refute movement.key?(key), "#{key} should not ride on every movement tick" }
    # ...and the things that DO change when a snake moves are present.
    player = movement["p"].first
    %w[i h d l sc a fr is it].each { |key| assert player.key?(key), "missing #{key}" }
    refute player.key?("b"), "a movement frame carries a head, never a body"
    assert_operator ActiveSupport::JSON.encode(movement).bytesize, :<, ActiveSupport::JSON.encode(full).bytesize
  end

  def test_rebuilding_a_body_chain_reproduces_every_confirmed_body
    world = world_with(participants: 3, seed: 21, growth: 2)
    columns = world.columns
    chain = []
    authoritative = []
    # A client always starts from a COMPLETE snapshot (the subscription seed).
    # A movement chain is only defined relative to such a seed: without it there
    # is no body to extend, which is exactly why the server sends full snapshots
    # periodically and on every structural change.
    seed_bodies = Simulation::Protocol.encode(world)["p"].to_h { |player| [player["i"], player["b"]] }
    40.times do |index|
      # Steer snake 1 so the chain contains turns, not just straight lines.
      direction = %w[down left up right][index % 4]
      world.apply_input(player_id: 1, direction: Simulation::Direction.parse(direction),
                        tick: world.tick, seq: index + 1,
                        window: Simulation::World::QUEUED_INPUT_TICK_WINDOW)
      world.step!
      full = Simulation::Protocol.encode(world)
      authoritative << [world.tick, full["p"].to_h { |player| [player["i"], player["b"]] }]
      chain << { tick: world.tick, movement: Simulation::Protocol.encode_movement(world) }
    end

    rebuilt = rebuild(chain, columns)
    authoritative.each do |tick, expected|
      expected.each do |player_id, cells|
        # The chain above only keeps the LATEST body per player, so compare the
        # final state exactly and verify the chain never contradicted itself.
        next unless tick == authoritative.last[0]

        assert_equal cells, rebuilt[player_id], "player #{player_id} body diverged at tick #{tick}"
      end
    end
    # Every intermediate body must also have been consistent with the engine,
    # starting from the seed snapshot exactly as the browser does.
    rebuilt_upto = seed_bodies.transform_values(&:dup)
    chain.each_with_index do |entry, index|
      entry[:movement]["p"].each do |player|
        rebuilt_upto[player["i"]] = Simulation::Protocol.rebuild_body(
          head: player["h"], length: player["l"], previous: rebuilt_upto[player["i"]]
        )
      end
      tick, expected = authoritative[index]
      expected.each do |player_id, cells|
        assert_equal cells, rebuilt_upto[player_id], "player #{player_id} body diverged at tick #{tick}"
      end
    end
  end

  def test_rebuild_body_handles_growth_shrink_and_the_first_frame
    assert_equal [], Simulation::Protocol.rebuild_body(head: nil, length: 3, previous: [9, 8, 7])
    assert_equal [5], Simulation::Protocol.rebuild_body(head: 5, length: 1, previous: nil)
    # Same length: the tail vacated, so only head + the first length-1 survive.
    assert_equal [4, 3, 2], Simulation::Protocol.rebuild_body(head: 4, length: 3, previous: [3, 2, 1])
    # One longer: the tail stayed, which is exactly a growth tick.
    assert_equal [4, 3, 2, 1], Simulation::Protocol.rebuild_body(head: 4, length: 4, previous: [3, 2, 1])
  end

  def test_growth_and_removal_are_visible_as_length_changes_only
    world = world_with(participants: 1, seed: 31, growth: 3)
    snake = world.snakes.first
    place(world, snake, body: [[5, 5], [4, 5], [3, 5]], direction: "right", grow: 2)
    place_food(snake, [6, 5])
    before = Simulation::Protocol.encode(world)["p"].first["b"]
    world.step!
    after_frame = Simulation::Protocol.encode(world)["p"].first
    movement = Simulation::Protocol.encode_movement(world)["p"].first

    rebuilt = Simulation::Protocol.rebuild_body(head: movement["h"], length: movement["l"], previous: before)
    assert_equal after_frame["b"], rebuilt
    assert_operator after_frame["l"], :>, before.length, "eating grew the snake"
  end

  def test_classic_worlds_still_produce_a_full_snapshot_and_no_movement_shortcut
    world = world_with(strategy: "classic")
    full = Simulation::Protocol.encode(world)
    assert_equal "classic", full["strategy"]
    refute full.key?("type"), "the full snapshot shape is unchanged for Classic"
    # A movement encoding still exists (the Rails tests and any future client can
    # use it), but the runner never sends it for a Classic match.
    assert_equal "classic", Simulation::Protocol.encode_movement(world)["strategy"]
  end
end
