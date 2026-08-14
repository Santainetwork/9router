#!/usr/bin/env bash
# Rebuild the app and refresh the :20130 rate-limit service (9router-rl) from
# current /opt/9router source. Does NOT touch production :20128.
#
#   sudo bash /opt/9router/refresh-9router-rl.sh
#
# Stops the :20127 dev server first (it shares .next with the build), rebuilds,
# copies the standalone bundle to /opt/9router-release, restarts the service.
set -euo pipefail

SRC=/opt/9router
REL=/opt/9router-release

cd "$SRC"

echo "== 1. Stop :20127 dev server if running (shares .next) =="
pkill -f "next dev --port 20127" 2>/dev/null || true
sleep 2

echo "== 2. Production build =="
NODE_OPTIONS="--max-old-space-size=4096" npx next build --webpack

test -d "$SRC/.next/standalone" || { echo "  build produced no standalone"; exit 1; }

echo "== 3. Refresh release bundle =="
rm -rf "$REL"
mkdir -p "$REL/.next"
cp -a "$SRC/.next/standalone/." "$REL"/
cp -a "$SRC/.next/static" "$REL/.next/static"
[ -d "$SRC/public" ] && cp -a "$SRC/public" "$REL/public"
# Next's file-tracing does not always copy custom-server.js into standalone —
# ensure the wrapper the systemd unit runs is always present.
cp -f "$SRC/custom-server.js" "$REL/custom-server.js"
test -f "$REL/custom-server.js" && test -f "$REL/server.js" || { echo "  release missing server files"; exit 1; }

echo "== 4. Restart service =="
systemctl restart 9router-rl

echo "== 5. Validate (login + API; DB migrates lazily on first API hit) =="
for i in $(seq 1 45); do
  api=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:20130/api/auth/status 2>/dev/null || echo 000)
  login=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:20130/login 2>/dev/null || echo 000)
  [ "$api" = "200" ] && [ "$login" = "200" ] && { echo "  healthy after ${i}s"; ok=1; break; }
  sleep 1
done
if [ "${ok:-0}" = 1 ]; then
  echo "9router-rl refreshed on :20130. Logs: journalctl -u 9router-rl -f"
else
  echo "!! not healthy — check: journalctl -u 9router-rl -n 50"; exit 1
fi
