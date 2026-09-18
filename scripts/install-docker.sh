#!/usr/bin/env bash
#
# 9Router SantaiNetwork Edition — Docker Installer & Orchestrator
# ==============================================================
#
# Installs and runs the hardened 9Router containerized stack:
#   • Golang Master Gateway   :20128 (front-door proxy + gating)
#   • Golang Limiter RPC      :20129 (internal concurrency semaphore)
#   • Golang Public Proxy     :20140 (usage-check & docs portal)
#   • Next.js Backend         :20127 (internal loopback container backend)
#
# Usage:
#   # Interactive install
#   bash scripts/install-docker.sh
#
#   # Non-interactive with defaults
#   bash scripts/install-docker.sh --yes
#
#   # Custom ports or directory
#   bash scripts/install-docker.sh --port 20128 --public-port 20140 --dir /opt/9router-docker
#
#   # Upgrade running containers
#   bash scripts/install-docker.sh --upgrade
#
#   # Stop or restart
#   bash scripts/install-docker.sh --stop
#   bash scripts/install-docker.sh --restart
#
#   # Uninstall containers
#   bash scripts/install-docker.sh --uninstall
#   bash scripts/install-docker.sh --uninstall --purge
#
#   # Dry run inspection
#   bash scripts/install-docker.sh --dry-run
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Default settings
DEFAULT_INSTALL_DIR="/opt/9router-docker"
if [ "$EUID" -ne 0 ]; then
  DEFAULT_INSTALL_DIR="${HOME}/9router-docker"
fi
# If currently inside git repo, default target to current repo
if [ -f "${REPO_DIR}/Dockerfile" ] && [ -f "${REPO_DIR}/docker-compose.yml" ]; then
  DEFAULT_INSTALL_DIR="${REPO_DIR}"
fi

INSTALL_DIR="${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
GATEWAY_PORT="${GATEWAY_PORT:-20128}"
PUBLIC_PORT="${PUBLIC_PORT:-20140}"
APP_NAME="${APP_NAME:-SantaiNetwork}"
INITIAL_PASSWORD="${INITIAL_PASSWORD:-}"
DATABASE_URL="${DATABASE_URL:-}"
USE_POSTGRES=0

ASSUME_YES=0
DRY_RUN=0
UPGRADE=0
DO_STOP=0
DO_RESTART=0
DO_UNINSTALL=0
DO_PURGE=0

# Formatting
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'; C_CYAN=$'\033[36m'
else
  C_RESET=""; C_BOLD=""; C_DIM=""
  C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_CYAN=""
fi

info()  { printf '%s[INFO]%s  %s\n' "$C_CYAN" "$C_RESET" "$*"; }
ok()    { printf '%s[OK]%s    %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn()  { printf '%s[WARN]%s  %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
err()   { printf '%s[ERROR]%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; }
fail()  { err "$*"; exit 1; }
step()  { printf '\n%s==>%s %s%s%s\n' "$C_BLUE" "$C_RESET" "$C_BOLD" "$*" "$C_RESET"; }

# Parse arguments
while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes)               ASSUME_YES=1 ;;
    --dry-run)              DRY_RUN=1 ;;
    --upgrade)              UPGRADE=1 ;;
    --stop|--down)          DO_STOP=1 ;;
    --restart)              DO_RESTART=1 ;;
    --uninstall)            DO_UNINSTALL=1 ;;
    --purge)                DO_PURGE=1 ;;
    --dir)                  shift; INSTALL_DIR="${1:-$DEFAULT_INSTALL_DIR}" ;;
    --port)                 shift; GATEWAY_PORT="${1:-20128}" ;;
    --public-port)          shift; PUBLIC_PORT="${1:-20140}" ;;
    --password)             shift; INITIAL_PASSWORD="${1:-}" ;;
    --database-url)         shift; DATABASE_URL="${1:-}" ;;
    --postgres)             USE_POSTGRES=1 ;;
    -h|--help)
      sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      fail "Unknown option: $1 (run with --help for options)"
      ;;
  esac
  shift
done

# Check Docker prerequisite
detect_docker() {
  if command -v docker >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

# Detect Docker Compose command (docker compose plugin vs docker-compose)
detect_compose() {
  if docker compose version >/dev/null 2>&1; then
    echo "docker compose"
    return 0
  elif command -v docker-compose >/dev/null 2>&1; then
    echo "docker-compose"
    return 0
  fi
  return 1
}

# Generate random secure token
generate_token() {
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
}

# Helper to read from .env safely
read_env_val() {
  local key="$1"
  local file="$2"
  if [ -f "$file" ]; then
    grep "^${key}=" "$file" 2>/dev/null | cut -d= -f2- | tr -d '\r' || true
  fi
}

step "Checking environment and Docker prerequisites"

if ! detect_docker; then
  err "Docker is not installed on this system."
  echo ""
  echo "To install Docker on Linux, run:"
  echo "  curl -fsSL https://get.docker.com | sh"
  echo "  sudo usermod -aG docker \$USER"
  echo ""
  echo "On macOS or Windows, install Docker Desktop from https://www.docker.com/"
  exit 1
fi

COMPOSE_CMD="$(detect_compose || true)"
if [ -z "$COMPOSE_CMD" ]; then
  err "Docker Compose was not found (neither 'docker compose' plugin nor 'docker-compose' binary)."
  echo "Please install Docker Compose: https://docs.docker.com/compose/install/"
  exit 1
fi

ok "Docker is available: $(docker --version)"
ok "Docker Compose is available: $($COMPOSE_CMD version)"

# Verify docker daemon connectivity
if ! docker info >/dev/null 2>&1; then
  err "Cannot connect to the Docker daemon. Is Docker running?"
  if command -v systemctl >/dev/null 2>&1 && [ "$EUID" -eq 0 ]; then
    info "Attempting to start Docker service..."
    systemctl start docker || true
  fi
  if ! docker info >/dev/null 2>&1; then
    fail "Docker daemon is unreachable. Please start Docker and retry."
  fi
fi

# Handle Stop / Restart / Uninstall
if [ "$DO_STOP" -eq 1 ]; then
  step "Stopping 9Router container stack"
  if [ -d "$INSTALL_DIR" ] && [ -f "$INSTALL_DIR/docker-compose.yml" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      info "[dry-run] Would execute: cd $INSTALL_DIR && $COMPOSE_CMD down"
    else
      (cd "$INSTALL_DIR" && $COMPOSE_CMD down)
      ok "9Router containers stopped."
    fi
  else
    warn "No docker-compose.yml found in $INSTALL_DIR"
  fi
  exit 0
fi

if [ "$DO_RESTART" -eq 1 ]; then
  step "Restarting 9Router container stack"
  if [ -d "$INSTALL_DIR" ] && [ -f "$INSTALL_DIR/docker-compose.yml" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      info "[dry-run] Would execute: cd $INSTALL_DIR && $COMPOSE_CMD restart"
    else
      (cd "$INSTALL_DIR" && $COMPOSE_CMD restart)
      ok "9Router containers restarted."
    fi
  else
    fail "No docker-compose.yml found in $INSTALL_DIR"
  fi
  exit 0
fi

if [ "$DO_UNINSTALL" -eq 1 ]; then
  step "Uninstalling 9Router container stack"
  if [ "$ASSUME_YES" -ne 1 ]; then
    printf '%sAre you sure you want to stop and remove 9Router containers? [y/N]: %s' "$C_YELLOW" "$C_RESET"
    read -r confirm
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
      info "Uninstall cancelled."
      exit 0
    fi
  fi

  if [ -d "$INSTALL_DIR" ] && [ -f "$INSTALL_DIR/docker-compose.yml" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      info "[dry-run] Would execute: cd $INSTALL_DIR && $COMPOSE_CMD down"
      if [ "$DO_PURGE" -eq 1 ]; then
        info "[dry-run] Would remove docker volume 9router-data"
      fi
    else
      if [ "$DO_PURGE" -eq 1 ]; then
        (cd "$INSTALL_DIR" && $COMPOSE_CMD down -v)
        ok "Containers and persistent data volumes removed."
      else
        (cd "$INSTALL_DIR" && $COMPOSE_CMD down)
        ok "Containers stopped and removed. Data volume 9router-data preserved."
      fi
    fi
  fi
  exit 0
fi

# Prepare target installation directory
step "Preparing deployment directory: ${INSTALL_DIR}"
if [ "$DRY_RUN" -eq 1 ]; then
  info "[dry-run] Target directory: ${INSTALL_DIR}"
else
  mkdir -p "$INSTALL_DIR"
fi

# Sync or copy files if install dir is separate from repo
if [ "$INSTALL_DIR" != "$REPO_DIR" ]; then
  if [ -f "$REPO_DIR/Dockerfile" ] && [ -f "$REPO_DIR/docker-compose.yml" ]; then
    info "Copying project source to ${INSTALL_DIR}..."
    if [ "$DRY_RUN" -eq 0 ]; then
      cp -a "$REPO_DIR/Dockerfile" "$INSTALL_DIR/"
      cp -a "$REPO_DIR/docker-compose.yml" "$INSTALL_DIR/"
      cp -a "$REPO_DIR/package.json" "$INSTALL_DIR/"
      [ -f "$REPO_DIR/package-lock.json" ] && cp -a "$REPO_DIR/package-lock.json" "$INSTALL_DIR/"
      cp -a "$REPO_DIR/custom-server.js" "$INSTALL_DIR/"
      cp -a "$REPO_DIR/next.config.mjs" "$INSTALL_DIR/"
      cp -a "$REPO_DIR/open-sse" "$INSTALL_DIR/"
      cp -a "$REPO_DIR/src" "$INSTALL_DIR/"
      cp -a "$REPO_DIR/public" "$INSTALL_DIR/"
      cp -a "$REPO_DIR/deploy" "$INSTALL_DIR/"
      cp -a "$REPO_DIR/scripts" "$INSTALL_DIR/"
      cp -a "$REPO_DIR/hybrid-engine" "$INSTALL_DIR/"
    fi
  fi
fi

ENV_FILE="${INSTALL_DIR}/.env"

# Interactive questions if not --yes and not --upgrade
if [ "$ASSUME_YES" -eq 0 ] && [ "$UPGRADE" -eq 0 ] && [ ! -f "$ENV_FILE" ]; then
  echo ""
  printf "%sConfigure 9Router Docker Deployment%s\n" "$C_BOLD" "$C_RESET"
  echo "─────────────────────────────────────────"

  # Port configuration
  printf "Master Gateway Port [%s]: " "$GATEWAY_PORT"
  read -r input_port
  [ -n "$input_port" ] && GATEWAY_PORT="$input_port"

  printf "Public Proxy Port [%s]: " "$PUBLIC_PORT"
  read -r input_pub_port
  [ -n "$input_pub_port" ] && PUBLIC_PORT="$input_pub_port"

  # Initial password
  printf "Initial Admin Dashboard Password (leave blank for random): "
  read -r input_pwd
  if [ -n "$input_pwd" ]; then
    INITIAL_PASSWORD="$input_pwd"
  fi

  # Database selection
  echo ""
  echo "Select Database:"
  echo "  1) SQLite (Default, embedded in volume, zero-configuration)"
  echo "  2) PostgreSQL (External DATABASE_URL)"
  printf "Choice [1]: "
  read -r db_choice
  if [ "$db_choice" = "2" ]; then
    printf "Enter PostgreSQL DATABASE_URL: "
    read -r input_db_url
    DATABASE_URL="$input_db_url"
  fi
fi

# Maintain existing secrets if upgrading
EXISTING_JWT="$(read_env_val "JWT_SECRET" "$ENV_FILE")"
EXISTING_SALT="$(read_env_val "MACHINE_ID_SALT" "$ENV_FILE")"
EXISTING_AKS="$(read_env_val "API_KEY_SECRET" "$ENV_FILE")"
EXISTING_PWD="$(read_env_val "INITIAL_PASSWORD" "$ENV_FILE")"
EXISTING_DB="$(read_env_val "DATABASE_URL" "$ENV_FILE")"

JWT_SECRET="${EXISTING_JWT:-$(generate_token)}"
MACHINE_ID_SALT="${EXISTING_SALT:-$(generate_token | head -c 16)}"
API_KEY_SECRET="${EXISTING_AKS:-$(generate_token)}"
[ -z "$INITIAL_PASSWORD" ] && INITIAL_PASSWORD="${EXISTING_PWD:-$(generate_token | head -c 14)}"
[ -z "$DATABASE_URL" ] && DATABASE_URL="${EXISTING_DB:-}"

step "Generating environment configuration (.env)"
if [ "$DRY_RUN" -eq 1 ]; then
  info "[dry-run] Would write ${ENV_FILE}"
else
  cat > "$ENV_FILE" <<EOF
# 9Router Docker Environment Configuration
# Generated on $(date -u +"%Y-%m-%dT%H:%M:%SZ")

APP_NAME=${APP_NAME}
GATEWAY_PORT=${GATEWAY_PORT}
PUBLIC_PORT=${PUBLIC_PORT}

JWT_SECRET=${JWT_SECRET}
MACHINE_ID_SALT=${MACHINE_ID_SALT}
API_KEY_SECRET=${API_KEY_SECRET}
INITIAL_PASSWORD=${INITIAL_PASSWORD}

DATA_DIR=/app/data
ENABLE_GO_HYBRID=true
NODE_OPTIONS=--max-old-space-size=512

EOF
  if [ -n "$DATABASE_URL" ]; then
    echo "DATABASE_URL=${DATABASE_URL}" >> "$ENV_FILE"
  fi
  chmod 600 "$ENV_FILE"
  ok "Saved ${ENV_FILE} (permissions 600)"
fi

# Build and start services
step "Building and starting 9Router container stack"
COMPOSE_PROFILE_ARGS=()
if [ "$USE_POSTGRES" -eq 1 ] && [ -z "$DATABASE_URL" ]; then
  COMPOSE_PROFILE_ARGS+=(--profile postgres)
fi

if [ "$DRY_RUN" -eq 1 ]; then
  info "[dry-run] Would run: cd $INSTALL_DIR && $COMPOSE_CMD ${COMPOSE_PROFILE_ARGS[*]:-} up -d --build"
else
  info "Running $COMPOSE_CMD build and startup..."
  (cd "$INSTALL_DIR" && $COMPOSE_CMD "${COMPOSE_PROFILE_ARGS[@]:-}" up -d --build)
  ok "Docker container started."
fi

# Health check
if [ "$DRY_RUN" -eq 0 ]; then
  step "Performing health check verification"
  HEALTH_URL="http://127.0.0.1:${GATEWAY_PORT}/api/health"
  PUBLIC_URL="http://127.0.0.1:${PUBLIC_PORT}/usage-check"

  MAX_ATTEMPTS=30
  ATTEMPT=0
  HEALTHY=0

  info "Waiting for 9Router Master Gateway to be ready on port ${GATEWAY_PORT}..."
  while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
    ATTEMPT=$((ATTEMPT + 1))
    HTTP_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$HEALTH_URL" 2>/dev/null || echo "000")"
    if [ "$HTTP_CODE" = "200" ]; then
      HEALTHY=1
      break
    fi
    sleep 2
  done

  if [ "$HEALTHY" -eq 1 ]; then
    ok "9Router Master Gateway health check passed (HTTP 200)."
  else
    warn "Health check on ${HEALTH_URL} did not return HTTP 200 within 60 seconds."
    warn "Containers are still initializing or encountered an error. Check logs with:"
    warn "  cd ${INSTALL_DIR} && ${COMPOSE_CMD} logs -f"
  fi
fi

# Summary
echo ""
printf "%s=======================================================%s\n" "$C_GREEN" "$C_RESET"
printf "%s🚀 9Router Docker Stack is Ready!%s\n" "$C_BOLD" "$C_RESET"
printf "%s=======================================================%s\n" "$C_GREEN" "$C_RESET"
echo ""
echo "  • Web Dashboard & API:   http://localhost:${GATEWAY_PORT}"
echo "  • Public Usage Check:    http://localhost:${PUBLIC_PORT}/usage-check"
echo "  • Public Documentation:  http://localhost:${PUBLIC_PORT}/docs"
echo "  • Initial Admin Login:   admin / ${INITIAL_PASSWORD}"
echo "  • Deploy Directory:      ${INSTALL_DIR}"
echo ""
echo "Manage with Docker Compose:"
echo "  • View live logs:        cd ${INSTALL_DIR} && ${COMPOSE_CMD} logs -f"
echo "  • Restart stack:         cd ${INSTALL_DIR} && ${COMPOSE_CMD} restart"
echo "  • Stop stack:            cd ${INSTALL_DIR} && ${COMPOSE_CMD} down"
echo "  • Upgrade stack:         bash ${SCRIPT_DIR}/install-docker.sh --upgrade"
echo ""
