#!/usr/bin/env bash
# Install + enable the 9router public-share reverse proxy (Option A: nginx
# allowlist on this origin). Idempotent. Does NOT touch 9router or the DB.
#
#   sudo bash deploy/install-public-nginx.sh
#
# After this, point Safeline's upstream at this host:8443 (not :20128).
# PREREQUISITE: the usage-check feature must already be live on prod :20128
# (otherwise the public routes will 404). Check with:
#   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:20128/usage-check   # want 200
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)/nginx-9router-public.conf"
DST_AVAIL=/etc/nginx/sites-available/9router-public.conf
DST_ENABLED=/etc/nginx/sites-enabled/9router-public.conf

echo "== 1. Ensure nginx installed =="
if ! command -v nginx >/dev/null 2>&1; then
  apt-get update -y && apt-get install -y nginx
fi

echo "== 2. Warn if usage-check not yet on prod =="
code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:20128/usage-check || echo 000)
if [ "$code" != "200" ]; then
  echo "  WARNING: /usage-check on :20128 returned $code (want 200)."
  echo "  Public routes will 404 until the feature is deployed to prod. Continuing anyway."
fi

echo "== 3. Install config =="
mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled
cp -f "$SRC" "$DST_AVAIL"
ln -sf "$DST_AVAIL" "$DST_ENABLED"

echo "== 4. Test + reload =="
nginx -t
systemctl enable nginx >/dev/null 2>&1 || true
systemctl reload nginx || systemctl restart nginx

echo "== 5. Verify allowlist locally (via nginx :8443) =="
pub=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8443/usage-check || echo 000)
adm=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8443/dashboard || echo 000)
key=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8443/api/keys || echo 000)
echo "  /usage-check -> $pub (want 200 once deployed)"
echo "  /dashboard   -> $adm (want 404 = blocked)"
echo "  /api/keys    -> $key (want 404 = blocked)"
echo "Done. Point Safeline upstream at this host:8443."
