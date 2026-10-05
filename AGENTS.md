# 🚀 9Router Custom Enhancements - Complete Documentation

## Current State
- **Active Branch**: `master` (and `dev`)
- **Latest Version**: `v0.5.75-custom` (Upstream merged from `origin/master`)
- **Status**: Production Ready ✅ (all tests passing)

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

# Build standalone production bundle
npm run build

# Deploy to configurable release directory and restart
INSTALL_DIR="${INSTALL_DIR:-$(pwd)}"
RELEASE_DIR="${RELEASE_DIR:-/opt/9router-release}"
cp -a "$INSTALL_DIR/.next/standalone/." "$RELEASE_DIR/"
cp -a "$INSTALL_DIR/.next/static" "$RELEASE_DIR/.next/static"
cp -a "$INSTALL_DIR/public" "$RELEASE_DIR/public"
cp -a "$INSTALL_DIR/custom-server.js" "$RELEASE_DIR/custom-server.js"
systemctl restart 9router-hybrid-engine
systemctl restart 9router
curl http://localhost:20128/api/health
```

---

*Last Updated: September 15, 2026*  
*Version: v0.5.75-custom*  
*Maintained by: SantaiNetwork AI Infrastructure Team*
