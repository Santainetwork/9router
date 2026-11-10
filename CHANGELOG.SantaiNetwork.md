# Changelog — SantaiNetwork modifications

Local fork changelog for the SantaiNetwork build (dev on `:20130`, prod on
`:20128`). Base upstream version: **9Router v0.5.55** (currently merged through
v0.5.112). Not part of the upstream `CHANGELOG.md`.

---

## 2026-11-08 — CommandCode Transport Switch, Auth Failure Classification, Qoder, PostgreSQL Read-Only

### CommandCode transport switch, alpha CLI vs v1 OpenAI (`777ae196`, `a6e3493f`, `a881cf19`)
- Command Code serves two wires from one host/key: `/alpha/generate` (CLI envelope, AI-SDK NDJSON, the historical default) and `/provider/v1/chat/completions` (standard OpenAI, plan-gated per model). A connection now picks one via `providerSpecificData.commandcodeTransport`; any value other than `"v1"` keeps alpha, so existing connections are untouched.
- `open-sse/executors/commandcode.js`: `buildUrl()` targets v1, `buildHeaders()` drops the alpha-only `sessionId`, and `execute()` skips the NDJSON unwrap so upstream SSE/JSON passes through. Base URL is `COMMAND_CODE_API_BASE_URL` (default `https://api.commandcode.ai`).
- `getTargetFormat()` (`open-sse/services/provider.js`) returns `openai` for commandcode+v1; without it the body was still translated into the CLI envelope and upstream answered `400 expected array`.
- Effort: `resolveFormat()` (`thinkingUnified.js`) returns `openai` for commandcode when the target is `openai`, so `reasoning_effort` goes top-level instead of the alpha-only `params.reasoning_effort` that v1 ignores. Verified live: Kimi-K3.1-Pro `(low)` 200 with 67 reasoning tokens vs `(high)` 199.
- Thinking suffix (`model(high)`) is stripped from `params.model` in `openai-to-commandcode.js`; leaving it there made alpha answer `403 Model/provider not recognized`.
- UI: `CommandCodeTransportCard.js` on the provider page, saved via `PUT /api/providers/[id]`. Production value is `alpha`.

### Model-scoped failures no longer disable a credential (`405f6d0a`, `4f2868c6`, `e0c497db`)
- One upstream `404` used to write `testStatus: "unavailable"`. The model lock expired but the marker survived, so `getProviderCredentials()` skipped that account forever with no request left to clear it. Same trap for `400`, `406`, `429`, `5xx`.
- Classification now lives in `open-sse/services/accountFallback.js`: only `CREDENTIAL_ERROR_CODES` (`401`/`402`/`403`) may persist an unavailable marker; `NON_CREDENTIAL_ERROR_CODES` (`400`, `404`, `406`, `429`, `500`, `502`, `503`, `504`) write only a model lock and leave `testStatus`/`errorCode`/`lastError` alone. `skipsStaleUnavailable()` releases accounts already poisoned by an old marker.
- `404`/`406` now lock the model for 6 h (`MODEL_NOT_FOUND_LOCK_MS`) instead of re-probing a dead model every 2 minutes. The credential is never touched and other models on the account keep working.
- Clearing locks writes `undefined` rather than `null`, so the key actually disappears through `JSON.stringify`. 99 of 152 lock keys in production were dead nulls; those were cleaned.
- New tests: `auth-failure-classification.test.mjs`, `model-not-found-lock.test.mjs`, extended `auth-skip-unavailable.test.mjs`.

### Orphan tool results get a name (`d606f183`)
- OpenAI tool messages only carry `tool_call_id`. When the matching `assistant.tool_calls` entry is gone (clients trimming context), `toolName` was empty and Gemini via commandcode rejected the turn with `contents[N].parts[0].function_response.name: [REQUIRED_FIELD_MISSING]`. The translator resolves the name from history by `tool_call_id` and falls back to `unknown_function` instead of sending a 400.

### Qoder credit multiplier card (`8ca8c4f4`)
- Qoder's catalog publishes `price_factor` per chat model. `resolveQoderModels` carries it as `priceFactor`, `/api/providers/[id]/models` exposes it, and `QoderMultiplierCard.js` renders a sortable live table on the `qoder` / `qoder-cn` provider pages. Display-only; routing and billing untouched.

### Qoder image upload disabled by default (`24395b1a`, `db02b3f8`)
- Probing `/algo/api/v2/image/upload` against the live gateway showed the transport cannot carry images: multipart bodies always fail COSY validation (`403 signature invalid`), raw binary is rejected with the same 403 whenever the payload contains a UTF-8-encoded surrogate (`ED A0..BF`, which compressed image data hits immediately), and an ASCII base64 body validates but answers `500` for PAT-derived (`jt-...`) tokens.
- Uploads are now off unless `QODER_IMAGE_UPLOAD=1`. Images ≤ 512 KB stay inline as data URIs, larger ones become a text stub, and vision still answers 200.

### Release gate and provider baseline (`bebc53ab`, `311f6f5c`)
- `verify-release.sh` ignores `route-cache` along with `cache/`: Next writes `.next/server/route-cache` at runtime, so a healthy release always failed the byte-identical diff.
- `providers-baseline.json` refreshed after the v0.5.112 merge (`sensenova`, `runcrate`, `codebuddyHeaders` hooks, `reasoningAliasFields`).

### PostgreSQL read-only incident (hotfix, no code change)
- Brief window where the production database endpoint answered read-only; `PUT /api/providers/[id]` 500s and a dependent service's heartbeat failed. Fixed by pointing `DATABASE_URL` at a writable endpoint and restarting, no code change, no deploy. Details and runbook are in the internal ops notes under `docs/` (not committed).
---

## 2026-10-25 — RPM Spillover, Queue RPM Bar, Credit Multiplier Table

### RPM-blocked account spills over like a concurrency-full one (`src/sse/handlers/chat.js`)
- An account at its RPM ceiling used to make the request queue for the rest of the window even when another account had headroom, costing latency (and a 429 on a short queue timeout) with capacity sitting idle. The account-selection loop now treats both counters the same: skip the blocked account, try the next one, and only queue once every account is exhausted. `concurrencyFullCandidates`/`probeConcurrency` renamed to `limitFullCandidates`/`probeLimits`.
- `tests/unit/chat-concurrency-spillover.test.mjs` case (d) updated: RPM-blocked A + free B now asserts a 200 served by B (previously pinned the queue-on-A behavior).

### RPM usage bar in the Queue Monitor (`/dashboard/queue-monitor`)
- The RPM column showed only the configured limit. It now renders `inWindow / limit` with the same bar treatment as Capacity (info, amber at 70%, red at full) on both the API key and provider tables. Header relabeled "RPM (used / min)".

### CodeBuddy credit multiplier table (`/dashboard/usage`)
- New reference table on each CodeBuddy CN/Intl connection card showing the published Credit multiplier (积分倍率) per model, sortable by model or multiplier. `src/shared/constants/codebuddyMultipliers.js` holds the values; `CodebuddyMultiplierTable.js` renders them. Display only, never fed to routing or billing.

### Combo search crash fix (`/dashboard/combos`)
- Upstream `9b4ea9eb` read `normalizedQuery` in the toolbar without declaring it, throwing `ReferenceError` before first paint so the whole page fell through to Next's error boundary. Fixed to use the declared `comboSearch` state, with a regression test in `tests/unit/combo-page-search-ui.test.mjs`.

### Fork version
- `forkVersion` moved off the placeholder `0.1.0` to `0.3.0`: 0.1 the original feature set, 0.2 the Go gateway + PostgreSQL rearchitecture, 0.3 this batch. `pkg.version` (upstream) is untouched.

---

## 2026-10-09: Per-Combo Context Window Override

### Published Context Window Override (`combos.contextWindow`)
- Added an optional per-combo `contextWindow` (SQLite/PostgreSQL `INTEGER`, `SCHEMA_VERSION` 6 → 7) that overrides the `context_length` a combo publishes in `/v1/models`. Clients (jcode among them) cache that number, and the derived value (the minimum across seats) is sometimes wrong for the combo as a product, or absent entirely (`null`) when no seat resolves.
- An override also applies when the combo is expanded as a **nested seat** of a parent combo: the nested combo's own published window is authoritative for that seat, while the parent still takes the minimum across all its seats (an override cannot raise a parent above a smaller sibling).
- Emission honours the override in both places a combo advertises its window: snake_case `context_length` and the camelCase `capabilities.contextWindow` block.
- Combo form (`/dashboard/combos`) gained a "Context window (optional)" field; empty means "smallest seat wins". `ComboCard` marks a pinned combo so the override is visible at a glance. Both form implementations (dashboard page and the shared `ComboFormModal` used by Cowork) were updated, plus the Cowork combo-creation path.
- Validation is split: the API (`POST /api/combos`, `PUT /api/combos/[id]`) and `importDb` reject a malformed value with a 400 / thrown error naming the combo, while the storage layer coerces junk to `NULL` rather than failing a read. `PUT` treats an absent key as "keep stored value" and an explicit `null` as "clear it".
- Backup/restore carries the column; a backup written before this version restores as "no override" (previous behaviour), and the legacy JSON migration path imports a malformed value as `NULL` without aborting the migration.

### Installer Fix (found while deploying this change)
- `scripts/install.sh` reported `aborted at line 1 (exit 1)` after a fully successful upgrade. `reap_stage()` ended on `[ -e "$STAGE_DIR" ]`, which is false in the normal success path (the stage was just swapped into place), so the EXIT trap returned 1; with `set -E` + `trap on_error ERR` that re-entered the ERR trap during exit. The upgrade itself was already verified and the rollback disarmed. Only the exit status lied. The same defect also masked genuine non-zero exits (e.g. the `exit 3` refusal) as 1. Fixed by making the handler return 0 explicitly; `tests/unit/install-script-safety.test.mjs` now runs the shipped handler verbatim under `set -E` and asserts both exit 0 and exit 3 survive.

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
- Use `scripts/install.sh --dry-run` before installation or upgrades.
- Use `scripts/install.sh --upgrade` for an atomic release swap with automatic backup and rollback.
- Runtime paths are configurable through `INSTALL_DIR`, `RELEASE_DIR`, `DATA_DIR`, and the generated environment file; no host-specific directory is required.
- Production topology: Go master gateway on `:20128`, Next.js backend on loopback `:20127`, limiter RPC on `:20129`, public portal on `:20140`.
