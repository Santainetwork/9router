# 🐳 9Router Docker Deployment & Installer

Deploy 9Router SantaiNetwork Edition in an isolated, multi-platform Docker container stack. Published image: [`decolua/9router`](https://hub.docker.com/r/decolua/9router) — multi-platform `linux/amd64` + `linux/arm64`.

Recommended for operating systems without systemd (Alpine, macOS, Windows WSL, Synology NAS, Proxmox LXC, or containerized VPS).

---

## ⚡ 1-Line Turnkey Installer (Recommended)

Run the automated installer inside the repository or on your server:

```bash
# Interactive installation (guides through ports, passwords, database)
./install-docker.sh

# Or automated non-interactive install (auto-generates secure secrets and starts stack)
./install-docker.sh --yes
```

### Custom Options

```bash
# Specify custom gateway port and public proxy port
./install-docker.sh --port 20128 --public-port 20140

# Custom deployment directory
./install-docker.sh --dir /opt/9router-docker --yes

# With specific admin password
./install-docker.sh --password "YourStrongPassword" --yes

# With external PostgreSQL database
API_WORKERS=3 ./install-docker.sh --database-url "postgres://user:pass@db.example.com:5432/9router" --yes

# Bundled PostgreSQL + multicore (1 control + 2 API workers)
./install-docker.sh --postgres --yes

# Bundled private Redis + SQLite multicore (opt-in; 1 control + 1 API worker)
./install-docker.sh --sqlite-redis --yes
```

---

## 🏗️ Architecture Inside Docker

The container runs both the high-performance **Golang Hybrid Engine** and the **Next.js Standalone Backend** inside a unified container network:

```text
Incoming Traffic
   │
   ├── Port :20128 (Master Gateway) ──> [router-engine in Go]
   │                                        │ (Concurrency gating on /v1)
   │                                        ▼
   │                                    [Next.js on 127.0.0.1:20127]
   │                                        │
   │                                        ▼
   │                                    [SQLite data.sqlite or PostgreSQL]
   │
   ├── Port :20140 (Public Proxy)   ──> [router-engine in Go]
   │                                        │ (Direct disk static serve)
   │                                        ▼
   │                                    /usage-check & /docs (Zero Next.js overhead)
   │
   └── Port :20129 (Limiter RPC)    ──> In-memory concurrency semaphores
```

---

## 👤 Quick Start

To pin a specific version instead of following `latest`, use a numbered image tag:

```bash
docker pull decolua/9router:0.5.81
```

### Manual Docker Compose Deployment

If you prefer running standard Docker Compose commands without the installer script:

### 1. Configure Environment

```bash
cp .env.docker.example .env
chmod 600 .env
```

Edit `.env` to configure your initial password and secrets:

```env
APP_NAME=SantaiNetwork
GATEWAY_PORT=20128
PUBLIC_PORT=20140
INITIAL_PASSWORD=admin_secure_password
JWT_SECRET=your_random_secret_here
```

### 2. Launch Services

```bash
docker build -t 9router .

docker run --rm -p 20128:20128 \
  -v "$HOME/.9router:/app/data" \
  -e DATA_DIR=/app/data \
  9router
```

The Dockerfile uses the official Alpine and npm registries by default. Regional mirrors can be supplied when needed.

App listens on port `20128`. Open: http://localhost:20128

### PostgreSQL multicore profile

SQLite remains single-process. For the bundled PostgreSQL database and three
Node processes, use the installer above or configure `.env` then start the
profile:

```env
POSTGRES_PASSWORD=replace_with_a_long_random_secret
BUNDLED_DATABASE_URL=postgres://9router:replace_with_a_long_random_secret@postgres:5432/9router
BUNDLED_API_WORKERS=3
```

```bash
docker compose --profile postgres up -d --build
```

`API_WORKERS` counts all Node processes: one control process plus the remaining
API workers. Values above `1` require PostgreSQL and are capped at `8`.

### SQLite Redis multicore profile (opt-in)

SQLite can also run multiple Node processes when a private Redis service brokers
writes to the single SQLite writer. This is opt-in: with the profile disabled the
stack stays single-process SQLite exactly as before.

```bash
# Bundled private Redis, 1 control + 1 API worker
./install-docker.sh --sqlite-redis --yes

# External Redis (must be rediss:// unless loopback/private)
./install-docker.sh --sqlite-redis --redis-url rediss://user:pass@cache.example.com:6380/0 --yes
```

The installer writes the activation variables into `.env` (mode `600`) and never
prints the generated secrets:

```env
SQLITE_MULTICORE=redis
REDIS_URL=redis://:<generated>@redis:6379/0
REDIS_PASSWORD=<generated>
SQLITE_QUEUE_ENCRYPTION_KEY=<generated, distinct from REDIS_PASSWORD and API_KEY_SECRET>
BUNDLED_SQLITE_REDIS=1
API_WORKERS=2
```

`--sqlite-redis` and `--postgres` are mutually exclusive.

The bundled Redis service only runs under the `sqlite-multicore` profile, has no
host port, and is hardened for durability:

```bash
docker compose --profile sqlite-multicore up -d --build
```

| Setting | Value | Why |
| --- | --- | --- |
| `appendonly` | `yes` | AOF persistence so queued mutations survive a restart |
| `appendfsync` | `everysec` | Bounded loss window (see RPO below) |
| `maxmemory-policy` | `noeviction` | Never silently drop queued mutations under pressure |
| `maxmemory` | `REDIS_MAXMEMORY` (default `256mb`) | Bounded memory; growth fails writes instead of evicting |
| ports | none published | Reachable only over the Compose network |
| healthcheck | `redis-cli ... ping` | App `depends_on: redis (service_healthy, required: false)` |

---

## SQLite Redis Multicore Operations

### Telemetry loss semantics

Correctness mutations (provider state, credentials, routing counters) are
synchronous: the caller waits for the SQLite commit acknowledgement. Request
telemetry (usage rows, request details, footer logs) is **best-effort**: it
returns once Redis durably accepts the command, and an enqueue failure increments
a loss counter instead of failing the user request. Treat usage/detail gaps under
Redis outage as expected, not as data corruption.

### Durability and RPO

`appendfsync everysec` gives an RPO of roughly **one second**: an abrupt host loss
can discard at most the last second of accepted-but-unflushed telemetry. Correctness
mutations are unaffected because they wait for the SQLite commit before the worker
replies.

### Backup and restore

- SQLite data lives in the `9router-data` volume; Redis AOF lives in `9router-redis-data`.
- Back up SQLite with the writer quiesced (or `sqlite3 ... ".backup"`) and copy the
  AOF volume in the same window; restoring one without the other replays or loses
  queued telemetry.
- Restore: stop the stack, replace both volumes, start with the profile enabled.
  Pending stream entries replay automatically; already-committed receipts are
  no-ops.

### Metrics and health

- App `/api/health` stays the liveness check; internal readiness is loopback-only.
- Watch Redis `XLEN` on the mutation stream (queue depth), enqueue/commit latency,
  replay/duplicate/dead-letter counters, writer heartbeat, and telemetry-loss counters.
- Sustained queue growth means the SQLite writer is the bottleneck; do not add workers.

### Shutdown order

A stop (`docker compose ... down`, `docker stop --time 330 9router`) is ordered so
no accepted mutation is lost:

1. The container receives `SIGTERM`; the entrypoint stops the Go gateway first so
   no new requests are admitted.
2. Control and API workers drain active streams within the 330s grace period; the
   control process finishes the mutation-writer drain before exiting.
3. Only after the app container has exited does Compose signal Redis, which flushes
   its AOF and exits (`stop_grace_period: 60s`).

The app never stops Redis itself; Compose owns that step.

### Rollback

Roll back by removing the Redis activation and returning to one process:

```bash
# edit .env: SQLITE_MULTICORE=, REDIS_URL=, API_WORKERS=1
docker compose --profile sqlite-multicore down   # stop profile services
docker compose up -d --build
```

Stop accepting worker traffic before Redis so the control writer drains accepted
commands first. `API_WORKERS=1` with no `SQLITE_MULTICORE` is the unchanged
single-process SQLite default.

### PostgreSQL alternative

If multicore is needed for throughput rather than queue brokering, PostgreSQL
remains the supported path: `./install-docker.sh --postgres --yes` with
`API_WORKERS=3`. It needs no Redis, has no one-second telemetry window, and keeps
the same rollback (`API_WORKERS=1`).

---

### Manage container

```bash
docker logs -f 9router        # view logs
docker stop --time 330 9router  # stop
docker start 9router          # start again
docker rm -f 9router          # remove
```

---

## Data persistence

Host path: `$HOME/.9router/db/data.sqlite`
Container path: `/app/data/db/data.sqlite`

Data layout under `$DATA_DIR/`:

```text
$DATA_DIR/
├── db/
│   ├── data.sqlite       # main SQLite database
│   └── backups/          # auto backups
└── ...                   # certs, logs, runtime configs
```

Without `DATA_DIR`, the app falls back to `~/.9router/` (macOS/Linux) or `%APPDATA%\9router\` (Windows). In the container, `DATA_DIR=/app/data` makes the bind mount work.

---

## Optional env vars

```bash
docker run -d --stop-timeout 330 \
  -p 20128:20128 \
  -v "$HOME/.9router:/app/data" \
  -e DATA_DIR=/app/data \
  -e PORT=20128 \
  -e HOSTNAME=0.0.0.0 \
  -e DEBUG=true \
  --name 9router \
  decolua/9router:latest
```

---

## Optional Headroom sidecar

The 9Router image does not bundle Python or Headroom. To use Headroom in Docker, run it as a separate service and point 9Router at that proxy:

```yaml
services:
  9router:
    image: decolua/9router:latest
    ports:
      - "20128:20128"
    volumes:
      - "$HOME/.9router:/app/data"
    environment:
      DATA_DIR: /app/data
```

---

## Environment Variables Reference

| Variable | Default | Description |
| :--- | :--- | :--- |
| `APP_NAME` | `SantaiNetwork` | Dynamic branding displayed across UI and endpoints |
| `GATEWAY_PORT` | `20128` | Host port for Master Gateway & Dashboard |
| `PUBLIC_PORT` | `20140` | Host port for Public Usage Check and Docs |
| `INITIAL_PASSWORD` | auto-generated | Default admin password on first launch |
| `JWT_SECRET` | auto-generated | JWT token signing key |
| `MACHINE_ID_SALT` | auto-generated | Salt for deterministic CLI tokens |
| `API_KEY_SECRET` | auto-generated | Encryption salt for API keys |
| `DATABASE_URL` | empty (SQLite) | PostgreSQL URL (`postgres://user:pass@host:5432/db`) |
| `WORKER_ROLE` | `control` | `control` runs dashboard/auth/tunnel/MITM/MCP and background jobs; `api` runs request handling only |
| `API_WORKERS` | `1` | Total Node processes: `1` control + (`API_WORKERS` - 1) API workers. Must be `1` for SQLite |
| `ENABLE_GO_HYBRID` | `true` | Enables Golang Master Gateway and concurrency semaphores |
| `NODE_OPTIONS` | `--max-old-space-size=512` | Memory clamp preventing V8 heap runaway |

---

## Persistent Data Structure

Data is stored in the Docker volume `9router-data` mounted at `/app/data`:

```text
/app/data/
├── db/
│   ├── data.sqlite        # Main SQLite database (when not using PostgreSQL)
│   └── backups/           # Automated database backups
├── auth/
│   └── cli-secret         # Machine credentials
└── machine-id             # Stable container instance identity
```

To backup your SQLite database from Docker:

```bash
docker run --rm -v 9router-data:/data -v $(pwd):/backup alpine \
  cp /data/db/data.sqlite /backup/data.sqlite.bak
```

---

## Management Commands

Using the installer script:

```bash
# View live logs
./install-docker.sh --logs      # or: docker compose logs -f

# Restart services
./install-docker.sh --restart   # or: docker compose restart

# Stop services
./install-docker.sh --stop      # or: docker compose down

# Upgrade to latest code
./install-docker.sh --upgrade

# Uninstall containers (preserves data volume)
./install-docker.sh --uninstall

# Uninstall containers and purge data volume
./install-docker.sh --uninstall --purge
```

---

## systemd deployments

This repository ships no systemd unit; the installer-generated service (if used) should not be edited here. Configure multi-worker mode via the Environment override instead, for example:

```ini
[Service]
Environment=WORKER_ROLE=control
Environment=API_WORKERS=3
Environment=DATABASE_URL=postgres://user:pass@host:5432/9router
```

Keep the default single-process topology (`API_WORKERS=1`) on SQLite.
---

## Graceful Shutdown & Drain Timeout

9Router supports graceful shutdown with a 330-second (5.5 minute) drain window to allow in-flight requests to complete before container stop. This prevents request loss during rolling deployments or planned restarts.

### Docker Compose with Grace Period

```yaml
services:
  9router:
    image: decolua/9router:latest
    # ... other config ...
    stop_grace_period: 331s  # MUST exceed NINEROUTER_DRAIN_TIMEOUT_MS (default 330000ms = 330s)
```

### Direct Docker Usage

When running containers directly, use `--stop-timeout` to preserve the drain window:

```bash
docker stop --time 330 9router  # matches application's 330s drain
```

**Important**: Always document and respect the drain timeout in production runbooks. Never use bare `docker stop` which defaults to 10s — that will terminate active sessions.

---

## PostgreSQL Multi-Worker Semantics

Multi-worker mode requires PostgreSQL by default. SQLite supports multi-worker
only through the opt-in `sqlite-multicore` Redis profile (see
[SQLite Redis multicore profile](#sqlite-redis-multicore-profile-opt-in));
otherwise SQLite stays single-process (`API_WORKERS=1`).

### Total-Process Model

The total process count is calculated as:

```
Total Processes = 1 control + (API_WORKERS - 1) API workers
```

Example: `API_WORKERS=3` creates **1 control process + 2 API workers = 3 processes total**.

### Worker Role Distribution

- **control**: Handles dashboard UI, authentication tunnels, MITM proxy, MCP tools, and background jobs
- **api**: Stateless request handling only

On SQLite: must set `API_WORKERS=1` (single process runs both roles).

### Configuration Override

Edit systemd service environment or compose file:

```ini
[Service]
Environment=WORKER_ROLE=control
Environment=API_WORKERS=3
Environment=DATABASE_URL=postgres://user:pass@host:5432/9router
```

Rollback: set `API_WORKERS=1` and restart. Single-process mode is safe for SQLite deployments.
