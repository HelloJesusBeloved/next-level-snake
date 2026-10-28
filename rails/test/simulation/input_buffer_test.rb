require_relative "simulation_helper"

# The reported failure: "going right, I swipe down and left immediately — half
# the time I end up one square away from myself." Two independent causes are
# covered here on the server side (the client gesture geometry is covered by
# tests/swipe-steering.test.mjs):
#   * both turns of a fast burst must be buffered, not just the first two;
#   * the turns must apply on consecutive ticks so the snake hugs its own body.
class InputBufferTest < Minitest::Test
  include SimulationTestSupport

  def setup
    @world = build_world
    # Head at [5,5] travelling right, body trailing left in row 5.
    @snake = place(@world, @world.snakes.first, body: [[5, 5], [4, 5], [3, 5]])
  end

  def turn(direction, seq)
    @world.apply_input(player_id: @snake.id,
                       direction: Simulation::Direction.parse(direction),
                       tick: @world.tick, seq: seq)
  end

  def step_head(count = 1)
    count.times { @world.step! }
    @snake.head
  end

  def test_fast_down_then_left_burst_turns_snake_alongside_its_own_body
    assert_equal :accepted, turn("down", 1)
    assert_equal :accepted, turn("left", 2)

    assert_equal [5, 6], step_head(1), "first turn: one cell down"
    assert_equal [4, 6], step_head(1), "second turn: immediately left"
    assert_equal "left", @snake.direction.name
    # The snake now runs left in the row DIRECTLY below the body it left in
    # row 5: the "right alongside itself" path the player asked for, not one
    # square further out.
    assert_equal 6, @snake.head[1], "must stay in the adjacent row"
    assert_includes @snake.body.map { |_, y| y }.uniq, 5
  end

  def test_four_turn_brawl_burst_is_fully_buffered_and_applied_in_order
    %w[down left up right].each_with_index do |direction, index|
      assert_equal :accepted, turn(direction, index + 1),
                   "turn #{index + 1} (#{direction}) must be buffered, not dropped"
    end
    assert_equal :queue_full, turn("down", 5), "the buffer is bounded"

    assert_equal [5, 6], step_head(1)
    assert_equal [4, 6], step_head(1)
    assert_equal [4, 5], step_head(1)
    assert_equal [5, 5], step_head(1), "all four turns played out in order"
  end

  def test_brawl_buffer_survives_a_checkpoint_round_trip
    %w[down left].each_with_index { |direction, index| turn(direction, index + 1) }
    state = @world.to_state
    restored = Simulation::World.restore(
      id: @world.id, config: @world.config,
      participants: @world.snakes.map { |snake|
        { id: snake.id, name: snake.name, color_hex: snake.color_hex, color_slot: snake.color_slot }
      }, state: state
    )
    restored_snake = restored.player(@snake.id)
    assert_equal 2, restored_snake.queue.length, "queued turns are durable"
    restored.step!
    assert_equal [5, 6], restored_snake.head
    restored.step!
    assert_equal [4, 6], restored_snake.head, "the second buffered turn still lands"
  end

  def test_duel_keeps_the_tighter_single_player_buffer
    duel = build_world(mode: :duel)
    snake = place(duel, duel.snakes.first, body: [[5, 5], [4, 5], [3, 5]])
    assert_equal 2, duel.rules.max_queued_directions
    assert_equal :accepted, duel.apply_input(player_id: snake.id,
                            direction: Simulation::Direction.parse("down"), tick: 0, seq: 1)
    assert_equal :accepted, duel.apply_input(player_id: snake.id,
                            direction: Simulation::Direction.parse("left"), tick: 0, seq: 2)
    assert_equal :queue_full, duel.apply_input(player_id: snake.id,
                            direction: Simulation::Direction.parse("up"), tick: 0, seq: 3)
  end

  def test_reversals_and_duplicates_are_still_refused_regardless_of_depth
    assert_equal :reversal, turn("left", 1), "left from right is a 180-degree turn"
    assert_equal :accepted, turn("down", 2)
    assert_equal :duplicate_direction, turn("down", 3), "same direction twice"
    assert_equal :reversal, turn("up", 4), "up is a reversal of the queued down"
  end
end
