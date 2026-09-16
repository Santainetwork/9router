#!/usr/bin/env bash
# Install + enable the 9router public-share reverse proxy (Option A: nginx
# allowlist on this origin). Idempotent. Does NOT touch 9router or the DB.
#
#   sudo bash deploy/install-public-nginx.sh
#
# After this, point Safeline's upstream at this host:8443 (not :20128).
# The usage-check page is served from disk (deploy/usage-check.html); only the
# /api/v1/usage endpoint must exist on prod :20128. Check with:
#   curl -s -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer sk-...' \
#     'http://127.0.0.1:20128/api/v1/usage?period=1d'   # want 200
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)/nginx-9router-public.conf"
USAGE_CHECK_HTML="$(cd "$(dirname "$0")" && pwd)/usage-check.html"
USAGE_CHECK_HTML_SED="$(printf '%s' "$USAGE_CHECK_HTML" | sed 's/[&|\\]/\\&/g')"
DST_AVAIL=/etc/nginx/sites-available/9router-public.conf
DST_ENABLED=/etc/nginx/sites-enabled/9router-public.conf

echo "== 1. Ensure nginx installed =="
if ! command -v nginx >/dev/null 2>&1; then
  apt-get update -y && apt-get install -y nginx
fi

echo "== 2. Warn if /api/v1/usage not reachable on prod =="
code=$(curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:20128/api/v1/usage?period=1d' || echo 000)
if [ "$code" = "404" ]; then
  echo "  WARNING: /api/v1/usage on :20128 returned 404 — endpoint not deployed to prod yet."
  echo "  The usage-check page will render but the lookup will fail. Continuing anyway."
else
  echo "  /api/v1/usage on :20128 -> $code (401/200 both mean the route exists)."
fi

echo "== 3. Install config =="
mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled
sed "s|__USAGE_CHECK_HTML__|$USAGE_CHECK_HTML_SED|g" "$SRC" > "$DST_AVAIL"
ln -sf "$DST_AVAIL" "$DST_ENABLED"

echo "== 4. Test + reload =="
nginx -t
systemctl enable nginx >/dev/null 2>&1 || true
systemctl reload nginx || systemctl restart nginx

echo "== 5. Verify allowlist locally (via nginx :8443) =="
pub=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8443/usage-check || echo 000)
adm=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8443/dashboard || echo 000)
key=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8443/api/keys || echo 000)
nxt=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8443/_next/static/chunks/webpack.js || echo 000)
echo "  /usage-check -> $pub (want 200; served from disk)"
echo "  /dashboard   -> $adm (want 404 = blocked)"
echo "  /api/keys    -> $key (want 404 = blocked)"
echo "  /_next/...   -> $nxt (want 404 = blocked; page is self-contained)"
echo "Done. Point Safeline upstream at this host:8443."
