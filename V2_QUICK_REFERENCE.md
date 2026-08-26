# V2 API - Quick Reference for Token Saver Toggles

## The Problem (Solved)

**Before**: Had to use global settings or complex headers  
**Now**: Simple JSON body field for full control per request!

---

## Super Easy Usage

### 1️⃣ Disable Everything Instantly

```json
{
  "token_saver_config": { "enabled": false }
}
```

✅ Use case: Testing, debugging, pure model behavior

### 2️⃣ Selective Control (The Magic!)

```json
{
  "token_saver_config": {
    "enabled": true,
    "rtk": true,              // ✅ Compression for tools
    "headroom": false,        // ❌ Skip external proxy
    "caveman": false,         // ❌ No brevity hints
    "ponytail": false,        // ❌ No dev persona
    "pxpipe": true            // ✅ Image optimization
  }
}
```

✅ Use case: Customize which features you trust

### 3️⃣ Maximum Savings

```json
{
  "token_saver_config": {
    "enabled": true,
    "rtk": true,
    "headroom": true,
    "caveman": "full",        // Aggressive brevity
    "ponytail": "minimal",    // Light dev mode
    "pxpipe": true
  }
}
```

✅ Use case: Long conversations, cost optimization

---

## Feature Flags Explained (One-Liners)

| Flag | Type | What It Does | When To Use |
|------|------|--------------|-------------|
| `enabled` | boolean | Master switch ON/OFF everything | Always start with this |
| `rtk` | bool/true/false | Compress tool outputs (~50% savings) | Enable for all coding tasks |
| `headroom` | bool | External compression (+latency) | Production only |
| `caveman` | bool/full/minimal | Brevity injections | Q&A, short answers |
| `ponytail` | bool/full/minimal | Dev persona injection | Coding, technical work |
| `pxpipe` | bool | Image optimization | Vision tasks |

---

## Common Patterns

### Pattern A: Conservative (RTK Only)
```json
{"enabled": true, "rtk": true}
```

### Pattern B: Balanced (RTK + Caveman)
```json
{"enabled": true, "rtk": true, "caveman": "minimal"}
```

### Pattern C: Dev Mode (Coding Tasks)
```json
{"enabled": true, "rtk": true, "ponytail": "full"}
```

### Pattern D: Zero Savings (Testing)
```json
{"enabled": false}
```

---

## Complete Example

```bash
curl http://localhost:20128/v2/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "anthropic/claude-sonnet-4",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": false,
    "token_saver_config": {
      "enabled": true,
      "rtk": true,
      "headroom": false,
      "caveman": false,
      "ponytail": false,
      "pxpipe": true
    }
  }'
```

---

## Comparison: V1 vs V2

| | V1 | V2 |
|-|-----|-----|
| **Control** | Global dashboard settings OR header | Per-request JSON body |
| **Ease of use** | Low (complex headers) | High (simple boolean flags) |
| **Flexibility** | All or nothing | Granular per-feature |
| **Learning curve** | Medium | Very low |

---

## Production Checklist

- [ ] Test all combinations in staging
- [ ] Monitor token counts and latency
- [ ] Document configuration strategy for your use case
- [ ] Set up logging for usage patterns
- [ ] Create config presets for different scenarios

---

## Files to Review

- Route Handler: `src/app/api/v2/chat/completions/route.js`
- Documentation: `src/app/api/v2/README.md`
- Examples: `src/app/api/v2/examples/test-v2.js`

**Ready to deploy!** ✅
