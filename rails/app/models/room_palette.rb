# Deterministic, solid sRGB colors computed from OKLCH. Hues come first, then
# clearly separated lightness bands. Chroma is reduced until in the sRGB gamut
# rather than clipping channels (which would collapse different options).
# OKLab matrices: https://bottosson.github.io/posts/oklab/ (Björn Ottosson).
class RoomPalette
  HUES = [0, 12, 6, 18, 3, 15, 9, 21, 1, 13, 7, 19,
          4, 16, 10, 22, 2, 14, 8, 20, 5, 17, 11, 23].map { |h| (20 + h * 15) % 360 }.freeze
  LIGHTNESS = [0.70, 0.50, 0.86, 0.60].freeze
  BANDS = %w[Medium Dark Light Deep].freeze
  CAPACITY = HUES.size * LIGHTNESS.size # 96, NOT infinitely distinguishable
  SPARE_OPTIONS = 6
  # OKLab distance. Neighbors 15° apart at the same lightness sit around
  # 0.03–0.05 and read as the same shade. The first well-spaced hues sit
  # around 0.11. Below this, a swatch is not offered while a clearer one exists.
  MIN_SEPARATION = 0.11

  def self.color(slot)
    raise ArgumentError, "Unknown color option" unless slot.is_a?(Integer) && (0...CAPACITY).cover?(slot)

    colors.fetch(slot)
  end

  def self.colors
    @colors ||= LIGHTNESS.each_with_index.flat_map do |lightness, band|
      HUES.each_with_index.map do |hue, index|
        chroma = 0.17
        loop do
          rgb = linear_rgb(lightness, chroma, hue)
          if rgb.all? { |channel| channel.between?(0, 1) }
            hex = rgb.map do |channel|
              srgb = channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel**(1.0 / 2.4) - 0.055
              "%02X" % (srgb * 255).round.clamp(0, 255)
            end.join
            break({ slot: band * HUES.size + index, hex: "##{hex}",
                    label: "#{BANDS[band]} hue #{hue}°" }.freeze)
          end
          chroma *= 0.94
        end
      end
    end.freeze
  end

  # Slots to show in the lobby: every color already reserved, then the free
  # colors farthest from those and from each other. Near-duplicate shades stay
  # hidden until the room is crowded enough that a spare seat needs them.
  def self.offer_slots(taken, spare: SPARE_OPTIONS, minimum: MIN_SEPARATION)
    reserved = Array(taken).select { |slot| slot.is_a?(Integer) && (0...CAPACITY).cover?(slot) }.uniq.sort
    free = (0...CAPACITY).to_a - reserved
    picked = []
    threshold = minimum
    while picked.size < free.size
      slot, nearest = farthest_from(reserved + picked, free - picked)
      break unless slot
      if nearest < threshold
        if picked.size >= spare
          break
        end
        if threshold <= 0.04
          picked << slot
          break if picked.size >= spare
          next
        end
        threshold = (threshold - 0.02).round(4)
        next
      end
      picked << slot
      break if picked.size >= 24
      break if nearest < minimum && picked.size >= spare
    end
    reserved + picked
  end

  # The free slot whose nearest reserved color is as far away as possible.
  def self.farthest_slot(taken, pool = nil)
    reserved = Array(taken).select { |slot| slot.is_a?(Integer) && (0...CAPACITY).cover?(slot) }
    candidates = pool ? Array(pool) : (0...CAPACITY).to_a - reserved
    farthest_from(reserved, candidates).first
  end

  def self.distance(hex_a, hex_b)
    a = oklab_of(hex_a)
    b = oklab_of(hex_b)
    Math.sqrt((a[0] - b[0])**2 + (a[1] - b[1])**2 + (a[2] - b[2])**2)
  end

  def self.farthest_from(anchors, pool)
    return [nil, 0.0] if pool.nil? || pool.empty?

    anchor_labs = anchors.map { |slot| oklab_of(color(slot)[:hex]) }
    best = nil
    best_distance = -1.0
    pool.each do |slot|
      lab = oklab_of(color(slot)[:hex])
      nearest = if anchor_labs.empty?
                  1.0
                else
                  anchor_labs.map { |other| lab_distance(lab, other) }.min
                end
      if nearest > best_distance + 1e-9 || (best && (nearest - best_distance).abs <= 1e-9 && slot < best)
        best = slot
        best_distance = nearest
      end
    end
    [best, best_distance]
  end
  private_class_method :farthest_from

  def self.lab_distance(a, b)
    Math.sqrt((a[0] - b[0])**2 + (a[1] - b[1])**2 + (a[2] - b[2])**2)
  end
  private_class_method :lab_distance

  def self.oklab_of(hex)
    raw = hex.to_s.delete_prefix("#")
    channels = [raw[0, 2], raw[2, 2], raw[4, 2]].map { |byte| byte.to_i(16) / 255.0 }
    linear = channels.map { |channel| channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055)**2.4 }
    lr, lg, lb = linear
    long = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb
    medium = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb
    short = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb
    l_c, m_c, s_c = [long, medium, short].map { |cone| cone**(1.0 / 3) }
    [0.2104542553 * l_c + 0.7936177850 * m_c - 0.0040720468 * s_c,
     1.9779984951 * l_c - 2.4285922050 * m_c + 0.4505937099 * s_c,
     0.0259040371 * l_c + 0.7827717662 * m_c - 0.8086757660 * s_c]
  end
  private_class_method :oklab_of

  def self.linear_rgb(lightness, chroma, hue)
    angle = hue * Math::PI / 180
    a = chroma * Math.cos(angle)
    b = chroma * Math.sin(angle)
    l = (lightness + 0.3963377774 * a + 0.2158037573 * b)**3
    m = (lightness - 0.1055613458 * a - 0.0638541728 * b)**3
    s = (lightness - 0.0894841775 * a - 1.2914855480 * b)**3
    [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
     -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
     -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s]
  end
  private_class_method :linear_rgb
end
