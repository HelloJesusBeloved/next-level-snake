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
