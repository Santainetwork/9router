# 🚀 9Router Custom Enhancements - Complete Documentation

## Current State
- **Active Branch**: `master` (and `dev`)
- **Latest Version**: `v0.5.75-custom` (Upstream merged from `origin/master`)
- **Status**: Production Ready ✅ (all tests passing)

**Installer distDir pitfall**: `scripts/install.sh` builds with plain `npm run build` and defaults `DIST_DIR_NAME="${NEXT_DIST_DIR:-.next}"`. On this host the live bundle is `.next-tailadmin`, so `install.sh --upgrade` without `NEXT_DIST_DIR=.next-tailadmin` writes the santai build and `.dist-dir` then records `.next` wrongly. Always upgrade with `NEXT_DIST_DIR=.next-tailadmin` (or use the manual build:tailadmin flow below), then run `bash scripts/verify-release.sh` (it prefers the recorded `.dist-dir` and needs repo/release byte-identical on that dir).

---

## 📋 Core Customizations

### 1. Upstream Model & Prefix Tracking ✅ WORKING
**Purpose**: Display actual provider-prefixed models (e.g., `ag/claude-sonnet-4-6`, `bai/deepseek-v4-flash`, `amanai/qwen3.8-max-preview`) in dashboard and recent usage stream without loss across process lifecycles.

**Implementation**:
- Modified: `open-sse/handlers/chatCore.js`
- Modified: `open-sse/handlers/chatCore/streamingHandler.js`
- Modified: `src/lib/db/repos/usageRepo.js`: `entry.meta = { requestedModel, upstreamModel }` synced before `pushToRing`.
- Modified: `src/lib/db/repos/requestDetailsRepo.js`: Persist `upstreamModel` & `requestedModel` in DB flush whitelist.

---

### 2. Golang Master Gateway & Hybrid Concurrency Engine ✅ DEPLOYED IN PRODUCTION
**Purpose**: High-speed front-door reverse proxy, bulletproof in-flight concurrency control, and atomic queue buffering offloaded to compiled Go (`router-engine`), eliminating Node.js memory bloat from queued connections and transient rate-limiter buckets.

**Implementation**:
- `hybrid-engine/cmd/engine/main.go` & `hybrid-engine/pkg/proxy/proxy.go`:
  - **Master Gateway (`:20128`)**: Receives all external incoming traffic, performs front-door concurrency gating on `/v1/*` in lightweight Go goroutines, and transparently forwards UI/API requests to Next.js on internal port `127.0.0.1:20127`.
  - **Public Proxy (`:20140`)**: Serves public-only endpoints (`/usage-check`, `/docs`) directly from disk with zero Next.js runtime overhead, blocking admin routes with 404.
- `hybrid-engine/pkg/limiter/limiter.go`: Microsecond concurrency semaphores on port `:20129`, per-slot `inFlightTimes` tracking, 10-minute idle bucket eviction, and atomic queue pump.
- `open-sse/services/hybrid/goLimiterClient.js`: Client bridge with circuit breaker and automated fallback to JS limiter if Go engine is unreachable.
- `open-sse/services/rateLimiter.js`: Delegated `goAcquire` / `goRelease` with transparent fallback to `jsAcquire`.
- `systemd`:
  - `9router-hybrid-engine.service`: Go binary managing `:20128` (master gateway), `:20129` (limiter), and `:20140` (public proxy).
  - `9router.service`: Next.js App Router on internal loopback `127.0.0.1:20127` with `NODE_OPTIONS="--max-old-space-size=512"`.
  - `9router-worker@.service` / `9router-worker-env@.service` / `9router-workers.target`: stateless API worker instances fronted by the gateway.
  - **Propagation**: the worker template and the engine unit carry `PartOf=9router.service`, and `9router.service` carries `Wants=9router-workers.target 9router-hybrid-engine.service` (with no `After=`). `systemctl restart 9router` therefore restarts the workers and the gateway, `stop` drains them, and `start` brings them back. Do NOT add `After=` on `9router.service` toward the worker target or the engine: that closes an unbreakable ordering cycle (`9router.service -> 9router-worker@ -> 9router-worker-env@ -> 9router.service`).
  - **Known boundary (crash only)**: propagation above covers explicit `restart`/`stop`/`start` jobs. A hard crash of `9router.service` (e.g. `SIGKILL`) triggers its `Restart=on-failure` respawn, but that automatic job does NOT itself re-attach the workers or the engine; the gateway stays `000` until the interrupted systemd job chain re-runs. Measured on this host: gateway non-200 for roughly 8s, full recovery of all four units by ~10s, no manual intervention. Closing that gap would require `Requires=9router.service` on the engine and worker template (whose teardown also fires on crash), which has NOT been applied because it risks re-introducing the ordering cycle above. Any change here must re-run `systemd-analyze verify` and the cycle scan first.
- Telemetry & UI: Real-time engine indicators in Dashboard (`/dashboard`), Queue Monitor (`/dashboard/queue-monitor`), and Usage Check (`/usage-check` and `:20140`).

---

### 3. Model Allowlist Wildcard Matching ✅ DEPLOYED
**Purpose**: Flexible API key access governance allowing prefix wildcards (e.g., `hx/*`, `myr/*`, `ag/*`, `*`).

**Implementation**:
- `src/sse/services/rateLimitGate.js`: `isModelAllowedBy` supports prefix wildcard patterns, exact matches, and global `*`.
- `src/app/api/v1/models/route.js`: Catalog listing automatically filters models allowed by the key's wildcard mask.

---

### 4. Custom Provider Credit & Balance Checking System ✅ DEPLOYED
**Purpose**: Enable automatic and configurable credit/quota balance tracking for custom OpenAI-compatible and Custom Embedding endpoints in Quota Tracker.

**Implementation**:
- File: `open-sse/services/usage/customCompatible.js`
- File: `open-sse/services/usage.js` (routed `openai-compatible-*` & `custom-*`)
- File: `src/app/api/providers/client/route.js` & `src/app/api/usage/[connectionId]/route.js`
- File: `src/shared/components/EditConnectionModal.js` & `src/app/(dashboard)/dashboard/providers/[id]/AddApiKeyModal.js`
- File: `src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js` (compact number formatting & generic quota fallback)

---

### 5. API Keys & Providers Leaderboard & CSV Export ✅ DEPLOYED
**Purpose**: Real-time usage volume, cost, latency, and token monitoring dashboard.

**Features**:
- Canonical Route: `/api/usage/leaderboard` (with `/api/leaderboard` backward-compatible shim).
- URL Paths: `/dashboard/leaderboard` and `/leaderboard`.
- Visual ranking badges (🥇🥈🥉).
- Relative volume progress bars (% share of total).
- KPI Summary Cards (Total Requests, Tokens, Costs, Active Providers).
- Interactive multi-column sorting and instant search filtering.
- **Export CSV** button generating standard RFC-4180 CSV snapshots.

---

### 6. Response Footer Deduplication & Previous Turn Cleaning ✅ DEPLOYED
**Purpose**: Append metadata footer at end of responses while strictly preventing footer stacking/duplication across multi-turn conversations.

**Implementation**:
- `open-sse/handlers/chatCore/responseFooter.js`: 
  - `stripFootersFromMessages`: Automatically cleans prior footer signatures from assistant conversation history before forwarding to upstream.
  - `hasFooterSignature`: Stream and JSON dedup check preventing duplicate injections.
  - Excludes `finish_reason: "tool_calls"` from terminal footer triggers.
  - Robust scope matching for `"both"`, `"v1"`, `"v2"`, and comma-separated `"v1,v2"`.

---

### 7. Dedicated `/v1/nosaver` Endpoint ✅ DEPLOYED
**Purpose**: Provide a clean public endpoint that disables all token savers (Headroom, Caveman, Ponytail, RTK, PXPIPE) while retaining `/v1` footer scope.

**Endpoints**:
- `/v1/nosaver/chat/completions` (and `/api/v1/nosaver/chat/completions`)
- `/v1/nosaver/messages` (and `/api/v1/nosaver/messages`)
- `/v1/nosaver/messages/count_tokens` (and `/api/v1/nosaver/messages/count_tokens`)
- `/v1/nosaver/models`

---

### 8. Neobrutalism UI Portal & Accent System ✅ DEPLOYED
**Purpose**: High-contrast, tactile public quota checker and UI accents.

**Implementation**:
- `src/app/usage-check/page.js`: High-fidelity Neobrutalism on port `:20128`.
- `deploy/usage-check.html`: Standalone Neobrutalism portal served on public reverse proxy `:20140`.
- `src/components/ui/button.jsx` & `src/components/ui/badge.jsx`: Added tactile `neo` variants (bold 2px borders, 4px/2px hard offset shadows, active translation feedback).

---

### 9. Upstream Merge v0.5.75 ✅ SYNCHRONIZED
- Merged all 29 commits from `origin/master` (v0.5.75: OpenRouter and Vertex AI Veo video generation, Antigravity weekly quota tracking, Codex GPT Image 2.5 / Flare / Sunburst image models, Qoder usage and attachments escalation, OpenCode Go catalog and models, DeepSeek Anthropic-only tool types, Claude cache_control budget fix, Xiaomi MiMo dual auth desktop integration).

---

### 10. Dynamic System Branding & Gateway Name ✅ DEPLOYED
**Purpose**: Allow administrators to customize the system branding name in real-time defaulting to `SantaiNetwork` with immediate persistence and live broadcast across the UI and endpoints.

**Implementation**:
- `src/lib/db/repos/settingsRepo.js`: `appName` setting with fallback to `process.env.APP_NAME || "SantaiNetwork"`.
- `src/app/api/settings/route.js`: Admin-protected `appName` normalization and SQLite persistence in `settings` table.
- `src/app/api/auth/status/route.js`: Public `appName` reflection for login, pre-auth, and external portals.
- `src/app/(dashboard)/dashboard/profile/page.js`: Branding settings card with instant inline update, loading feedback, and `app-name-changed` custom window event dispatch.
- `src/shared/components/Sidebar.js`, `src/app/login/page.js`, `src/app/layout.js`, and `src/app/usage-check/page.js`: Real-time consumption of dynamic gateway name.

---

### 11. Real-Time Live Concurrency Telemetry on Usage Check ✅ DEPLOYED
**Purpose**: Provide key owners with live telemetry on in-flight concurrency slots, buffer queue waiters, and saturation percentage without running heavy token historical queries.

**Implementation**:
- `src/app/api/v1/usage/route.js`:
  - Enriched response with `live: { activeConcurrency, queuedRequests, requestsInWindow, windowResetInMs, updatedAt }` from `getBucketDetail("apikey", id)`.
  - Fast-path sub-millisecond query (`?live=1` or `?live_only=true`) bypassing token aggregation queries.
- `src/app/usage-check/page.js` & `deploy/usage-check.html`:
  - Real-Time Live Concurrency Tracker card in Neobrutalism design tokens.
  - Animated pulsing indicator with 2.5-second polling interval and manual pause/resume control.
  - Three real-time telemetry metrics:
    - **In-Flight Active**: Current consumed slots vs configured maximum limit (`active / limit`).
    - **Buffered in Queue**: Number of requests waiting in memory for available concurrency slots.
    - **Concurrency Load**: Color-coded load bar (emerald <75%, yellow 75-99%, red saturated at 100%).

---

### 12. Dual-Database Engine: SQLite or PostgreSQL & Migration CLI ✅ DEPLOYED
**Purpose**: Provide enterprise database flexibility allowing zero-downtime switching between local SQLite and external PostgreSQL instances.

**Implementation**:
- `src/lib/db/adapters/postgresAdapter.js`: PostgreSQL adapter with query placeholder translation (`?` ➡️ `$1, $2, ...`), schema migration runner (`SERIAL PRIMARY KEY`), and full transaction support.
- `src/lib/db/driver.js`: Automatic driver selection via `DATABASE_URL=postgres://...` or `DB_TYPE=postgres`, seamlessly falling back to SQLite when unset.
- `scripts/migrate-sqlite-to-postgres.mjs`: Automated CLI migration tool supporting table-by-table batch copy, conflict handling, and sequence alignment with `--dry-run` inspection mode.

---

### 13. Memory Leak Hardening & Streaming Closure Severing ✅ DEPLOYED
**Purpose**: Fix V8 heap accumulation during long-lived streaming requests and large context window conversations (300k+ tokens), reducing Next.js RAM from 1.2 GB to ~250 MB.

**Implementation**:
- `open-sse/handlers/chatCore/streamingHandler.js`: Snapshot essential request configuration immediately, then sever object tree references (`body = null`, `translatedBody = null`, `finalBody = null`) inside `buildOnStreamComplete` so V8 garbage collection can reclaim memory immediately without waiting 30–60s for stream completion.
- `src/lib/db/repos/requestDetailsRepo.js`: Truncate large request and response bodies before buffering into the in-memory `writeBuffer`.
- `systemd` Heap Clamp: Enforced `NODE_OPTIONS="--max-old-space-size=512"` in `override.conf` ensuring V8 triggers timely garbage collection cycles.

---

### 14. Request Logs & Dashboard Navigation ✅ DEPLOYED
**Purpose**: Provide authenticated request-level observability with searchable request history, model/provider metadata, status, latency, token counts, streaming state, and error details.

**Implementation**:
- `src/app/(dashboard)/dashboard/request-logs/page.js`: Request Logs dashboard page.
- `src/app/api/request-logs/route.js`: Authenticated list and filter API.
- `src/lib/db/repos/requestLogsRepo.js`: Request log persistence and queries.
- `src/lib/db/schema.js`: `requestlogs` table schema and indexes.
- `src/shared/components/Sidebar.js`: `/dashboard/request-logs` navigation entry in both SantaiNetwork and TailAdmin themes.
- `tests/unit/friend-ui-request-logs.test.mjs`: Regression coverage for route and navigation visibility.

**Operational note**: PostgreSQL startup may log a non-fatal duplicate `requestlogs.id` column warning during schema synchronization. Verify live schema before any repair. Expected state: 21 `requestlogs` columns, primary key `requestlogs_pkey`, indexes `idx_rl_key`, `idx_rl_status`, and `idx_rl_ts`.

---

## 🔧 Verification & Testing

```bash
# Run unit test suite (all 60 tests passing)
npm run verify

# Run automated Neobrutalism E2E test
node --test tests/unit/neobrutalism-usage-check-e2e.test.mjs

# Run PostgreSQL adapter unit tests
node --test tests/unit/db-postgres-adapter.test.mjs

# Run Go hybrid engine tests with race detector
cd hybrid-engine && go test ./... -race

# Build standalone production bundle.
# NOTE: the live service serves the tailadmin (friend) bundle, NOT the default
# distDir. next.config.mjs resolves distDir from NEXT_DIST_DIR (default .next,
# the santai build), which 9router.service never reads. Set it explicitly:
# a plain `npm run build` writes .next and the live build goes stale silently.
# build:tailadmin also runs copy-standalone-assets.mjs, so the standalone tree
# already carries $DIST/static, public/ and custom-server.js.
npm run build:tailadmin

# Deploy to configurable release directory and restart.
# Mirror install.sh's stage+swap shape: copy the standalone tree, then run the
# post-deploy gate (verify-release.sh) which requires repo and release to be
# byte-identical on $DIST. Do NOT copy static/ separately once the standalone
# bundle ships it, that is the static/static nesting the gate rejects.
INSTALL_DIR="${INSTALL_DIR:-$(pwd)}"
RELEASE_DIR="${RELEASE_DIR:-/opt/9router-release}"
DIST="${DIST:-.next-tailadmin}"
cp -a "$INSTALL_DIR/$DIST/standalone/." "$RELEASE_DIR/"
if [ -d "$RELEASE_DIR/$DIST/static/static" ]; then rm -rf "$RELEASE_DIR/$DIST/static/static"; fi
printf '%s' "$DIST" > "$RELEASE_DIR/.dist-dir"
bash scripts/verify-release.sh || { echo 'gate failed, release not restarted'; exit 1; }
systemctl restart 9router-hybrid-engine
systemctl restart 9router
# Node needs a few seconds to bind; a bare curl right after restart races it.
for i in $(seq 1 30); do curl -sf -m 2 http://localhost:20128/api/health && break; sleep 2; done
curl -sf -m 5 http://localhost:20128/api/health >/dev/null || { echo 'health check failed'; exit 1; }
```

---

*Last Updated: September 15, 2026*  
*Version: v0.5.75-custom*  
*Maintained by: SantaiNetwork AI Infrastructure Team*
