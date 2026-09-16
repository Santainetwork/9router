#!/usr/bin/env bash
# Ephemeral, isolated validation of the SQLite -> PostgreSQL migration.
#
# Spins up a throwaway PostgreSQL container on a random host port, seeds a fresh
# SQLite database in a temp dir, runs scripts/migrate-sqlite-to-postgres.mjs
# against both, then verifies per-table row counts and spot row values.
#
# Never touches an existing database: the container is created and destroyed by
# this script, and the SQLite seed lives under a mktemp dir.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER="9router-pg-migrate-test-$$"
PG_IMAGE="${PG_IMAGE:-postgres:16-alpine}"
PG_PASSWORD="migratetest"
PG_USER="migratetest"
PG_DB="migratetest"
HOST_PORT="${PG_HOST_PORT:-$(node -e 'const n=require("net").createServer();n.listen(0,()=>{console.log(n.address().port);n.close()})')}"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> starting ephemeral postgres ($PG_IMAGE) in $CONTAINER on 127.0.0.1:$HOST_PORT"
docker run -d --name "$CONTAINER" \
  -e "POSTGRES_PASSWORD=$PG_PASSWORD" \
  -e "POSTGRES_USER=$PG_USER" \
  -e "POSTGRES_DB=$PG_DB" \
  -p "127.0.0.1:$HOST_PORT:5432" \
  "$PG_IMAGE" >/dev/null

echo "==> waiting for readiness"
for i in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; then break; fi
  sleep 1
  if [ "$i" = 60 ]; then echo "postgres did not become ready" >&2; exit 1; fi
done

export MIGRATE_TEST_PG_URL="postgres://$PG_USER:$PG_PASSWORD@127.0.0.1:$HOST_PORT/$PG_DB"

echo "==> running migration validation"
node "$ROOT/tests/unit/migrate-sqlite-to-postgres-pg.test.mjs"

echo "==> PASS: sqlite -> postgres migration verified against real PostgreSQL"
