# Username-only accounts — no email, which is exactly why passwords cannot be
# reset: store yours in a password manager. Sessions are the standard Rails
# signed cookie holding user_id.
class User < ApplicationRecord
  has_secure_password

  # The cabinet skins a player can pick (ids match public/app.js THEMES).
  FAVORITE_THEMES = %w[arcade classic vintage terminal paper violet sunsetfire].freeze

  USERNAME_MIN_LENGTH = 2
  USERNAME_MAX_LENGTH = 30

  validates :username,
            presence: true,
            uniqueness: { case_sensitive: false },
            length: { minimum: USERNAME_MIN_LENGTH, maximum: USERNAME_MAX_LENGTH }
  validate :validate_username_chars!

  validates :password, length: { minimum: 8, maximum: 128 }, if: :password_required?
  validates :favorite_theme, inclusion: { in: FAVORITE_THEMES, message: "is not a known theme" }, allow_nil: true

  has_many :scores, dependent: :delete_all

  # Preserve the exact casing typed by the user.
  normalizes :username, with: ->(name) { name.to_s.strip }

  def validate_username_chars!
    return if username.blank?
    if username.match?(/[\/\\<>`]/) || username.match?(/[\u0000-\u001f\u007f]/)
      errors.add(:username, "contains invalid characters")
    end
  end

  def self.authenticate!(username, password)
    user = find_by("LOWER(username) = ?", username.to_s.strip.downcase)
    user&.authenticate(password) ? user : nil
  end

  private

  # Only check the password when one is being set (sign-up, or a change).
  # Saving other fields, such as favorite_theme, must not require it.
  def password_required?
    password_digest.blank? || !password.nil?
  end
end
