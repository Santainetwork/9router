# 🚀 9Router Custom Enhancements - Complete Documentation

## Current State
- **Active Branch**: `master` (and `dev`)
- **Latest Version**: `v0.5.69-custom` (Upstream merged from `origin/master`)
- **Status**: Production Ready ✅ (40/40 tests passing)

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

### 2. Concurrency Engine, FIFO Auto-Queue & Zero-Leak Limiter ✅ DEPLOYED
**Purpose**: Bulletproof in-flight concurrency control preventing slot leaks across stream lifecycles, client aborts, and upstream parallel limits.

**Implementation**:
- `open-sse/services/rateLimiter.js`: In-flight semaphore with atomic slot management, 10-minute watchdog auto-decay, and auto-queue buffering (default 60s timeout) when concurrency is saturated instead of immediate 429 rejects.
- `src/sse/handlers/chat.js`: Complete closure binding of `safeReleaseApiKey` and `releaseProvider` across stream completions, aborts, and model-level fallbacks.
- `open-sse/utils/error.js`: Propagation of `rawError` to bypass false-positive `modelLock` when encountering transient upstream parallel limits.

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
- `/v1/nosaver/models`

---

### 8. Neobrutalism UI Portal & Accent System ✅ DEPLOYED
**Purpose**: High-contrast, tactile public quota checker and UI accents.

**Implementation**:
- `src/app/usage-check/page.js`: High-fidelity Neobrutalism on port `:20128`.
- `deploy/usage-check.html`: Standalone Neobrutalism portal served on public reverse proxy `:20140`.
- `src/components/ui/button.jsx` & `src/components/ui/badge.jsx`: Added tactile `neo` variants (bold 2px borders, 4px/2px hard offset shadows, active translation feedback).

---

### 9. Upstream Merge v0.5.69 ✅ SYNCHRONIZED
- Merged all 19 commits from `origin/master` (Codex `gpt-6-astra`, Claude Fable quota tracker, OpenCode Go `muse-spark-1.3-contributor`, Gemini session `thoughtSignature`, Antigravity multi-account anti-abuse rate limit protection).

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

## 🔧 Verification & Testing

```bash
# Run unit test suite (all 40 tests passing)
npm run verify

# Run automated Neobrutalism E2E test
node --test tests/unit/neobrutalism-usage-check-e2e.test.mjs

# Build standalone production bundle
npm run build

# Deploy to release directory and restart
cp -a /opt/9router/.next/standalone/. /opt/9router-release/
cp -a /opt/9router/.next/static /opt/9router-release/.next/static
cp -a /opt/9router/public /opt/9router-release/public
cp -a /opt/9router/custom-server.js /opt/9router-release/custom-server.js
systemctl restart 9router
systemctl restart 9router-public-proxy
curl http://localhost:20128/api/health
```

---

*Last Updated: September 6, 2026*  
*Version: v0.5.69-custom*  
*Maintained by: SantaiNetwork AI Infrastructure Team*
