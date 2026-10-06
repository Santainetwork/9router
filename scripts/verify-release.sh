#!/bin/bash
# Post-deploy gate: fail if the release dir is a mixed or partial build.
# Cause: 2026-10-06 incident where 1332/1619 files in .next-tailadmin were from
# two different builds -> RSC module mismatch -> blank dashboard pages.
# Cause 2: same day, a rebuild wrote to .next (Next's default distDir) instead of
# .next-tailadmin, so the shipped bundle silently missed the change while the
# gate still passed on two identical, equally stale, directories.
# Cause 3: same session, a manual stage+swap shipped a release without
# node_modules, so custom-server.js could not require next/dist/bin/next and the
# unit crash-looped. Completeness is now asserted before the service restarts.
set -e

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RELEASE_DIR="${RELEASE_DIR:-/opt/9router-release}"

fail() { echo "FAIL: $1"; exit 1; }
[ -d "$RELEASE_DIR/.next-tailadmin" ] || fail "missing $RELEASE_DIR/.next-tailadmin"

rb="$(cat "$REPO_DIR/.next-tailadmin/BUILD_ID")"
sb="$(cat "$RELEASE_DIR/.next-tailadmin/BUILD_ID")"
[ "$rb" = "$sb" ] || fail "BUILD_ID mismatch repo=$rb release=$sb"

# Byte-identical tree: any stale or foreign file breaks the RSC flight payload.
if ! diff -rq -x cache "$REPO_DIR/.next-tailadmin" "$RELEASE_DIR/.next-tailadmin" > /tmp/verify-release.diff 2>&1; then
  echo "FAIL: release build differs from repo ($(wc -l < /tmp/verify-release.diff) entries)"
  head -20 /tmp/verify-release.diff
  exit 1
fi

# Freshness: every file the running server loads must come from a build newer
# than the sources it was compiled from.
NEWEST_SRC="$(find "$REPO_DIR/src" "$REPO_DIR/custom-server.js" -type f -printf '%T@\n' 2>/dev/null | sort -n | tail -1)"
OLDEST_BUILD="$(find "$REPO_DIR/.next-tailadmin/server" -type f -printf '%T@\n' 2>/dev/null | sort -n | head -1)"
awk -v s="$NEWEST_SRC" -v b="$OLDEST_BUILD" 'BEGIN { exit (b + 0 >= s + 0) ? 0 : 1 }' \
  || fail "build older than sources; stale bundle"

# Content: the deployed instrumentation must match what the source expects.
for sym in startWorkerJournalCollector installCatalogSource startModelCatalogSync; do
  grep -q "$sym" "$RELEASE_DIR/.next-tailadmin/server/instrumentation.js" \
    || fail "instrumentation.js missing $sym; wrong build shipped"
done
# The file-log bridge is container-only: assert it is present in the bundle, not
# that it is active, so a systemd host is not forced to run container code.
if grep -q "installWorkerFileMirror" "$REPO_DIR/src/instrumentation.js"; then
  grep -rl "installWorkerFileMirror\|startWorkerFileCollector" "$RELEASE_DIR/.next-tailadmin/server" > /dev/null \
    || fail "log-bridge source wired but absent from shipped bundle"
fi

# Completeness: the exact modules custom-server.js resolves at boot. A release
# that compares equal on the build dir can still be unable to start. The broken
# stage of this session had a .next-tailadmin but no server.js and no
# node_modules, so custom-server.js took its `next start` fallback and
# MODULE_NOT_FOUND crashed the unit on every restart.
[ -f "$RELEASE_DIR/custom-server.js" ] || fail "custom-server.js missing"
[ -f "$RELEASE_DIR/package.json" ] || fail "package.json missing"
[ -d "$RELEASE_DIR/public" ] || fail "public missing"
[ -d "$RELEASE_DIR/src" ] || fail "src missing"
[ -d "$RELEASE_DIR/node_modules/next" ] || fail "node_modules/next missing"

DIST=".next-tailadmin"
[ -f "$RELEASE_DIR/$DIST/BUILD_ID" ] || fail "$DIST/BUILD_ID missing"
if [ -f "$RELEASE_DIR/server.js" ]; then
  # Standalone layout: server.js requires next and dist/server in-process.
  (cd "$RELEASE_DIR" && node -e 'require.resolve("next"); require("path")' >/dev/null) \
    || fail "cannot resolve next from the release dir"
else
  # Fallback layout traced by the outage: no server.js means custom-server.js runs
  # require.resolve of next/dist/bin/next, which needs the full next package.
  fail "server.js missing; custom-server.js falls back to next start, which needs node_modules"
fi

if [ -x "$RELEASE_DIR/hybrid-engine/bin/router-engine" ]; then
  ok "router-engine present in release"
else
  info "router-engine not in release dir (expected: it lives in $INSTALL_DIR)"
fi

echo "OK: release matches repo build $rb"
