# syntax=docker/dockerfile:1
# Next Level Snake — the same production image works with Podman and Docker.
# From the repository root: podman compose up --build -d
# Docker alternative:       docker compose up --build -d
FROM docker.io/library/ruby:3.3.6-slim-bookworm AS base

ENV RAILS_ENV=production \
    RAILS_LOG_LEVEL=info \
    BUNDLE_PATH=/usr/local/bundle \
    BUNDLE_WITHOUT=development:test \
    BUNDLE_JOBS=4 \
    BUNDLE_RETRY=3
WORKDIR /app

# Runtime dependencies only. The compiler remains in the separate build stage.
RUN apt-get update -qq && apt-get install -y --no-install-recommends \
      libpq5 libyaml-0-2 postgresql-client curl \
    && rm -rf /var/lib/apt/lists/*

FROM base AS gems
RUN apt-get update -qq && apt-get install -y --no-install-recommends \
      build-essential libpq-dev libyaml-dev \
    && rm -rf /var/lib/apt/lists/*
COPY rails/Gemfile ./Gemfile
RUN bundle install

FROM base AS app
COPY --from=gems /usr/local/bundle /usr/local/bundle
COPY rails/ /app/

# Copy the WHOLE existing public directory. Never require public/img/ as a
# separate COPY source: generated/binary images can be missing from a checkout
# or source archive. Scripts, styles, and the source-text Violet fallback are
# present without any photographs. Optional photos are included when available.
COPY public/ /app/public/

RUN test -f /app/public/game.js \
    && test -f /app/public/app.js \
    && test -f /app/public/profile.js \
    && test -f /app/public/violet-mist.svg \
    && mkdir -p /app/tmp/pids /app/log /app/storage \
    && chmod +x /app/bin/* \
    && groupadd --system rails \
    && useradd --system --gid rails --home /app rails \
    && chown -R rails:rails /app

USER rails
EXPOSE 3000
ENTRYPOINT ["bin/docker-entrypoint"]
CMD ["bundle", "exec", "puma", "-C", "config/puma.rb"]
