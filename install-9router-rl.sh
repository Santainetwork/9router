#!/usr/bin/env bash
# Install + start the port-20130 rate-limit 9Router as a systemd service.
# Separate data dir (/var/lib/9router-rl), does NOT touch production :20128.
# Run as root:  sudo bash /opt/9router/install-9router-rl.sh
set -euo pipefail

UNIT_SRC=/opt/9router/9router-rl.service
UNIT_DST=/etc/systemd/system/9router-rl.service
RLHOME=/var/lib/9router-rl
RELEASE=/opt/9router-release
PRODDB=/var/lib/9router/.9router/db/data.sqlite

echo "== 1. Ensure release bundle present =="
test -f "$RELEASE/custom-server.js" || { echo "  missing $RELEASE (build not deployed)"; exit 1; }

echo "== 2. Ensure separate data dir + DB (copied from prod if absent) =="
mkdir -p "$RLHOME/.9router/db"
if [ ! -f "$RLHOME/.9router/db/data.sqlite" ]; then
  node -e 'const D=require("/opt/9router/node_modules/better-sqlite3");const s=new D(process.argv[1],{readonly:true});s.backup(process.argv[2]).then(()=>{console.log("  DB copied from prod");s.close()}).catch(e=>{console.error(e);process.exit(1)})' "$PRODDB" "$RLHOME/.9router/db/data.sqlite"
  cp -a /var/lib/9router/.9router/auth /var/lib/9router/.9router/jwt-secret /var/lib/9router/.9router/machine-id "$RLHOME/.9router/" 2>/dev/null || true
  echo "  identity (password/jwt/machine-id) copied from prod"
else
  echo "  existing $RLHOME DB kept"
fi

echo "== 3. Install unit + start =="
cp "$UNIT_SRC" "$UNIT_DST"
systemctl daemon-reload
systemctl enable --now 9router-rl

echo "== 4. Validate (login + API; DB migrates lazily on first API hit) =="
ok=0
for i in $(seq 1 45); do
  # A DB-backed API call both triggers the schema 1->2 migration and confirms health.
  api=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:20130/api/auth/status 2>/dev/null || echo 000)
  login=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:20130/login 2>/dev/null || echo 000)
  [ "$api" = "200" ] && [ "$login" = "200" ] && { ok=1; echo "  healthy after ${i}s"; break; }
  sleep 1
done
if [ "$ok" = 1 ]; then
  echo "9router-rl running on http://<host>:20130  (login uses the same password as :20128)"
  echo "Logs:   journalctl -u 9router-rl -f"
  echo "Stop:   sudo systemctl disable --now 9router-rl"
else
  echo "!! not healthy — check: journalctl -u 9router-rl -n 50"
  exit 1
fi
