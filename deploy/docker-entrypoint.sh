#!/bin/sh
set -e

# Ensure data directories exist and are owned by node user
mkdir -p "${DATA_DIR:-/app/data}" /app/data-home
chown -R node:node "${DATA_DIR:-/app/data}" /app/data-home 2>/dev/null || true

# If custom command passed (e.g. sh, node, npm), execute it directly
if [ "$1" != "run" ] && [ -n "$1" ]; then
  exec su-exec node "$@"
fi

export BACKEND_PORT="${BACKEND_PORT:-20127}"
export GATEWAY_PORT="${GATEWAY_PORT:-20128}"
export LIMITER_PORT="${LIMITER_PORT:-20129}"
export PUBLIC_PORT="${PUBLIC_PORT:-20140}"
export PORT="${BACKEND_PORT}"
export HOSTNAME="127.0.0.1"
export GO_ENGINE_URL="${GO_ENGINE_URL:-http://127.0.0.1:${LIMITER_PORT}}"
export ENABLE_GO_HYBRID="${ENABLE_GO_HYBRID:-true}"
export DATA_DIR="${DATA_DIR:-/app/data}"
export APP_NAME="${APP_NAME:-SantaiNetwork}"
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=512}"
WORKER_ROLE="${WORKER_ROLE:-control}"
API_WORKERS="${API_WORKERS:-1}"
export WORKER_ROLE API_WORKERS

# Keep shell orchestration behind the same fail-closed validator as direct Node startup.
su-exec node node custom-server.js --check-config

case "$API_WORKERS" in
  ''|*[!0-9]*|0*) echo "[9router-docker] API_WORKERS must be a positive integer" >&2; exit 1 ;;
esac
# Keep this ceiling identical to MAX_API_WORKERS in custom-server.js. Worker
# ports are derived as BACKEND_PORT+4+i, so 8 processes is the supported max.
if [ "$API_WORKERS" -gt 8 ]; then
  echo "[9router-docker] API_WORKERS must not exceed 8" >&2
  exit 1
fi
case "$WORKER_ROLE" in
  control|api) ;;
  *) echo "[9router-docker] WORKER_ROLE must be control or api" >&2; exit 1 ;;
esac
if [ "$WORKER_ROLE" = "api" ] || [ "$API_WORKERS" -gt 1 ]; then
  case "${DATABASE_URL:-}" in postgres://*|postgresql://*) : ;;
    *) if [ "$(printf '%s' "${DB_TYPE:-}" | tr '[:upper:]' '[:lower:]')" != "postgres" ]; then
      if [ "$(printf '%s' "${SQLITE_MULTICORE:-}" | tr '[:upper:]' '[:lower:]')" != "redis" ]; then
        echo "[9router-docker] SQLite API_WORKERS>1 requires PostgreSQL or SQLITE_MULTICORE=redis" >&2
        exit 1
      fi
      case "${REDIS_URL:-}" in redis://*|rediss://*) : ;;
        *) echo "[9router-docker] SQLite multicore requires a valid redis:// or rediss:// REDIS_URL" >&2; exit 1 ;;
      esac
      if [ "$(printf '%s' "${ENABLE_GO_HYBRID:-}" | tr '[:upper:]' '[:lower:]')" != "true" ]; then
        echo "[9router-docker] SQLite multicore requires ENABLE_GO_HYBRID=true" >&2
        exit 1
      fi
    fi ;;
  esac
fi

API_WORKER_URLS=""
i=0
while [ "$i" -lt $((API_WORKERS - 1)) ]; do
  worker_port=$((BACKEND_PORT + 4 + i))
  API_WORKER_URLS="${API_WORKER_URLS:+${API_WORKER_URLS},}http://127.0.0.1:${worker_port}"
  i=$((i + 1))
done
export API_WORKER_URLS

# Terminate every managed process and reap it. Safe to call more than once:
# a missing/reaped pid is ignored.
terminate_children() {
  for pid in $NODE_PID $API_NODE_PIDS; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  if [ -n "$ENGINE_PID" ]; then
    kill -TERM "$ENGINE_PID" 2>/dev/null || true
  fi
  for pid in $NODE_PID $API_NODE_PIDS; do
    wait "$pid" 2>/dev/null || true
  done
  if [ -n "$ENGINE_PID" ]; then
    wait "$ENGINE_PID" 2>/dev/null || true
  fi
}

# TERM/INT is an operator-requested stop: drain and report success.
cleanup() {
  echo "[9router-docker] Shutdown signal received, stopping services..."
  terminate_children
  echo "[9router-docker] All services stopped."
  exit 0
}

# A managed child died on its own: stop the rest but surface a non-zero exit so
# the orchestrator can restart the container.
fail() {
  echo "[9router-docker] A managed service exited unexpectedly, stopping remaining services..." >&2
  terminate_children
  echo "[9router-docker] All services stopped." >&2
  exit 1
}

trap cleanup TERM INT

ENGINE_PID=""
NODE_PID=""
API_NODE_PIDS=""

# 1. Start Golang Master Gateway + Limiter if enabled
if [ "$ENABLE_GO_HYBRID" != "false" ] && [ -x /app/router-engine ]; then
  echo "[9router-docker] Starting Golang Master Gateway (gateway :${GATEWAY_PORT}, limiter :${LIMITER_PORT}, public :${PUBLIC_PORT})..."
  /app/router-engine \
    -port "${LIMITER_PORT}" \
    -gateway-port "${GATEWAY_PORT}" \
    -proxy-port "${PUBLIC_PORT}" \
    -upstream "http://127.0.0.1:${BACKEND_PORT}" \
    -api-workers "$API_WORKER_URLS" \
    -static-dir /app/deploy &
  ENGINE_PID=$!
else
  echo "[9router-docker] Golang engine disabled, binding Next.js directly to 0.0.0.0:${GATEWAY_PORT}..."
  export PORT="${GATEWAY_PORT}"
  export HOSTNAME="0.0.0.0"
fi

# 2. Start Next.js backend
echo "[9router-docker] Starting Next.js backend on ${HOSTNAME}:${PORT}..."
WORKER_ROLE=control su-exec node node custom-server.js --no-browser --log --skip-update &
NODE_PID=$!

if [ "$API_WORKERS" -gt 1 ]; then
  i=0
  while [ "$i" -lt $((API_WORKERS - 1)) ]; do
    worker_port=$((BACKEND_PORT + 4 + i))
    # API workers are internal and must never bind a public interface, even when
    # the Go engine is disabled and the parent HOSTNAME was set to 0.0.0.0.
    PORT="$worker_port" HOSTNAME="127.0.0.1" WORKER_ROLE=api API_WORKERS="$API_WORKERS" su-exec node node custom-server.js --no-browser --log --skip-update &
    API_NODE_PIDS="${API_NODE_PIDS} $!"
    i=$((i + 1))
  done
fi

# 3. Monitor both processes
while kill -0 "$NODE_PID" 2>/dev/null && { [ -z "$ENGINE_PID" ] || kill -0 "$ENGINE_PID" 2>/dev/null; }; do
  for pid in $API_NODE_PIDS; do kill -0 "$pid" 2>/dev/null || fail; done
  sleep 2
done

fail
