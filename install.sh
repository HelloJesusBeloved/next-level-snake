#!/usr/bin/env bash
#
# install.sh — set up the Snake Rails app on Fedora/RHEL or Ubuntu/Debian.
#
#   sudo ./install.sh                 # full install + systemd service
#   ./install.sh --help               # usage
#
# Everything is installed with mise (https://github.com/jdx/mise): the Ruby
# toolchain is pinned in rails/.mise.toml, so the same command works on every
# machine and on every distro.
set -euo pipefail

# ----------------------------------------------------------------------------
# configuration (override with environment variables)
# ----------------------------------------------------------------------------
APP_NAME="snake"
SERVICE_NAME="snake"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAILS_DIR="$APP_DIR/rails"
PORT="${PORT:-3000}"
DB_USER="${DATABASE_USER:-snake}"
DB_NAME="${DATABASE_NAME:-snake_production}"
RAILS_ENV="${RAILS_ENV:-production}"
ASSUME_YES="${ASSUME_YES:-0}"
START_SERVICE=1

RUN_USER="${SUDO_USER:-$(id -un)}"
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
MISE_BIN="$RUN_HOME/.local/bin/mise"

# ----------------------------------------------------------------------------
# output helpers
# ----------------------------------------------------------------------------
if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_GREEN=$'\033[1;32m'; C_YELLOW=$'\033[1;33m'; C_RED=$'\033[1;31m'; C_BLUE=$'\033[1;34m'
else
  C_RESET=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_BLUE=''
fi

log()  { printf '%s==>%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
info() { printf '%s   %s%s\n' "$C_BLUE" "$*" "$C_RESET"; }
warn() { printf '%s[!]%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
die()  { printf '%s[x]%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

usage() {
  cat <<EOF
Usage: sudo ./install.sh [options]

Options:
  --port N        Port Puma listens on (default: 3000)
  --no-start      Install everything but do not enable/start the service
  --yes           Never prompt
  -h, --help      Show this help

Environment overrides:
  PORT, DATABASE_USER, DATABASE_NAME, RAILS_ENV, ASSUME_YES

Supported hosts: Fedora / RHEL / CentOS Stream (dnf) and Ubuntu / Debian (apt),
detected automatically from /etc/os-release.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --no-start) START_SERVICE=0; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

# ----------------------------------------------------------------------------
# privilege + os detection
# ----------------------------------------------------------------------------
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || die "run as root, or install sudo"
  SUDO="sudo"
  RUN_USER="$(id -un)"
  RUN_HOME="$HOME"
  MISE_BIN="$RUN_HOME/.local/bin/mise"
fi

as_root() {
  if [ "$(id -u)" -eq 0 ]; then bash -c "$*"; else $SUDO bash -c "$*"; fi
}

as_app_user() {
  if [ "$(id -un)" = "$RUN_USER" ]; then
    env PATH="$RUN_HOME/.local/bin:$PATH" HOME="$RUN_HOME" bash -c "$*"
  else
    $SUDO -u "$RUN_USER" -H env PATH="$RUN_HOME/.local/bin:$PATH" HOME="$RUN_HOME" bash -c "$*"
  fi
}

OS_ID="unknown"
OS_LIKE=""
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  OS_ID="$(. /etc/os-release; echo "${ID:-unknown}")"
  OS_LIKE="$(. /etc/os-release; echo "${ID_LIKE:-}")"
fi

PKG="unknown"
case "$OS_ID$OS_LIKE" in
  *fedora*|*rhel*|*centos*|*rocky*|*alma*) PKG="dnf" ;;
  *ubuntu*|*debian*|*pop*|*linuxmint*)    PKG="apt" ;;
  *) die "unsupported distribution '$OS_ID'. This installer supports Fedora/RHEL and Ubuntu/Debian." ;;
esac

log "Detected $OS_ID — using $PKG"
info "app dir   : $APP_DIR"
info "rails dir : $RAILS_DIR"
info "run user  : $RUN_USER"
info "port      : $PORT"

# ----------------------------------------------------------------------------
# 1. system packages
# ----------------------------------------------------------------------------
log "Installing system packages"
case "$PKG" in
  dnf)
    as_root "dnf install -y git curl gcc gcc-c++ make patch openssl-devel \
      readline-devel zlib-devel libyaml-devel bzip2 libffi-devel \
      postgresql-server postgresql-devel"
    ;;
  apt)
    as_root "apt-get update -qq"
    as_root "DEBIAN_FRONTEND=noninteractive apt-get install -y git curl \
      build-essential autoconf bison libssl-dev libyaml-dev libreadline-dev \
      zlib1g-dev libncurses-dev libffi-dev libgdbm-dev libpq-dev \
      postgresql postgresql-contrib"
    ;;
esac

# ----------------------------------------------------------------------------
# 2. PostgreSQL
# ----------------------------------------------------------------------------
log "Preparing PostgreSQL"

pg_is_running() {
  as_root "psql -U postgres -tAc 'select 1' >/dev/null 2>&1" && return 0
  as_root "su - postgres -c \"psql -tAc 'select 1'\" >/dev/null 2>&1"
}

start_postgres() {
  if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files >/dev/null 2>&1; then
    as_root "systemctl enable --now postgresql" || true
  fi
  if pg_is_running; then return 0; fi

  warn "systemd did not start PostgreSQL — trying direct cluster start"
  if [ "$PKG" = "dnf" ]; then
    as_root "[ -d /var/lib/pgsql/data ] || postgresql-setup --initdb" || true
    as_root "su - postgres -c '/usr/bin/pg_ctl -D /var/lib/pgsql/data -l /var/lib/pgsql/logfile start'" || true
  else
    as_root "pg_ctlcluster \"\$(ls /etc/postgresql | head -n1)\" main start" || true
  fi
  pg_is_running || die "PostgreSQL is not running. Start it and re-run install.sh."
}

start_postgres

DB_PASSWORD="$(as_app_user "openssl rand -hex 18" 2>/dev/null || echo "snake$(date +%s)")"

log "Creating role '$DB_USER' and database '$DB_NAME'"
as_root "su - postgres -c \"psql -tAc \\\"select 1 from pg_roles where rolname='$DB_USER'\\\" | grep -q 1 || \
  psql -c \\\"create role $DB_USER login password '$DB_PASSWORD'\\\"\"" >/dev/null
as_root "su - postgres -c \"psql -tAc \\\"select 1 from pg_database where datname='$DB_NAME'\\\" | grep -q 1 || \
  createdb -O $DB_USER $DB_NAME\"" >/dev/null
info "database ready"

# ----------------------------------------------------------------------------
# 3. mise + Ruby toolchain
# ----------------------------------------------------------------------------
log "Installing mise"
if [ ! -x "$MISE_BIN" ]; then
  as_app_user "curl -fsSL https://mise.run | MISE_QUIET=1 sh"
fi
[ -x "$MISE_BIN" ] || die "mise was not installed at $MISE_BIN"
info "mise: $("$MISE_BIN" --version 2>/dev/null || echo ok)"

log "Installing the pinned Ruby (rails/.mise.toml) — first run compiles, be patient"
as_app_user "cd '$RAILS_DIR' && '$MISE_BIN' install"

log "Installing gems"
as_app_user "cd '$RAILS_DIR' && '$MISE_BIN' exec -- gem install bundler --no-document"
as_app_user "cd '$RAILS_DIR' && '$MISE_BIN' exec -- bundle install --jobs 4"

# ----------------------------------------------------------------------------
# 4. shared assets + database schema
# ----------------------------------------------------------------------------
log "Syncing shared game assets into rails/public"
as_app_user "cd '$RAILS_DIR' && bin/sync-assets"

log "Writing rails/.env"
SECRET_KEY_BASE="$(as_app_user "cd '$RAILS_DIR' && '$MISE_BIN' exec -- bin/rails secret")"
as_app_user "cat > '$RAILS_DIR/.env'" <<EOF
RAILS_ENV=$RAILS_ENV
RAILS_LOG_LEVEL=info
PORT=$PORT
SECRET_KEY_BASE=$SECRET_KEY_BASE
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_USER=$DB_USER
DATABASE_PASSWORD=$DB_PASSWORD
DATABASE_NAME=$DB_NAME
RAILS_FORCE_SSL=false
RAILS_MAX_THREADS=5
WEB_CONCURRENCY=0
EOF
info "wrote $RAILS_DIR/.env"

log "Preparing the database"
as_app_user "cd '$RAILS_DIR' && '$MISE_BIN' exec -- bin/rails db:prepare"

# ----------------------------------------------------------------------------
# 5. systemd service
# ----------------------------------------------------------------------------
if command -v systemctl >/dev/null 2>&1 && [ "$START_SERVICE" = "1" ]; then
  log "Installing systemd unit"
  as_root "cat > /etc/systemd/system/$SERVICE_NAME.service" <<EOF
[Unit]
Description=Snake — wall-wrap arcade (Rails)
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$RAILS_DIR
Environment=HOME=$RUN_HOME
Environment=RAILS_ENV=$RAILS_ENV
EnvironmentFile=$RAILS_DIR/.env
ExecStart=$MISE_BIN exec -- bundle exec puma -C config/puma.rb
Restart=on-failure
RestartSec=3
KillSignal=SIGQUIT
SyslogIdentifier=$SERVICE_NAME

[Install]
WantedBy=multi-user.target
EOF
  as_root "systemctl daemon-reload"
  as_root "systemctl enable --now $SERVICE_NAME"
  info "service started"
else
  warn "systemd unavailable or --no-start given — start manually:"
  info "cd $RAILS_DIR && $MISE_BIN exec -- bundle exec puma -C config/puma.rb"
fi

# ----------------------------------------------------------------------------
# done
# ----------------------------------------------------------------------------
cat <<EOF

${C_GREEN}Snake is installed.${C_RESET}

  Play            : http://localhost:$PORT
  App             : $RAILS_DIR
  Service         : systemctl status $SERVICE_NAME
  Logs            : journalctl -u $SERVICE_NAME -f
  Config          : $RAILS_DIR/.env

Useful:
  cd $RAILS_DIR
  $MISE_BIN exec -- bin/rails console
  $MISE_BIN exec -- bin/rails db:console
  pg_dump -U $DB_USER $DB_NAME > snake.sql      # backup
EOF
