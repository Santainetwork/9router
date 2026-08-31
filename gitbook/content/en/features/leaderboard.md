# Leaderboard - Usage & Cost Analytics

Track API usage, costs, and provider performance with comprehensive analytics dashboards.

---

## Overview

The **Leaderboard** provides real-time insights into:
- 🏆 Top API keys by request volume and cost
- 💰 Highest spending API keys
- 🌐 Provider usage rankings and cost efficiency
- 📊 Period-based analytics (Today, 7D, 30D, All Time)

**Access**: Dashboard → Sidebar → **Leaderboard**

---

## Features

### 1. API Keys by Requests

See which API keys are making the most requests:

| Metric | Description |
|--------|-------------|
| **#** | Ranking position with medal styling (🥇🥈🥉) |
| **API Key** | Key name + masked key display |
| **Requests** | Total number of API calls |
| **Input Tokens** | Prompt tokens consumed |
| **Output Tokens** | Completion tokens generated |
| **Cost ($)** | Total cost incurred |
| **Avg Latency** | Average response time in ms |

**Use Case**: Identify power users, detect unusual usage patterns, optimize quota allocation.

---

### 2. API Keys by Cost

View highest spending API keys to manage budget:

| Metric | Description |
|--------|-------------|
| **#** | Rank by cost (gold badge for #1) |
| **API Key** | Key name + masked identifier |
| **Total Cost** | Cumulative spending |
| **Requests** | Number of API calls made |
| **$/Request** | Average cost per request |

**Use Case**: Budget tracking, cost optimization, identify expensive workflows.

---

### 3. Provider Usage Rankings

Track which providers are being used most:

| Metric | Description |
|--------|-------------|
| **#** | Provider rank |
| **Provider** | Provider name (OpenAI, Anthropic, GLM, etc.) |
| **Requests** | Total requests routed through provider |
| **Tokens Used** | Combined input + output tokens |
| **Total Cost** | Cumulative provider cost |
| **$/Million Tokens** | Cost efficiency metric |

**Toggle**: Use the switch to show/hide provider rankings.

**Use Case**: Provider performance comparison, cost-efficiency analysis, routing optimization.

---

## Period Selection

Choose analysis timeframe using segmented control:

- **Today** (`today`) - Current day activity
- **Last 7 Days** (`7d`) - Weekly trends
- **Last 30 Days** (`30d`) - Monthly overview  
- **All Time** (`all`) - Historical data (entire dataset)

**Auto-refresh**: Data updates automatically when you change periods.

---

## Use Cases

### 🔍 Resource Planning

Identify top consumers:
```
1. Navigate to Leaderboard
2. Select "Last 30 Days" period
3. Check "Top API Keys by Requests"
4. Plan capacity based on usage patterns
```

### 💸 Budget Management

Track spending:
```
1. Go to Leaderboard → "API Keys by Cost"
2. Filter by "Last 7 Days" for recent trends
3. Monitor $/Request metrics
4. Set alerts for anomalous spending
```

### 🌐 Provider Optimization

Find cost-efficient providers:
```
1. Enable "Show Providers" toggle
2. Sort by "$/Million Tokens"
3. Identify best value providers
4. Adjust routing strategies accordingly
```

### 🔒 Security Monitoring

Detect anomalies:
```
1. Review "Top API Keys by Requests"
2. Compare against historical baselines
3. Flag unexpected spikes
4. Investigate potential breaches
```

---

## API Endpoint

The Leaderboard fetches data from:

```
GET /api/leaderboard?period=7d&top=20&providers=true
```

### Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `period` | string | `7d` | Time window: `today`, `7d`, `30d`, `all` |
| `top` | number | `20` | Number of entries to return |
| `providers` | boolean | `false` | Include provider rankings |

### Response Format

```json
{
  "success": true,
  "metadata": {
    "period": "7d",
    "metric": "requests",
    "timestamp": "2026-08-29T19:10:00Z"
  },
  "data": {
    "keysByRequests": [
      {
        "id": "uuid",
        "key_name": "Production Key",
        "key_masked": "sk_****xyz",
        "total_requests": 15420,
        "input_tokens": 2340000,
        "output_tokens": 890000,
        "total_cost": 12.45,
        "avg_latency_ms": 1250
      }
    ],
    "keysByCost": [...],
    "providersByUsage": [...],
    "providersByCost": [...]
  }
}
```

---

## Performance Optimization

### Caching Strategy

Leaderboard data is cached for **5 minutes** to reduce database load:

```javascript
const CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutes
```

This ensures:
- Fast dashboard loading
- Reduced query execution
- Consistent user experience

### Database Queries

Leaderboard uses optimized SQL queries:
- Aggregated sums and counts
- Indexed joins on `requestDetails` and `apiKeys`
- Date filtering with SQLite `datetime()` functions

**Example Query**:
```sql
SELECT 
  ak.id, ak.name AS key_name, COALESCE(ak.key, '****') AS key_masked,
  COUNT(rd.id) AS total_requests,
  SUM(COALESCE(JSON_EXTRACT(rd.tokens, '$.prompt_tokens'), 0)) AS input_tokens,
  SUM(COALESCE(JSON_EXTRACT(rd.tokens, '$.completion_tokens'), 0)) AS output_tokens,
  SUM(COALESCE(rd.cost, 0)) AS total_cost,
  ROUND(AVG(rd.latency->>'$.total'), 0) AS avg_latency_ms
FROM apiKeys ak
LEFT JOIN requestDetails rd ON ak.id = rd.apiKey
WHERE rd.timestamp >= datetime('now', '-7 days')
GROUP BY ak.id
ORDER BY total_requests DESC LIMIT 20
```

---

## Empty State

When no data is available, you'll see:

```
🏆 API Keys & Providers Leaderboard

No leaderboard data available yet.

Make some API requests to see rankings appear here.
```

This occurs when:
- Fresh installation with no traffic
- Selected period has zero requests
- No API keys have been used

---

## Privacy & Security

### Key Masking

API keys are always displayed with masking:
- **Full key**: Hidden from dashboard
- **Masked view**: `sk_****xyz` (first 4 chars visible)
- **ID reference**: Unique UUID for tracking only

### Access Control

Leaderboard requires:
- ✅ Authentication (JWT or API key)
- ✅ Proper permissions
- ✅ Valid session token

---

## Comparison with Other Features

| Feature | Purpose | Best For |
|---------|---------|----------|
| **Leaderboard** | Rankings & comparisons | Identifying top users/providers |
| **Usage Stats** | Detailed request logs | Deep dive into individual requests |
| **Quota Tracker** | Subscription limits | Monitoring monthly quotas |
| **Token Saver** | Cost reduction tips | Optimizing token usage |

---

## Tips & Best Practices

### 📈 Regular Monitoring

Check leaderboard weekly:
```
✅ Every Monday morning
→ Review previous week's top users
→ Identify trending providers
→ Adjust budgets accordingly
```

### 🎯 Set Thresholds

Configure alerts for:
- Single key exceeding $X/day
- New provider entering top 5
- Unusual latency spikes

### 💡 Cost Optimization

Use leaderboards to:
1. Identify high-cost providers
2. Negotiate better rates
3. Route to cheaper alternatives
4. Implement usage caps

---

## Troubleshooting

### Data Not Appearing

**Problem**: Empty state shows even after making requests.

**Solutions**:
1. Verify requests were logged (`Enabled Request Logs` in settings)
2. Check if selected period covers your activity
3. Ensure proper API key authentication
4. Wait 1-2 minutes for caching to expire

### Slow Loading

**Problem**: Leaderboard takes >5 seconds to load.

**Causes**:
- Large historical dataset ("All Time" period)
- Cache miss forcing fresh query
- High concurrent user load

**Mitigation**:
- Use shorter periods (7D instead of All Time)
- Refresh during off-peak hours
- Increase cache duration if needed

### Missing Provider Data

**Problem**: Provider rankings not showing.

**Fixes**:
1. Toggle "Show Providers" switch ON
2. Ensure enough provider traffic exists
3. Check that `rd.provider` field is populated
4. Verify provider names in configuration

---

## Future Enhancements

Planned improvements:
- 📊 Export to CSV/PDF
- 🔔 Custom alert thresholds
- 📈 Trend charts over time
- 👥 Team-based rankings
- 💳 Multi-currency support
- 🎨 Customizable time ranges

---

## See Also

- [Usage Stats](../dashboard/usage.md) - Detailed request breakdowns
- [Quota Tracker](../dashboard/quota.md) - Subscription monitoring
- [Key Access Control](../dashboard/api-keys.md) - API key management
- [Token Saver](../dashboard/token-saver.md) - Cost optimization

---

*Last updated: August 29, 2026*
