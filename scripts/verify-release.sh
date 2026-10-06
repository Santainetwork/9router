#!/bin/bash
# Post-deploy gate: fail if the release dir is a mixed or partial build.
# Cause: 2026-10-06 incident where 1161/1619 files in .next-tailadmin were from
# two different builds -> RSC module mismatch -> blank dashboard pages.
set -e

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RELEASE_DIR="${RELEASE_DIR:-/opt/9router-release}"

fail() { echo "FAIL: $1"; exit 1; }
[ -d "$RELEASE_DIR/.next-tailadmin" ] || fail "missing $RELEASE_DIR/.next-tailadmin"

rb="$(cat "$REPO_DIR/.next-tailadmin/BUILD_ID")"
sb="$(cat "$RELEASE_DIR/.next-tailadmin/BUILD_ID")"
[ "$rb" = "$sb" ] || fail "BUILD_ID mismatch repo=$rb release=$sb"

# Byte-identical tree: any stale or foreign file breaks the RSC flight payload.
if ! diff -rq "$REPO_DIR/.next-tailadmin" "$RELEASE_DIR/.next-tailadmin" > /tmp/verify-release.diff 2>&1; then
  echo "FAIL: release build differs from repo ($(wc -l < /tmp/verify-release.diff) entries)"
  head -20 /tmp/verify-release.diff
  exit 1
fi

echo "OK: release matches repo build $rb"
