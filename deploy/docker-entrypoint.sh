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

cleanup() {
  echo "[9router-docker] Shutdown signal received, stopping services..."
  if [ -n "$NODE_PID" ]; then
    kill -TERM "$NODE_PID" 2>/dev/null || true
  fi
  if [ -n "$ENGINE_PID" ]; then
    kill -TERM "$ENGINE_PID" 2>/dev/null || true
  fi
  wait "$NODE_PID" 2>/dev/null || true
  wait "$ENGINE_PID" 2>/dev/null || true
  echo "[9router-docker] All services stopped."
  exit 0
}

trap cleanup TERM INT

ENGINE_PID=""
NODE_PID=""

# 1. Start Golang Master Gateway + Limiter if enabled
if [ "$ENABLE_GO_HYBRID" != "false" ] && [ -x /app/router-engine ]; then
  echo "[9router-docker] Starting Golang Master Gateway (gateway :${GATEWAY_PORT}, limiter :${LIMITER_PORT}, public :${PUBLIC_PORT})..."
  /app/router-engine \
    -port "${LIMITER_PORT}" \
    -gateway-port "${GATEWAY_PORT}" \
    -proxy-port "${PUBLIC_PORT}" \
    -upstream "http://127.0.0.1:${BACKEND_PORT}" \
    -static-dir /app/deploy &
  ENGINE_PID=$!
else
  echo "[9router-docker] Golang engine disabled, binding Next.js directly to 0.0.0.0:${GATEWAY_PORT}..."
  export PORT="${GATEWAY_PORT}"
  export HOSTNAME="0.0.0.0"
fi

# 2. Start Next.js backend
echo "[9router-docker] Starting Next.js backend on ${HOSTNAME}:${PORT}..."
su-exec node node custom-server.js --no-browser --log --skip-update &
NODE_PID=$!

# 3. Monitor both processes
while kill -0 "$NODE_PID" 2>/dev/null && { [ -z "$ENGINE_PID" ] || kill -0 "$ENGINE_PID" 2>/dev/null; }; do
  sleep 2
done

cleanup
