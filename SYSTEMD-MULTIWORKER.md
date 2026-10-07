# Systemd Multi-Worker Guide

9Router can run as several Node.js processes behind one Go gateway: one
**control** process that owns the database, plus N-1 **API workers** that only
serve traffic. This guide covers the systemd (native, non-Docker) deployment.

It documents both supported multicore backends, the installer flow, env handling,
per-worker management, and how to fall back to a single process.

> **Status: experimental.** Neither multicore mode has completed a production
> soak. `API_WORKERS=1` (control process only) remains the conservative default.
> Treat anything below as a canary rollout.

---

## 1. Architecture

### 1.1 Process and unit layout

```
                 internet / LAN
                       │
        ┌──────────────▼───────────────────────────┐
        │ 9router-hybrid-engine.service            │  Go binary (router-engine)
        │   :20128 master gateway (public entry)   │
        │   :20129 concurrency limiter RPC         │
        │   :20140 public proxy (/usage-check)     │
        └──────────────┬───────────────────────────┘
                       │ forwards /v1/* + UI/API to 127.0.0.1:20127
        ┌──────────────▼───────────────────────────┐
        │ 9router.service   (WORKER_ROLE=control)  │
        │   Next.js App Router, custom HTTP server │
        │   loopback :20127, single DB WRITER      │
        └──────────────┬───────────────────────────┘
                       │
     ┌─────────────────┼─────────────────┐
     ▼                 ▼                 ▼
 9router-worker@1  9router-worker@2  ... @(API_WORKERS-1)
  WORKER_ROLE=api   WORKER_ROLE=api
  :20131  READ-ONLY  :20132  READ-ONLY
```

All worker ports are **loopback only** (`127.0.0.1:20127+3+i`). The Go gateway
is the sole public listener: it gates concurrency and forwards to the control
process and each API worker.

### 1.2 Units created by `scripts/install.sh`

| Unit | Role |
| --- | --- |
| `9router.service` | Control process. Bootstraps, owns migrations, and is the only process that writes (SQLite mode) or opens the main pool (PostgreSQL mode). |
| `9router-hybrid-engine.service` | Go master gateway on `:20128`, limiter on `:20129`, public proxy on `:20140`. Only public listener. |
| `9router-worker@.service` | Template instance, one per API worker. `WORKER_ROLE=api`. |
| `9router-worker-env@.service` | `Type=oneshot` that regenerates the worker's private env file. Needed because `/run` is cleared on reboot. |
| `9router-workers.target` | Grouping target. Starts/stops every enabled instance together. |

`API_WORKERS` counts **total Node processes**: `API_WORKERS=4` means one control
plus three API workers. Maximum is `8`.

### 1.3 How the two roles differ

| Concern | `control` | `api` worker |
| --- | --- | --- |
| Database writes | Yes — sole writer | No |
| SQLite file handle | Read/write (WAL) | Read-only (`PRAGMA query_only=ON`) |
| Mutations (SQLite + Redis) | Consumes the broker stream | XADD an entry, waits for receipt |
| Migrations / schema sync | Yes | No (must match control's schema version) |
| `/api/ready` gate | DB adapter + schema version | Adds Redis ping, writer heartbeat, limiter health, stream backlog |

### 1.4 Starting order and restart propagation

The installer wires `PartOf=` so a restart propagates:

- `9router-worker@N` → `PartOf=9router-workers.target` and `PartOf=9router.service`
- A restart of the control process restarts the workers, so they never keep
  serving the previous build.

`9router-worker@N` requires `9router-worker-env@N.service`, which writes
`/run/9router-workers/N.env` before the worker starts. The worker's own
`EnvironmentFile` order is shared file first, private file second, so per-worker
values win.

---

## 2. Database backends

Pick one. Mixing them is rejected by the installer.

### Option A — SQLite + Redis multicore

`API_WORKERS>1` on SQLite is only allowed with `SQLITE_MULTICORE=redis`, which
bridges writes over Redis so the SQLite file still has exactly one writer.

```bash
DB_TYPE=sqlite
SQLITE_MULTICORE=redis
REDIS_URL=redis://127.0.0.1:6379/0
REDIS_KEY_PREFIX=9router:sqlite
SQLITE_QUEUE_ENCRYPTION_KEY=<64 hex chars>
```

**How the single-writer bridge works**

1. An API worker calls `enqueueMutation(...)`. The payload is encrypted with
   `SQLITE_QUEUE_ENCRYPTION_KEY` and appended with `XADD` to
   `<namespace>:mutations`, a Redis Stream in the consumer group `sqlite-writer`.
2. The worker blocks for the **receipt**. `consistency: "async"` enqueues and
   returns immediately; `consistency: "sync"` waits for the committed receipt.
3. Only the control process (where `shouldStartSqliteMutationWriter()` is true)
   runs the writer loop: `XREADGROUP` → validate JSON envelope → `applyMutation`
   on SQLite → persist receipt → `XACK` → `XDEL`.
4. The writer refreshes `<namespace>:writer:heartbeat` with a `PX` TTL. Workers
   treat an expired or missing key as writer-down and report not-ready, rather
   than queueing against a dead writer.

Two consequences worth knowing:

- **Redis must be durable.** The control writer preflights the server before
  starting and refuses to run unless `appendonly=yes` and
  `maxmemory-policy=noeviction`. A Redis that evicts or loses the stream loses
  the queued mutations, so this is a hard fail-closed check, not a warning.
- **The queue key must be independent.** It may not reuse `API_KEY_SECRET` or
  the Redis password, and must be exactly 64 hex characters (`openssl rand -hex 32`).

**Files:** `src/lib/db/sqliteMutationRuntime.js`, `src/lib/db/sqliteMutationWriter.js`,
`src/lib/db/queueEncryption.js`, `src/lib/redis/client.js`,
`src/lib/redis/serverConfig.js`.

### Option B — PostgreSQL multicore

```bash
DATABASE_URL=postgres://user:password@host:5432/9router
# or: DB_TYPE=postgres
```

Every process opens its own connection pool and PostgreSQL arbitrates
concurrency. There is no broker and no `SQLITE_QUEUE_ENCRYPTION_KEY`. This is the
mode to choose when the database already lives outside the gateway host.

**Files:** `src/lib/db/driver.js`, `src/lib/db/adapters/postgresAdapter.js`.

### Choosing

| | SQLite + Redis | PostgreSQL |
| --- | --- | --- |
| Ops cost | SQLite plus one Redis | Separate database server |
| Failure domain | Writer heartbeat, Redis durability | PostgreSQL itself |
| Write path | Async queue + receipt | Direct transaction |
| Extra secret | `SQLITE_QUEUE_ENCRYPTION_KEY` | none |
| Use when | One host, want to keep the embedded DB | Database already centralized |

---

## 3. Setup, step by step

### 3.1 Prerequisites

- Linux with systemd. Validated on Debian 12/13 and Ubuntu 22.04+.
- Node.js >= 20 on `PATH` (`/usr/bin/env node` is what the units invoke).
- Go >= 1.21 if you build `hybrid-engine/bin/router-engine` from source. A
  prebuilt binary in the release directory is enough otherwise.
- At least 2 GB RAM and 3 GB free disk.
- **Option A:** a Redis server reachable from the host, with `appendonly=yes`
  and `maxmemory-policy=noeviction`.
- **Option B:** a reachable PostgreSQL server with the database created.

### 3.2 Run the installer

`scripts/install.sh` validates the topology **before** it changes anything, so a
rejected configuration costs nothing.

```bash
sudo bash scripts/install.sh --dry-run   # preview, changes nothing
```

Then install. `--upgrade` if 9Router is already installed, plain install for a
fresh host. `ROUTER_PASSWORD` sets the dashboard password non-interactively,
otherwise the installer asks.

```bash
sudo ROUTER_PASSWORD="your-dashboard-password" bash scripts/install.sh --upgrade
```

`scripts/systemd-worker-topology.sh` is not run directly; the installer sources
it and the `9router-worker-env@.service` unit calls it as
`write-one <dir> <backend-port> <total> <instance>`. It regenerates a single
worker env file on demand, which is the only form of that script.

### 3.3 Environment variables

Two files matter:

- `/etc/9router.env` — the shared `EnvironmentFile` read by every unit
  (`9router.service`, every worker, and the Go gateway).
- `/run/9router-workers/<i>.env` — private per-worker file, written by
  `9router-worker-env@<i>.service` before the worker starts, mode `0600`,
  directory `0700`.

The private file always sets the identity and port of that worker:

```
WORKER_ROLE=api
NINEROUTER_WORKER_ROLE=api
PORT=<127.0.0.1 port for instance i>
HOSTNAME=127.0.0.1
API_WORKERS=<total>
```

**Important:** `scripts/install.sh` rewrites `/etc/9router.env` from a template,
but it reads the SQLite broker variables back from the existing file before it
writes, and the template re-emits them when set. So passing them once is enough —
later `--upgrade` runs keep the topology and no manual append is needed.

```bash
QUEUE_KEY="$(openssl rand -hex 32)"

# One command. ENABLE_GO_HYBRID defaults to true in the installer; passing the
# broker keys here is what makes the topology preflight see them and persist
# them. Run from the extracted release directory.
sudo API_WORKERS=3 \
     DB_TYPE=sqlite \
     SQLITE_MULTICORE=redis \
     REDIS_URL="redis://127.0.0.1:6379/0" \
     REDIS_KEY_PREFIX="9router:sqlite" \
     SQLITE_QUEUE_ENCRYPTION_KEY="$QUEUE_KEY" \
     bash scripts/install.sh --upgrade
```

That is the whole procedure. `systemctl daemon-reload` runs inside the
installer, and it restarts the units in the right order, so no extra restart
follows.

For PostgreSQL, `DATABASE_URL` is also preserved across upgrades:

```bash
sudo API_WORKERS=3 \
     DATABASE_URL="postgres://user:password@host:5432/9router" \
     bash scripts/install.sh --upgrade
```

`--upgrade`, `--force-reinstall` and every later re-run keep the installed topology without an append step, and only while `API_WORKERS>1`. Only `--uninstall --purge` deletes `/etc/9router.env`, so a purged host needs the broker keys passed again on reinstall. Rolling back to `API_WORKERS=1` drops the broker keys from the file, because a single process needs no writer bridge. Verify the installed topology in the file at any time: `sudo grep -E 'API_WORKERS|SQLITE_MULTICORE|REDIS_URL|REDIS_KEY_PREFIX|SQLITE_QUEUE_ENCRYPTION_KEY|ENABLE_GO_HYBRID' /etc/9router.env`.

### 3.4 Alternative: a systemd drop-in

A drop-in under `/etc/systemd/system/<unit>.service.d/override.conf` attaches
values to one unit. A drop-in on the template `9router-worker@.service` applies
to every instance:

```ini
# /etc/systemd/system/9router-worker@.service.d/override.conf
[Service]
Environment=REDIS_URL=redis://127.0.0.1:6379/0
Environment=SQLITE_QUEUE_ENCRYPTION_KEY=<64 hex chars>
```

Note the precedence: systemd reads `EnvironmentFile=` **after** `Environment=`,
so values in `/etc/9router.env` override a drop-in. A drop-in only wins for a
variable that is absent from the shared file. Use it for role-specific values,
and `/etc/9router.env` for deployment-wide secrets — never set the same key in
both.

### 3.5 Choosing the worker count

Set `API_WORKERS` to the total Node process count. The installer validates it,
and the topology script rejects anything above `8` or a port layout that
overflows the TCP range.

```bash
sudo API_WORKERS=4 DATABASE_URL="postgres://..." bash scripts/install.sh --upgrade
```

`API_WORKERS=1` installs no worker instance at all and keeps the previous
single-process behavior. Lowering the count disables and removes the surplus
instances first, so a shrunken install never leaves a worker holding an
orphaned port.

Sizing guidance: start at two processes, watch `/api/ready` and the queue depth,
then grow. Traffic is served by whichever process the Go gateway routes to, so
extra workers only help if the gateway is the bottleneck.

---

## 4. Day-2 operations

### 4.1 Enable and start

The installer enables and starts everything, including exactly the instances
`API_WORKERS` asks for. Manually:

```bash
sudo systemctl daemon-reload
sudo systemctl enable 9router 9router-hybrid-engine

# Enable the instances you want surviving reboot, then start the group.
sudo systemctl enable 9router-worker@1 9router-worker@2
sudo systemctl start 9router-workers.target
```

To enable an instance at boot without starting it immediately:

```bash
sudo systemctl enable 9router-worker@3 --now
```

### 4.2 Status and logs

```bash
# The three core units
sudo systemctl status 9router 9router-hybrid-engine --no-pager

# One template instance (%i expands per instance)
sudo systemctl status 9router-worker@1 --no-pager

# Every worker at once
sudo systemctl list-units '9router-worker@*' --no-pager

# What the gateway actually routes to (live argv, -api-workers list)
ps -eo args | grep '[r]outer-engine' | head -1

# The persisted topology (install.sh writes these to the shared env file;
# systemctl show -p Environment does NOT list EnvironmentFile values)
grep -E '^API_WORKERS=|^API_WORKER_URLS=' /etc/9router.env

# Logs: workers log with SyslogIdentifier 9router-worker-<i>
sudo journalctl -u 9router-worker@1 -f
sudo journalctl -u 9router-worker@1 --since '10 min ago' --no-pager
sudo journalctl -u 9router -u '9router-worker@*' -n 100 --no-pager
```

A failing worker also leaves the reason in its private env generator's log if
the unit failed to start:

```bash
sudo journalctl -u 9router-worker-env@1 --no-pager
```

### 4.3 Restart, reload, drain

```bash
# Restart the whole worker group: PartOf= propagates to each instance
sudo systemctl restart 9router-workers.target

# Restart one instance only (Control group: long SSE streams get TimeoutStopSec=300)
sudo systemctl restart 9router-worker@2

# Restart the control process. PartOf= restarts the workers too, so the fleet
# matches the build. Keep this order: control first, gateway last.
sudo systemctl restart 9router
sudo systemctl restart 9router-hybrid-engine

# Re-read env files after editing /etc/9router.env
sudo systemctl daemon-reload
```

Always restart the gateway **after** the backend processes. It is the only
public listener, and restarting it first briefly fails new connections while the
old backend is still up.

---

## 5. Health checks

### 5.1 `/api/ready`

`GET /api/ready` returns `200` when the process can serve, `503` otherwise. It
is an internal probe: the Go gateway denies the path from outside, so query the
loopback port directly.

```bash
# Control process
curl -fsS http://127.0.0.1:20127/api/ready

# Each API worker: BACKEND_PORT + 3 + i, so worker 1 is :20131, worker 2 :20132
for i in 1 2 3; do
  echo "worker $i: $(curl -fsS http://127.0.0.1:$((20127 + 3 + i))/api/ready)"
done
```

The body stays driver-type only: no connection string, no secret, no raw driver
error. Two shapes exist.

A SQLite + Redis `api` worker answers with `ready`, `database`, `reason` and
`counters` (`streamLength`, `pending`, `oldestPendingAgeMs`) — deliberately
without schema version or latency. The control process, PostgreSQL workers and
the single-process default go through plain `checkDatabaseReady()` instead:

```json
{"ready":true,"database":"postgres","schemaVersion":5,"latencyMs":2,"counters":{}}
```

### 5.2 What `503` means

For an `api` worker in SQLite + Redis mode, every dependency must hold. The
`reason` field maps to:

| `reason` | Meaning | First thing to check |
| --- | --- | --- |
| `db_not_ready` | SQLite adapter not open or schema version mismatch | `journalctl -u 9router-worker@N`; confirm the control process is healthy first |
| `db_not_readonly` | Adapter did not open the file read-only | `SQLITE_MULTICORE` and `WORKER_ROLE` are both correct |
| `redis_unhealthy` | Redis ping or routing-state probe failed | Redis process, `REDIS_URL`, auth, and `appendonly`/`maxmemory-policy` |
| `writer_heartbeat_stale` | Writer heartbeat missing or TTL expired | Is `9router.service` running? It owns the writer loop |
| `go_limiter_unhealthy` | `:20129` limiter not healthy | `curl http://127.0.0.1:20129/health`; gateway unit |
| `backlog_exceeded` | Stream longer than the limit (10000) | Writer loop stalled, not applying mutations |
| `pending_age_exceeded` | Oldest pending entry older than 120s | Same as above; look for repeated writes failing on the writer |

Failure bodies carry `ready:false` plus `reason`. `db_not_ready` with no further
detail means the plain path failed first; its own reasons are `adapter_error`,
`schema_read_failed`, `schema_missing`, `schema_invalid`, `schema_mismatch` and
`timeout`.

### 5.3 Confirming there is no SQLite write contention

SQLite + Redis is designed so exactly one process writes. To verify:

```bash
# 1. Only the control process may own the writer. This holds only for
#    DB_TYPE=sqlite + SQLITE_MULTICORE=redis + WORKER_ROLE=control, and this is
#    the one failure you want to see printed here:
sudo journalctl -u 9router --since '15 min ago' | grep -i 'SQLiteMutationWriter'

# 2. Every worker must report a read-only adapter. db_not_readonly means the
#    role or mode is wrong; redis_unhealthy before it means Redis is down.
for i in 1 2 3; do
  curl -fsS "http://127.0.0.1:$((20127 + 3 + i))/api/ready"
done

# 3. The heartbeat key must exist and hold a TTL. A negative pttl (-2 missing,
#    -1 no expiry) means the writer loop is not running.
redis-cli pttl 9router:sqlite:writer:heartbeat

# 4. Look for lock errors. SQLITE_BUSY / SQLITE_LOCKED on a worker means the
#    read-only contract is broken somewhere; on the control process it means
#    real contention that needs the stream, not more short queries.
sudo journalctl -u '9router-worker@*' --since '30 min ago' \
  | grep -iE 'SQLITE_BUSY|database is locked'
```

Backlog is the better contention signal: a `pending` counter that never returns
to `0` means the writer is falling behind, not that SQLite is locked. On an
`API_WORKERS=1` install items 2 to 4 return nothing by design.

### 5.4 Other probes

```bash
# Go gateway health and limiter snapshot
curl http://127.0.0.1:20129/health
curl http://127.0.0.1:20129/v1/limiter/snapshot

# Public entry point
curl -o /dev/null -w '%{http_code}\n' http://localhost:20128/api/health
```

---

## 6. Troubleshooting

### The installer refused the topology

`API_WORKERS>1 requires PostgreSQL or SQLITE_MULTICORE=redis`, or the follow-up
`SQLITE_MULTICORE=redis requires a valid redis:// or rediss:// REDIS_URL`.

On `--upgrade` the installer reads `API_WORKERS`, `DB_TYPE`, `SQLITE_MULTICORE`
and the Redis variables back from the existing `/etc/9router.env`, so an
installed topology passes without extra flags. The error means either a first
install that never passed them (add them inline as in section 3.3) or a real
conflict. If `DATABASE_URL` is set to anything that is not `postgres://` or
`postgresql://`, multi-worker mode is refused outright, because `DB_TYPE=postgres`
cannot override it.

### The installer refused late: `Rejected by custom-server.js --check-config`

The topology check runs `custom-server.js --check-config` with the resolved
config before writing units. It deliberately probes the **`control`** role with
your `API_WORKERS`, so it validates the deployment as a whole rather than a
single worker's role.

The failure you will most likely hit is:

```
[9Router] Invalid worker configuration: SQLite multicore requires ENABLE_GO_HYBRID=true
```

The installer now exports `ENABLE_GO_HYBRID=true` by default for the preflight,
so on a current installer you should not see this. You only get it if
`ENABLE_GO_HYBRID=false` is set explicitly **in the installer's own environment**
(`sudo ENABLE_GO_HYBRID=false bash scripts/install.sh --upgrade`) while
`SQLITE_MULTICORE=redis` is active — drop the override. A line in
`/etc/9router.env` cannot cause this preflight error: the installer reads that
file key by key, it does not source it, so the value never reaches the check.
At runtime, however, the file wins: systemd reads `EnvironmentFile=` after
`Environment=`, so a hand-written `ENABLE_GO_HYBRID=false` in `/etc/9router.env`
overrides the control unit's drop-in and disables the engine. Fix that by
editing `/etc/9router.env`, not the units.

Other `validateWorkerConfig()` rejections: an `API_WORKERS` above 8 or not a
positive integer, `WORKER_ROLE` outside `control`/`api`, a missing or reused
`SQLITE_QUEUE_ENCRYPTION_KEY`, an invalid `REDIS_URL`, and `SQLITE_MULTICORE`
not set to `redis`.

### A worker fails readiness with `writer_heartbeat_stale`

The writer runs only in `9router.service`. Check that it is up and that the
heartbeat key has a TTL:

```bash
systemctl is-active 9router
redis-cli pttl 9router:sqlite:writer:heartbeat   # must be > 0
```

A negative PTL means the writer stopped. Restart the control process; the
workers recover once the heartbeat returns.

### `REDIS_PREFLIGHT_FAILED` on startup

The control writer refuses an unsafe Redis. Fix the server, not the key:

```bash
redis-cli config get appendonly maxmemory-policy
# appendonly must be yes; maxmemory-policy must be noeviction (or empty)
```

### Workers run the previous build after an upgrade

The `PartOf=` relationship makes a control restart cascade to workers. If it did
not, the units were edited or the template replaced manually. Restart the group
explicitly: `sudo systemctl restart 9router-workers.target`.

### Changing the topology did not take effect

`API_WORKERS` is read from the installer's environment first, then inherited from
the existing env file on `--upgrade`. Restarting units does not change it; run
the installer again with the new `API_WORKERS`.

---

## 7. Quick rollback to a single process

Rolling back is a normal install with `API_WORKERS=1`. It disables and stops
every worker instance, leaves the target empty, and tells the gateway there are
no workers. Nothing about the data layout changes.

```bash
# SQLite + Redis deployment
sudo API_WORKERS=1 DB_TYPE=sqlite bash scripts/install.sh --upgrade

# PostgreSQL deployment (DATABASE_URL is preserved, keep it set)
sudo API_WORKERS=1 bash scripts/install.sh --upgrade

sudo systemctl daemon-reload
sudo systemctl restart 9router 9router-hybrid-engine
```

Verify nothing is left enabled:

```bash
systemctl list-units '9router-worker@*' --no-pager   # expect none active
systemctl is-enabled 9router-workers.target            # expect disabled
grep '^API_WORKERS=' /etc/9router.env                   # expect API_WORKERS=1
grep -c 'REDIS_URL' /etc/9router.env                    # expect 0
ps -eo args | grep '[r]outer-engine' | head -1          # expect no -api-workers
```

For SQLite + Redis, the broker keys leave `/etc/9router.env` with the rollback:
the installer reads them back only when more than one worker is being installed,
so a single process never resurrects a writer it does not need. Re-enable the
broker by passing the keys again on any `API_WORKERS>1` install. Redis itself
keeps running as a systemd service and is untouched either way.

If an upgrade left the host in a broken state, the installer's own rollback
restores the previous env, units, and release:

```bash
sudo bash scripts/install.sh --restore-backup /var/backups/9router/<stamp>-upgrade
```

---

## Appendix: variables referenced by this guide

| Variable | Meaning |
| --- | --- |
| `API_WORKERS` | Total Node processes: 1 control + (`API_WORKERS`-1) API workers. Max 8. |
| `WORKER_ROLE` / `NINEROUTER_WORKER_ROLE` | `control` or `api`. Written per process by the topology script. |
| `DB_TYPE` | `sqlite` (default) or `postgres`. |
| `DATABASE_URL` | PostgreSQL connection URL. Must not be set in SQLite + Redis mode. |
| `SQLITE_MULTICORE` | `redis` enables the SQLite single-writer broker. |
| `REDIS_URL` | `redis://` or `rediss://` broker URL. Required with `SQLITE_MULTICORE=redis`. |
| `REDIS_KEY_PREFIX` | Deployment-scoped key namespace. Default `9router:sqlite`. |
| `REDIS_PASSWORD` | Broker password, used by the bundled Redis container. |
| `SQLITE_QUEUE_ENCRYPTION_KEY` | 64 hex chars (32 bytes). Encrypts queued mutations. |
| `GATEWAY_PORT` / `LIMITER_PORT` / `BACKEND_PORT` / `PUBLIC_PORT` | `20128` / `20129` / `20127` / `20140`. |
