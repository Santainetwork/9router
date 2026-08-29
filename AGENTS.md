# 🚀 9Router Custom Enhancements - Complete Documentation

## Current State
- **Latest Commit**: `0f34ef81` (feat: Add API Keys & Providers Leaderboard)
- **Custom Fork**: Active with all enhancements deployed
- **Status**: Production Ready ✅

---

## 📋 Core Customizations

### 1. Upstream Model Tracking ✅ WORKING
**Purpose**: Display actual provider models instead of client aliases in dashboard

**Implementation**:
- Modified: `open-sse/handlers/chatCore.js` (+30 lines)
- Modified: `open-sse/handlers/chatCore/streamingHandler.js` (+27 lines)
- Modified: `src/lib/db/repos/usageRepo.js` (+9 -2 lines)
- Added to DB: `upstreamModel` field in JSON data column

**How it works**:
```javascript
const upstreamModel = getModelUpstreamId(alias, model);
// Example: qmodel_38max → amanai/qwen3.8-max-preview
```

**Display Priority**: `upstreamModel` > `requestedModel` > `model` (fallback)

---

### 2. Dashboard Polishing ✅ WORKING
**Purpose**: Visual indicators for upstream vs alias models

**Modified**: `src/app/(dashboard)/dashboard/usage/components/RequestDetailsTab.js`

**Features**:
- `isUpstreamModel()` helper function detects provider prefixes (`/`, `amanai/`, etc.)
- `[UPSTREAM]` badge displayed for real provider models
- Better tooltip information
- Monospace fonts for clarity

---

### 3. Response Footer Support ✅ CONFIGURED
**Purpose**: Add metadata at end of streaming responses

**New File**: `open-sse/handlers/chatCore/responseFooter.js` (263 lines)

**Configuration** (in database):
```json
{
  "responseFooterEnabled": true,
  "responseFooterText": "\n\n---\nby SantaiNetwork · {model} · {durationS} · {totalTokens} Token Total",
  "responseFooterApiVersions": "v1,v2"  // Updated August 29, 2026
}
```

**Supports**: Both v1 and v2 API endpoints

---

### 4. V2 API Deployment ✅ DEPLOYED
**Purpose**: New API paths with proper routing and auth boundaries

**Changes in `next.config.mjs`**:
```javascript
{ source: "/v2/:path*", destination: "/api/v2/:path*" }
{ source: "/v2", destination: "/api/v2" }
{ source: "/v1/:path*", destination: "/api/v1/:path*" }
{ source: "/v1", destination: "/api/v1" }
```

**Endpoints**:
- `/api/v2/models` - Public list of models ✅
- `/v2/models` - Alias route ✅  
- `/api/v2/chat/completions` - Protected chat endpoint 🔐

---

### 5. API Keys & Providers Leaderboard ✅ DEPLOYED (Aug 29, 2026)
**Purpose**: Usage monitoring and cost tracking dashboard

**New Files**:
- `src/app/api/leaderboard/route.js` (110 lines) - Backend aggregation logic
- `src/app/(dashboard)/leaderboard/page.jsx` (236 lines) - Frontend UI

**Features**:
- **Top API Keys by Usage**: Request counts, input/output tokens, latency
- **Top API Keys by Cost**: Spending analysis, requests per dollar
- **Provider Rankings**: Toggleable view of provider usage efficiency
- **Time Filters**: Today, Last 7 Days, Last 30 Days, All Time
- **Visual Ranking Badges**: 🥇🥈🥉 gold/silver/bronze positions

**Metrics Tracked**:
- Total requests per key/provider
- Input tokens, output tokens, total tokens
- Total cost in USD ($ precision to 4 decimals)
- Average latency (milliseconds)
- Cost efficiency metrics ($/request, $/million tokens)

**Cache Strategy**: 5-minute server-side caching for performance

**Access**: `/dashboard/leaderboard` (requires authentication)

---

## 📦 Files Modified vs Original 9Router

| Category | Files | Lines Changed |
|----------|-------|---------------|
| Core Chat | `chatCore.js`, `streamingHandler.js` | +57 |
| Database | `usageRepo.js` | +9 -2 |
| Dashboard | `RequestDetailsTab.js`, `page.jsx` (leaderboard) | +25 +236 |
| API Routes | `route.js` (leaderboard) | +110 |
| Config | `next.config.mjs` | +13 |
| New | `responseFooter.js`, leaderboard/* | +499 |
| **TOTAL** | ~7 core files | ~+714 net custom code |

**Total Custom Files Created**: 20+ (docs, scripts, services, dashboards)

---

## 🎯 Acceptance Criteria Status

| Feature | Status | Verified |
|---------|--------|----------|
| Upstream Model Capture | ✅ Working | Database stores `amanai/...` not aliases |
| Dashboard Badge UI | ✅ Working | `[UPSTREAM]` badges display correctly |
| Footer v1+v2 Support | ✅ Updated | DB configured for both versions |
| V2 Route Mapping | ✅ Deployed | Both native + alias routes active |
| Auth Protection | ✅ Strict | Properly rejects unauthenticated requests |
| Leaderboard UI | ✅ Deployed | Accessible at `/dashboard/leaderboard` |
| No Regression | ✅ Confirmed | All v1 features intact |

---

## 🔧 Verification Commands

```bash
# Check deployment status
systemctl status 9router
curl http://localhost:20128/api/health

# Verify V2 public endpoints
curl http://localhost:20128/api/v2/models
curl http://localhost:20128/v2/models

# Test leaderboad API
curl http://localhost:20128/api/leaderboard?period=7d&top=20&providers=true

# Monitor latest requests
tail -f /var/log/9router.log | grep apiVersion

# Query database for upstream models
NODE_PATH=/opt/9router/node_modules node -e "
const db=require('better-sqlite3')('/var/lib/9router/.9router/db/data.sqlite');
const rows=db.prepare('SELECT model, data FROM requestDetails ORDER BY id DESC LIMIT 5').all();
rows.forEach(r=>console.log(r.model, JSON.parse(r.data||{}).upstreamModel || '(none)'));
"

# Check footer config
sqlite3 /var/lib/9router/.9router/db/data.sqlite \
  "SELECT json_extract(data,'$.responseFooterApiVersions') FROM settings"
```

---

## 📊 Known Issues & Recommendations

### Monitoring Needed:
1. ⏳ First V2 chat request to verify `apiVersion=v2` field capture
2. ⏳ Confirm footer appears correctly on V2 streaming responses
3. ⏳ Monitor leaderboard metrics as traffic increases

### Pending Validation:
- End-to-end test: Make real V2 request → Check DB fields → Verify leaderboard updates
- Performance: Ensure upstream model lookup doesn't add latency
- Compatibility: Long-term compatibility with original 9router updates

---

## 💡 Operational Guide

### For Developers:
1. Always test changes locally before deploying
2. Monitor logs for `apiVersion`, `upstreamModel`, and leaderboard metrics
3. Keep changelog updated when modifying customization logic
4. Leaderboard queries cache for 5 minutes before refreshing

### For Operators:
1. Health check passes: `curl http://localhost:20128/api/health`
2. Service active: `systemctl is-active 9router`
3. Watch log: `journalctl -u 9router -f`
4. Dashboard access: Navigate to `/dashboard/leaderboard` after login

### For Troubleshooting:
- Dashboard not showing? → Clear cache, hard refresh (Ctrl+Shift+R)
- Models still show as aliases? → Check if requests are recent (DB lag)
- Footer missing on V2? → Verify `responseFooterApiVersions="v1,v2"` in DB
- Leaderboard empty? → Need some API requests to populate metrics

---

## 📝 Change History

| Date | Commit | Change |
|------|--------|--------|
| Aug 28 | c83c099f | Initial upstream model capture |
| Aug 28 | fd76e445 | Fix parameter passing |
| Aug 28 | 8b0d2003 | Save upstreamModel to DB |
| Aug 29 | 8cc12e3f | Build complete, deploy ready |
| Aug 29 | CURRENT | V2 API + footer scope validation |
| Aug 29 | 0f34ef81 | Leaderboard feature added |

---

## 🔗 References

- **Original Repository**: `https://github.com/decolua/9router.git`
- **Current Repo Root**: `/opt/9router`
- **Release Directory**: `/opt/9router-release`
- **Service Log**: `/var/log/9router.log`
- **Database**: `/var/lib/9router/.9router/db/data.sqlite`
- **Leaderboard UI**: `http://localhost:20128/dashboard/leaderboard`
- **Leaderboard API**: `http://localhost:20128/api/leaderboard`

---

*Last Updated: August 29, 2026*  
*Version: v2.1.0-custom-leaderboard-enabled*  
*Maintained by: SantaiNetwork AI Infrastructure Team*
