require "minitest/autorun"
require_relative "../../app/models/room_palette"

class RoomPaletteDistanceTest < Minitest::Test
  def test_colors_stay_unique_and_banded
    options = RoomPalette.colors
    assert_equal 96, options.size
    assert_equal 96, options.map { |color| color[:hex] }.uniq.size
    assert options.first(24).all? { |color| color[:label].start_with?("Medium") }
  end

  def test_a_two_player_lobby_does_not_offer_near_duplicate_shades
    offered = RoomPalette.offer_slots([0, 1])
    hexes = offered.map { |slot| RoomPalette.color(slot)[:hex] }
    hexes.combination(2) do |left, right|
      distance = RoomPalette.distance(left, right)
      assert_operator distance, :>=, RoomPalette::MIN_SEPARATION,
                      "#{left} and #{right} are #{distance} apart"
    end
    free = offered - [0, 1]
    assert_operator free.size, :>=, RoomPalette::SPARE_OPTIONS
    # The old block of 12 included the cyan 15° from the seated cyan.
    refute_includes offered, 9
    refute_includes offered, 8
  end

  def test_a_new_player_is_seated_on_the_farthest_free_color
    slot = RoomPalette.farthest_slot([0, 1])
    seated = [0, 1].map { |taken| RoomPalette.color(taken)[:hex] }
    chosen = RoomPalette.color(slot)[:hex]
    nearest = seated.map { |hex| RoomPalette.distance(chosen, hex) }.min
    assert_operator nearest, :>=, RoomPalette::MIN_SEPARATION
  end

  def test_a_crowded_room_still_keeps_spare_options
    offered = RoomPalette.offer_slots((0...90).to_a)
    free = offered - (0...90).to_a
    assert_operator free.size, :>=, RoomPalette::SPARE_OPTIONS
  end
end
