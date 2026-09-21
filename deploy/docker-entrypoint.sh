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

case "$API_WORKERS" in
  ''|*[!0-9]*) echo "[9router-docker] API_WORKERS must be a positive integer" >&2; exit 1 ;;
esac
if [ "$API_WORKERS" -lt 1 ]; then
  echo "[9router-docker] API_WORKERS must be a positive integer" >&2
  exit 1
fi
case "$WORKER_ROLE" in
  control|api) ;;
  *) echo "[9router-docker] WORKER_ROLE must be control or api" >&2; exit 1 ;;
esac
if [ "$WORKER_ROLE" = "api" ] || [ "$API_WORKERS" -gt 1 ]; then
  case "${DATABASE_URL:-}" in postgres://*|postgresql://*) : ;;
    *) if [ "$(printf '%s' "${DB_TYPE:-}" | tr '[:upper:]' '[:lower:]')" != "postgres" ]; then
      echo "[9router-docker] API_WORKERS>1 or WORKER_ROLE=api requires PostgreSQL (set DATABASE_URL=postgres://... or DB_TYPE=postgres)" >&2
      exit 1
    fi ;;
  esac
fi
export WORKER_ROLE API_WORKERS

API_WORKER_URLS=""
i=0
while [ "$i" -lt $((API_WORKERS - 1)) ]; do
  worker_port=$((BACKEND_PORT + 4 + i))
  API_WORKER_URLS="${API_WORKER_URLS:+${API_WORKER_URLS},}http://127.0.0.1:${worker_port}"
  i=$((i + 1))
done
export API_WORKER_URLS

cleanup() {
  echo "[9router-docker] Shutdown signal received, stopping services..."
  for pid in $NODE_PID $API_NODE_PIDS; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  if [ -n "$ENGINE_PID" ]; then
    kill -TERM "$ENGINE_PID" 2>/dev/null || true
  fi
  for pid in $NODE_PID $API_NODE_PIDS; do
    wait "$pid" 2>/dev/null || true
  done
  wait "$ENGINE_PID" 2>/dev/null || true
  echo "[9router-docker] All services stopped."
  exit 0
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
    PORT="$worker_port" WORKER_ROLE=api API_WORKERS="$API_WORKERS" su-exec node node custom-server.js --no-browser --log --skip-update &
    API_NODE_PIDS="${API_NODE_PIDS} $!"
    i=$((i + 1))
  done
fi

# 3. Monitor both processes
while kill -0 "$NODE_PID" 2>/dev/null && { [ -z "$ENGINE_PID" ] || kill -0 "$ENGINE_PID" 2>/dev/null; }; do
  for pid in $API_NODE_PIDS; do kill -0 "$pid" 2>/dev/null || cleanup; done
  sleep 2
done

cleanup
