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

# Same dist dir the build and the installer use, so the gate never passes by
# comparing two equally wrong directories.
DIST_DIR_NAME="${NEXT_DIST_DIR:-.next}"
# Recorded by install.sh so the gate reads the dist dir the release was actually
# built from instead of comparing two equally wrong directories.
if [ -f "$RELEASE_DIR/.dist-dir" ]; then
  RECORDED_DIST="$(cat "$RELEASE_DIR/.dist-dir")"
  [ -n "$RECORDED_DIST" ] && DIST_DIR_NAME="$RECORDED_DIST"
fi
# No .dist-dir means the release was not produced by install.sh. Detect the dir
# that actually exists instead of assuming the build default, otherwise the gate
# reports the wrong path and hides the real fault.
if [ -z "${RECORDED_DIST:-}" ] && [ -d "$RELEASE_DIR/.next-tailadmin" ] && [ ! -d "$RELEASE_DIR/.next" ]; then
  DIST_DIR_NAME=".next-tailadmin"
fi

DIFF_FILE="$(mktemp)"

trap 'rm -f "$DIFF_FILE"' EXIT

fail() { echo "FAIL: $1"; exit 1; }
ok()   { echo "OK: $1"; }
info() { echo "INFO: $1"; }
[ -d "$RELEASE_DIR/$DIST_DIR_NAME" ] || fail "missing $RELEASE_DIR/$DIST_DIR_NAME"

[ -f "$REPO_DIR/$DIST_DIR_NAME/BUILD_ID" ] || fail "no build at $REPO_DIR/$DIST_DIR_NAME (BUILD_ID missing); run the build first"
[ -f "$RELEASE_DIR/$DIST_DIR_NAME/BUILD_ID" ] || fail "$DIST_DIR_NAME/BUILD_ID missing from the release"
rb="$(cat "$REPO_DIR/$DIST_DIR_NAME/BUILD_ID")"
sb="$(cat "$RELEASE_DIR/$DIST_DIR_NAME/BUILD_ID")"
[ "$rb" = "$sb" ] || fail "BUILD_ID mismatch repo=$rb release=$sb"

# Byte-identical tree: any stale or foreign file breaks the RSC flight payload.
# Compare the subtree the installer actually copies (standalone/<dist>), not the
# whole build dir: trace/, standalone/, diagnostics and *.nft.json exist only in
# the repo's build output and would always look "different" otherwise.
REPO_BUILD_SUB="$REPO_DIR/$DIST_DIR_NAME/standalone/$DIST_DIR_NAME"
[ -d "$REPO_BUILD_SUB" ] || REPO_BUILD_SUB="$REPO_DIR/$DIST_DIR_NAME"
if ! diff -rq -x cache "$REPO_BUILD_SUB" "$RELEASE_DIR/$DIST_DIR_NAME" > "$DIFF_FILE" 2>&1; then
  echo "FAIL: release build differs from repo ($(wc -l < "$DIFF_FILE") entries)"
  head -20 "$DIFF_FILE"
  exit 1
fi

# A nested static/static means static was copied twice, which is pure bloat and a
# sign the stage was assembled by hand instead of by install.sh.
if [ -e "$RELEASE_DIR/$DIST_DIR_NAME/static/static" ]; then
  fail "$DIST_DIR_NAME/static/static exists; static was copied on top of an existing static"
fi

# Freshness: every file the running server loads must come from a build newer
# than the sources it was compiled from.
NEWEST_SRC="$(find "$REPO_DIR/src" "$REPO_DIR/custom-server.js" -type f -printf '%T@\n' 2>/dev/null | sort -n | tail -1)"
OLDEST_BUILD="$(find "$REPO_DIR/$DIST_DIR_NAME/server" -type f -printf '%T@\n' 2>/dev/null | sort -n | head -1)"
awk -v s="$NEWEST_SRC" -v b="$OLDEST_BUILD" 'BEGIN { exit (b + 0 >= s + 0) ? 0 : 1 }' \
  || fail "build older than sources; stale bundle"

# Content: the deployed instrumentation must match what the source expects.
for sym in startWorkerJournalCollector installCatalogSource startModelCatalogSync; do
  grep -q "$sym" "$RELEASE_DIR/$DIST_DIR_NAME/server/instrumentation.js" \
    || fail "instrumentation.js missing $sym; wrong build shipped"
done
# The file-log bridge is container-only: assert it is present in the bundle, not
# that it is active, so a systemd host is not forced to run container code.
if grep -q "installWorkerFileMirror" "$REPO_DIR/src/instrumentation.js"; then
  grep -rl "installWorkerFileMirror\|startWorkerFileCollector" "$RELEASE_DIR/$DIST_DIR_NAME/server" > /dev/null \
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


[ -f "$RELEASE_DIR/$DIST_DIR_NAME/BUILD_ID" ] || fail "$DIST_DIR_NAME/BUILD_ID missing"
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
  info "router-engine not in release dir (expected: it lives in the install dir)"
fi

echo "OK: release matches repo build $rb"
