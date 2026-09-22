# Native systemd Multi-Worker Design

## Decision

Use design A. `API_WORKERS=1` remains the default. Native multi-worker mode is opt-in and rejected unless PostgreSQL is selected through `DATABASE_URL=postgres://...`, `DATABASE_URL=postgresql://...`, or `DB_TYPE=postgres`.

`API_WORKERS` means total Node processes, matching Docker: one control plus `API_WORKERS - 1` API workers. With `BACKEND_PORT=20127` and `API_WORKERS=3`, workers are instances 1 and 2 on ports 20131 and 20132.

## Units

- `9router.service` (`${SERVICE_MAIN}`): singleton control on `127.0.0.1:20127`; owns dashboard, auth, migrations, schedulers, tunnel, MITM, MCP.
- `9router-worker-env@.service` (`${SERVICE_WORKER_ENV}@`): `Type=oneshot` that generates the per-instance env file under `/run/9router-workers/%i.env` via `systemd-worker-topology.sh write-one`. Must run **before** `worker@` because systemd reads `EnvironmentFile` entries at unit start time and `/run/` is cleared on reboot. Uses `RuntimeDirectoryPreserve=yes` for the env dir.
- `9router-worker@.service` (`${SERVICE_WORKER}@`): stateless API worker instance. `After=` and `Requires=` both `${SERVICE_WORKER_ENV}@%i.service` so the oneshot completes first. `EnvironmentFile=-/run/9router-workers/%i.env` is listed last so it overrides the shared control env (`WORKER_ROLE=control` becomes `WORKER_ROLE=api`). `PartOf=${SERVICE_WORKERS_TARGET}` enables `systemctl stop 9router-workers.target` to drain every instance.
- `9router-workers.target` (`${SERVICE_WORKERS_TARGET}`): groups enabled API-worker instances. `After=` and `Requires=` `${SERVICE_MAIN}.service`. Empty (no instance enabled) when `API_WORKERS=1`.
- `9router-hybrid-engine.service`: remains the only public listener and receives `-api-workers ${API_WORKER_URLS}`. Non-API paths continue to the control upstream.

## Port Mapping

Worker ports are derived as `BACKEND_PORT + 3 + i` for instance `i = 1..API_WORKERS-1`. With `BACKEND_PORT=20127` and `API_WORKERS=3`: instance 1 → `:20131`, instance 2 → `:20132`. Maximum 8 total Node processes (`WORKER_MAX=8`). Port overflow rejected at validation time.

## Lifecycle

1. Installer validates topology before mutation via `worker_env_prepare` (PostgreSQL guard, port bounds, max workers).
2. Installer writes initial per-instance env files to `/run/9router-workers/`; `9router-worker-env@.service` recreates each file before its worker starts after reboot.
3. Stale worker instances disabled first (`worker_stale_units` + `disable_stale_workers`).
4. Control process started and health-checked at `:20127/api/health` (45s timeout).
5. Worker instances enabled (`1..API_WORKERS-1`) and target started. Each `worker-env@` oneshot completes (generating `/run/9router-workers/%i.env`), then `worker@` starts reading its private `EnvironmentFile`.
6. Every worker health-checked on its own loopback port (45s per instance).
7. Go engine restarted last with `-api-workers` flag.
8. Final health verification: control, workers, gateway (`:20128`), public portal (`:20140`), limiter (`:20129`).

Any health failure triggers existing rollback behavior when `ROLLBACK_ARMED=1`.

Workers use loopback host, `WORKER_ROLE=api`, `NINEROUTER_WORKER_ROLE=api`, total `API_WORKERS`, shared PostgreSQL URL, shared limiter, and the existing 300-second drain timeout. API workers do not own migrations, catalog sync, background token refresh, tunnel, MITM, MCP, or schedulers.

## Safety

- **PostgreSQL guard**: SQLite plus `API_WORKERS>1` fails before build/install mutation. Rejected early by `worker_env_prepare` in `systemd-worker-topology.sh`.
- **Default single-process**: `API_WORKERS=1` keeps no active worker instances and passes an empty `API_WORKER_URLS`, preserving existing behavior.
- **Port overflow**: Worker URL derivation is bounded by `WORKER_MAX=8` total Node processes and rejects ports exceeding TCP range.
- **Rollback topology snapshot**: `snapshot_worker_topology()` copies `9router-worker@.service`, `9router-worker-env@.service`, `9router-workers.target`, and records enabled instance numbers to `$BACKUP_DIR/systemd/worker-instances.list` before mutation. `stop_all_worker_instances()` cleans up a topology that could not be verified.
- **Stale instance cleanup**: `worker_stale_units()` and `disable_stale_workers()` remove instances that exceed the current `API_WORKERS` count, preventing orphaned ports.

## Verification

| Check | Status | Evidence |
|---|---|---|
| Focused native-systemd tests (43/43) | ✅ Pass | `node --test tests/unit/install-script-safety.test.mjs tests/unit/systemd-worker-topology.test.mjs` |
| Full Node verification suite (198 pass, 2 skip) | ✅ Pass | `npm test` |
| Production build | ✅ Pass | `npm run build` |
| Go vet + race detector | ✅ Pass | `cd hybrid-engine && go vet ./... && go test ./... -race` |
| `systemd-analyze verify` (sandbox) | ✅ Pass | Unit syntax validated in dry-run sandbox |
| Default SQLite/single-worker path unchanged | ✅ Pass | `API_WORKERS=1` default tested; no workers enabled without PostgreSQL |
| Isolated real control + 2 workers + gateway | ⏳ Pending | Requires live PostgreSQL instance + systemd; blocked until integration environment available |
| Independent safety/systemd review | ✅ Pass | Swarm audit found no critical issues; actionable findings were fixed and retested |
| Commit evidence | ⏳ Pending | Awaiting completion of all checks |
