# 🚀 9Router Custom Enhancements - Complete Documentation

## Current State
- **Active Branch**: `dev` (and `master`)
- **Latest Dev Commit**: `e6eae312` (refactor: Convert /api/leaderboard into backward-compatible re-export)
- **Status**: Production Ready ✅

---

## 📋 Core Customizations

### 1. Upstream Model & Prefix Tracking ✅ WORKING
**Purpose**: Display actual provider-prefixed models (e.g., `ag/claude-sonnet-4-6`, `bai/deepseek-v4-flash`, `amanai/qwen3.8-max-preview`) in dashboard and recent usage stream without loss across process lifecycles.

**Implementation**:
- Modified: `open-sse/handlers/chatCore.js` (+30 lines)
- Modified: `open-sse/handlers/chatCore/streamingHandler.js` (+27 lines)
- Modified: `src/lib/db/repos/usageRepo.js`: `entry.meta = { requestedModel, upstreamModel }` synced before `pushToRing`.
- Modified: `src/lib/db/repos/requestDetailsRepo.js`: Persist `upstreamModel` & `requestedModel` in DB flush whitelist.

---

### 2. Custom Provider Credit & Balance Checking System ✅ DEPLOYED
**Purpose**: Enable automatic and configurable credit/quota balance tracking for custom OpenAI-compatible and Custom Embedding endpoints in Quota Tracker.

**Implementation**:
- New File: `open-sse/services/usage/customCompatible.js`
- Modified: `open-sse/services/usage.js` (routed `openai-compatible-*` & `custom-*`)
- Modified: `src/app/api/providers/client/route.js` & `src/app/api/usage/[connectionId]/route.js`
- Modified: `src/shared/components/EditConnectionModal.js` & `src/app/(dashboard)/dashboard/providers/[id]/AddApiKeyModal.js`
- Modified: `src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js` (compact number formatting & generic quota fallback)

**Supported Strategies**:
1. **Auto-detect**: Automatically checks `baseUrl` domain to apply Amanai, OpenRouter, SiliconFlow, or NewAPI strategies.
2. **Amanai**: Queries `GET {baseUrl}/v1/usage` (`credit_remaining`, status, name).
3. **OpenRouter**: Queries `GET https://openrouter.ai/api/v1/auth/key` (`usage`, `limit`, `is_free_tier`).
4. **SiliconFlow**: Queries `GET https://api.siliconflow.cn/v1/user/info` (`totalBalance`, `chargeBalance`).
5. **NewAPI / OneAPI**: Queries `GET {baseUrl}/dashboard/billing/usage` (`total_available`, `total_granted`).
6. **User Balance**: Queries `GET {baseUrl}/v1/user/balance` (`total_balance`, `currency`).
7. **Custom URL & JSON Path**: Universal extractor with user-defined URL and JSON path.

---

### 3. Provider Connections Batch Set Limits ✅ DEPLOYED
**Purpose**: Allow operators to set Requests Per Minute (RPM) and Queue Timeout (ms) simultaneously across selected or all provider connections.

**Implementation**:
- Modified: `src/app/(dashboard)/dashboard/providers/[id]/page.js`
- Added toolbar button **`Set Limits (X)`** / **`Set Limits (All)`** and interactive configuration modal.

---

### 4. API Keys & Providers Leaderboard & CSV Export ✅ DEPLOYED
**Purpose**: Real-time usage volume, cost, latency, and token monitoring dashboard.

**Features**:
- Canonical Route: `/api/usage/leaderboard` (with `/api/leaderboard` backward-compatible shim).
- URL Paths: `/dashboard/leaderboard` and `/leaderboard`.
- Visual ranking badges (🥇🥈🥉).
- Relative volume progress bars (% share of total).
- KPI Summary Cards (Total Requests, Tokens, Costs, Active Providers).
- Search bar for quick filtering.
- **Export CSV** button generating standard RFC-4180 CSV snapshots.

---

### 5. Response Footer Support ✅ CONFIGURED
**Purpose**: Add metadata at end of streaming responses.

**New File**: `open-sse/handlers/chatCore/responseFooter.js` (263 lines)

**Configuration** (in database):
```json
{
  "responseFooterEnabled": true,
  "responseFooterText": "\n\n---\nby SantaiNetwork · {model} · {durationS} · {totalTokens} Token Total",
  "responseFooterApiVersions": "v1,v2"
}
```

---

### 6. V2 API Deployment ✅ DEPLOYED
**Endpoints**:
- `/api/v2/models` - Public list of models ✅
- `/v2/models` - Alias route ✅  
- `/api/v2/chat/completions` - Protected chat endpoint 🔐

---

## 🔧 Verification & Testing

```bash
# Run unit test suite
node --test tests/unit/*.test.mjs

# Build standalone production bundle
npm run build

# Deploy to release directory and restart
rsync -av --delete /opt/9router/.next/standalone/ /opt/9router-release/
systemctl restart 9router
curl http://localhost:20128/api/health
```

---

*Last Updated: September 2, 2026*  
*Version: v2.2.0-custom-credits-and-leaderboard*  
*Maintained by: SantaiNetwork AI Infrastructure Team*
