# Changelog — SantaiNetwork modifications

Local fork changelog for the SantaiNetwork build (dev on `:20130`, prod on
`:20128`). Base upstream version: **9Router v0.5.55**. Not part of the upstream
`CHANGELOG.md`.

---

## 2026-09-15 — Golang Master Gateway Cutover, PostgreSQL Dual-Database & Memory Hardening

### Golang Master Gateway on Port :20128 & Public Proxy on :20140
- Migrated primary port `:20128` to **Golang Master Gateway** (`router-engine`), taking over front-door request reception, lightweight goroutine concurrency gating on `/v1/*`, and transparent proxying to Next.js on internal loopback `127.0.0.1:20127`.
- Absorbed public-only reverse proxy on port `:20140` into the compiled Go binary, serving `/usage-check` and `/docs` directly from disk with zero Next.js runtime overhead and retiring the old Node.js proxy process (`9router-public-proxy.service`).
- Added high-speed atomic RPC limiter on port `:20129` with 10-minute automated idle bucket reaping and per-slot 5-minute watchdog expiration tracking.
- Added live engine telemetry indicators across Dashboard (`/dashboard`), Queue Monitor (`/dashboard/queue-monitor`), and Usage Check (`/usage-check` and `:20140`).

### Dual-Database Engine: SQLite or PostgreSQL & Migration Tool
- Added `postgresAdapter.js` implementing complete adapter contract (`run`, `get`, `all`, `exec`, `transaction`, `close`).
- Implemented robust SQL parameter translation from SQLite `?` to PostgreSQL `$1, $2, ...` and DDL normalization (`SERIAL PRIMARY KEY`, `NOW()`).
- Added seamless environment configuration via `DATABASE_URL` or `DB_TYPE=postgres`, falling back to SQLite when unset.
- Created `scripts/migrate-sqlite-to-postgres.mjs` supporting table-by-table batch migration, conflict handling, auto-increment sequence realignment, and `--dry-run` inspection.

### Memory Leak Hardening & Streaming Closure Severing
- Severed object tree closures in `streamingHandler.js`: `requestConfigSnapshot` and `providerRequestSnapshot` are saved immediately, and `body`, `translatedBody`, `finalBody` references are explicitly `null`-ed so V8 garbage collector can immediately free large message trees (300k+ tokens) during streaming.
- Immediate payload truncation in `requestDetailsRepo.js` before inserting into memory `writeBuffer`.
- Enforced `NODE_OPTIONS="--max-old-space-size=512"` in systemd override, clamping V8 heap and dropping Next.js RAM consumption from 1.2 GB to ~250 MB.
- Fixed CORS preflight by permitting HTTP `OPTIONS` requests in `src/dashboardGuard.js`.

---

## 2026-09-06 — Live Concurrency Telemetry & Dynamic Branding

### Dynamic System Branding
- Added configurable `appName` in `settingsRepo.js` (defaulting to `SantaiNetwork`).
- Added Branding management card in `/dashboard/profile` allowing immediate inline renaming and persistence to SQLite database (`settings` table).
- Broadcasts changes across the active browser window via `app-name-changed` custom event.
- Propagates dynamic name to `Sidebar`, `Header`, `layout.js`, `login/page.js`, and `usage-check/page.js`.
- Public endpoint `/api/auth/status` reflects `appName` for pre-authenticated views.

### Real-Time In-Flight Concurrency Live Tracking
- Enriched `/api/v1/usage` with real-time `live` object: `activeConcurrency`, `queuedRequests`, `requestsInWindow`, and `windowResetInMs` derived from in-memory semaphore bucket (`getBucketDetail("apikey", id)`).
- Added sub-millisecond fast-path `/api/v1/usage?live=1` that bypasses token aggregation history queries.
- Built Neobrutalism **Live Concurrency Tracker** card on `/usage-check` (served on port `:20128` and public proxy `:20140`).
- Features 2.5s auto-polling, pulsing live indicator, manual pause/resume, and color-coded load saturation bar (emerald, amber, red).

---

## 2026-08-14 — SantaiNetwork feature set

### Dashboard
- **Overview homepage** (`/dashboard`): at-a-glance landing page with stat cards
  (active providers, API keys, 7-day requests, 7-day cost), a quick-access grid,
  recent activity, and top API keys by token usage. The old Endpoint UI moved to
  `/dashboard/endpoint`; an "Overview" sidebar entry was added.
  Commit `9b42f200`.

### Basic Chat
- Fixed the 404 by proxying `/api/dashboard/chat/completions` to `handleChat`,
  injecting the active API key server-side when the client sends none.
- Added a manual API-key input (persisted) and a retry button (shared
  `runStream` for send + retry).
- Split model selection into a **two-step Provider → Model picker** scoped to the
  chosen provider. Each model option shows its name plus the full request id
  **with provider prefix** (`provider/model.id`).
  Commits `9c2eafab`, `760f05de`, `981c5318`.

### Per-API-key RBAC
- Schema: `apiKeys.allowedModels` (JSON) + `apiKeys.tokenQuota` (INTEGER),
  auto-migrated (schema 1 → 2, with a pre-migration DB backup).
- Gate `enforceApiKeyAccess()` in `rateLimitGate.js`: model allowlist (matched by
  full id or the part after `/`) and all-time token quota. Wired into chat and
  every media handler (embeddings, image, TTS, STT, search, video).
- `PUT /api/keys/[id]` accepts `allowedModels` + `tokenQuota`; `GET /api/keys`
  returns `tokensUsed`.
- **Key Access Control page** (`/dashboard/api-keys`): per-key RPM, queue timeout,
  token quota (+usage bar), and a **searchable multi-select** for allowed models
  sourced from `/api/v1/models`.
  Commits `760f05de`, `981c5318`, `db26a139`.

### Full theme customization
- `themeStore`: custom `palette` (background, surface, text, border) + base
  `radius`, on top of the existing accent + light/dark.
- **8 presets** (Default, Ocean, Forest, Rose, Grape, Mono, Paper, Midnight) that
  apply a coherent scheme and auto-switch light/dark.
- Derived vars keep overrides coherent (surface ladder, muted text, alt bg,
  subtle border); radius maps to the brand tokens and Tailwind
  `rounded-sm/md/lg/xl`.
- Profile page: preset grid, per-color pickers, radius slider, reset-all.
  Commit `119dc584`.

### Self-service usage check (for sharing over a domain)
- `GET /api/v1/usage` — a caller authenticates with **their own API key**
  (Bearer / `x-api-key` / `?api_key=`) and gets back only that key's data:
  limits (`requestsPerMinute`, `queueTimeoutMs`, `tokenQuota`), access
  (`restricted` + `allowedModels`), and usage (tokens used all-time, remaining,
  plus a period breakdown `byModel` / `byDay`). Period `1d`–`30d`, default `7d`.
  CORS enabled; also reachable at `/v1/usage` via rewrite, so it works behind
  Cloudflare → Safeline WAF → 9router.
- **Public UI page** `/usage-check` (outside the auth-gated dashboard): paste a
  key, pick a period, see limits, allowed/accessible models, quota + remaining
  bar, and usage-by-model.
- New repo helpers `getApiKeyByKey` + `getApiKeyUsageInRange`.
  Commits `99ce3b59`, `5588d54b`.

### Admin request-queue monitor
- Builds on the earlier per-API-key / per-provider RPM limiter + FIFO request
  queue with timeout (`0295bb99`) and its RPM/queue-timeout config UI
  (`88a820f6`).
- `rateLimiter.queueSnapshot()` — snapshot of every RPM bucket with `queued`,
  `inWindow`, and `rpm`, plus totals.
- `GET /api/queue` (admin) — the snapshot enriched with human-readable API-key /
  provider names.
- Overview page: a live **Request queue** card polling every 5s, showing how many
  requests are queued (waiting on an RPM slot) per key / provider.
- **Dedicated page** `/dashboard/queue-monitor` (sidebar "Request Queue"):
  totals, a per-bucket table (name, scope, rpm, in-window, queued, window reset),
  pause/resume, 3s polling.
  Commits `4fd4eef8`, `bd9fc451`.

### Attribution
- "Modified by SantaiNetwork" added to the sidebar header, login page, the Key
  Access Control page, the Overview page, and the public usage-check page.

---

## Operational notes
- Dev refresh: `sudo bash /opt/9router/refresh-9router-rl.sh` (rebuild + restart
  `9router-rl.service` on `:20130`). Does not touch prod.
- Prod (`:20128`) is deployed by swapping the bundle under
  `/usr/lib/node_modules/9router/app` (backup → stage `app.new` → pre-ready boot
  test against the main DB → atomic rename → restart). Rollback bundle kept as
  `app.old`; DB pre-migration backup under `.9router/db/backups/`.
- Databases: dev `/var/lib/9router-rl/.9router`, prod `/var/lib/9router/.9router`.
