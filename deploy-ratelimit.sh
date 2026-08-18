#!/usr/bin/env bash
# Cutover :20128 (production 9Router) to the validated rate-limit build.
#
# Everything here has been rehearsed against a copy of the real production DB on
# :20131 (migration clean, data intact, feature live, auth/models 200). This
# script performs a graceful drain: Next stops accepting new requests, waits
# for active requests/streams to finish, then systemd starts the new build.
# New connections can see a short cutover window. Run as root.
#
#   sudo bash /opt/9router/deploy-ratelimit.sh          # deploy
#   sudo bash /opt/9router/deploy-ratelimit.sh rollback # revert to global pkg
set -euo pipefail

OVERRIDE_DIR=/etc/systemd/system/9router.service.d
OVERRIDE=$OVERRIDE_DIR/override.conf
RELEASE=/opt/9router-release
DATA=/var/lib/9router/.9router/db/data.sqlite

wait_up () {
  # Health-check an API route (DB opens lazily on first API hit) AND login.
  for i in $(seq 1 45); do
    login=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:20128/login 2>/dev/null || echo 000)
    api=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:20128/api/auth/status 2>/dev/null || echo 000)
    [ "$login" = "200" ] && [ "$api" = "200" ] && { echo "  up (login+api 200) after ${i}s"; return 0; }
    sleep 1
  done
  echo "  ERROR: :20128 not healthy in 45s (login=$login api=$api)"; return 1
}

if [ "${1:-deploy}" = "rollback" ]; then
  echo "== ROLLBACK =="
  rm -f "$OVERRIDE"
  systemctl daemon-reload
  systemctl restart 9router
  wait_up && echo "Rolled back to global package."
  exit $?
fi

echo "== 1. Backup production DB =="
BK="/root/9router-predeploy-$(date +%Y%m%d-%H%M%S).sqlite"
node -e 'const D=require("/opt/9router/node_modules/better-sqlite3");const s=new D(process.argv[1],{readonly:true});s.backup(process.argv[2]).then(i=>{console.log("  backed up:",process.argv[2],JSON.stringify(i));s.close()}).catch(e=>{console.error(e);process.exit(1)})' "$DATA" "$BK"

echo "== 2. Verify release bundle present =="
test -f "$RELEASE/custom-server.js" || { echo "  missing $RELEASE"; exit 1; }

echo "== 3. Install systemd override =="
mkdir -p "$OVERRIDE_DIR"
cat > "$OVERRIDE" <<EOF
# Deployed by Jcode: run rate-limit build from $RELEASE (Next standalone).
# Rollback: sudo bash /opt/9router/deploy-ratelimit.sh rollback
#
# NOTE: the Next standalone server reads PORT/HOSTNAME from the ENVIRONMENT and
# ignores --port/--host CLI flags. Passing --port here would silently bind :3000.
[Service]
ExecStart=
ExecStart=/usr/bin/node $RELEASE/custom-server.js --no-browser --log --skip-update
Environment=PORT=20128
Environment=HOSTNAME=::
Environment=ALLOWED_DEV_ORIGINS=192.168.105.9,192.168.105.9:20128
ReadWritePaths=/var/lib/9router $RELEASE
TimeoutStopSec=300
EOF
systemctl daemon-reload

echo "== 4. Graceful restart (drain active requests; max 300s) =="
systemctl restart 9router

echo "== 5. Validate =="
if wait_up; then
  echo "  ExecStart: $(systemctl show 9router -p ExecStart | sed 's/.*argv\[\]=//;s/ ;.*//')"
  echo "DEPLOY OK. Migration adds apiKeys.rpm/queueTimeoutMs on first boot (auto-backup made under /var/lib/9router/.9router/db/backups)."
  echo "Rollback anytime: sudo bash /opt/9router/deploy-ratelimit.sh rollback"
else
  echo "!! Health check failed — auto-rolling back."
  rm -f "$OVERRIDE"; systemctl daemon-reload; systemctl restart 9router; wait_up || true
  echo "Rolled back. Pre-deploy DB backup at: $BK"
  exit 1
fi
