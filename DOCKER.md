# 🐳 9Router Docker Deployment & Installer

Deploy 9Router SantaiNetwork Edition in an isolated, multi-platform Docker container stack. Recommended for operating systems without systemd (Alpine, macOS, Windows WSL, Synology NAS, Proxmox LXC, or containerized VPS).

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
./install-docker.sh --database-url "postgres://user:pass@db.example.com:5432/9router" --yes
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

## 🚀 Manual Docker Compose Deployment

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
# Build and run with default SQLite database
docker compose up -d --build

# Or run with containerized PostgreSQL service
docker compose --profile postgres up -d --build

# Or run with Headroom prompt compression sidecar
docker compose --profile headroom up -d --build
```

---

## 🧩 Multi-Worker Mode (PostgreSQL only)

### What `API_WORKERS` means

`API_WORKERS` counts **total Node processes**, not API-only processes:

- `API_WORKERS=1` (default): exactly **one** Node process, running `WORKER_ROLE=control`. This is the only supported mode for SQLite.
- `API_WORKERS=N` with `N > 1` (**PostgreSQL required**): Total Node processes = 1 control + `API_WORKERS` - 1 API workers. The control process (`WORKER_ROLE=control`) keeps dashboard, auth, tunnel, MITM, MCP, quota auto-ping, and background token refresh. The API workers (`WORKER_ROLE=api`) serve request handling only. The Go gateway round-robins `/v1/`, `/v2/`, `/api/v1/`, `/api/v2/` across healthy workers; admin/dashboard routes stay on the control process.

Example: `API_WORKERS=3` means **1 control + 2 API workers**.

### PostgreSQL multi-worker example (one control + two API workers)

Edit `.env`:

```env
DATABASE_URL=postgres://user:pass@db.example.com:5432/9router
WORKER_ROLE=control
API_WORKERS=3
```

Then start the stack (with the bundled PostgreSQL profile if needed):

```bash
docker compose --profile postgres up -d --build
```

This launches a single container that runs `1` control process bound to the internal backend port, `2` API workers on internal loopback ports `20131` and `20132`, and the Go gateway front door. SQLite is intentionally rejected here: `API_WORKERS>1` or `WORKER_ROLE=api` without `DATABASE_URL=postgres://...` (or `DB_TYPE=postgres`) fails closed at startup.

API worker ports are **internal only**. Only the Master Gateway (`20128`) and the public proxy (`20140`) are exposed; the backend port and worker ports never leave the container.

### Rollback

Set `API_WORKERS=1` (and optionally `WORKER_ROLE=control`) in `.env`, then `docker compose up -d` again. The stack returns to a single Node process. This is the recommended rollback for SQLite and for any database not on PostgreSQL.

### systemd deployments

This repository ships no systemd unit; the installer-generated service (if used) should not be edited here. Configure multi-worker mode via the Environment override instead, for example:

```ini
[Service]
Environment=WORKER_ROLE=control
Environment=API_WORKERS=3
Environment=DATABASE_URL=postgres://user:pass@host:5432/9router
```

Keep the default single-process topology (`API_WORKERS=1`) on SQLite.

---

## 🛠️ Management Commands

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

## 📁 Persistent Data Structure

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

## ⚙️ Environment Variables Reference

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
