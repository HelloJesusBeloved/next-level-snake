module Api
  # Shared by every JSON endpoint.
  #
  # The page talks to these endpoints with fetch(), which does not send Rails'
  # CSRF token. `protect_from_forgery with: :null_session` would therefore blank
  # the session on every write, so logging in and saving a score could never
  # work. Forgery protection is skipped here and replaced by two controls:
  #
  #   * the session cookie is SameSite=Lax, so other sites' requests never carry it
  #   * writes must be application/json, which a cross-site form cannot send
  #     and a cross-site fetch cannot send without a CORS preflight
  class BaseController < ApplicationController
    skip_forgery_protection

    before_action :require_json_body, unless: -> { request.get? || request.head? }

    private

    def require_json_body
      return if request.media_type == "application/json"

      render json: { error: "Content-Type must be application/json" },
             status: :unsupported_media_type
    end
  end
end
