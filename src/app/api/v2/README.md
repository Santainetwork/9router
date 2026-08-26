# 9Router V2 API - Complete Token Saver Control

## Overview

The V2 API provides **full per-request control** over all token saver features through request body configuration. Unlike V1 which only uses global dashboard settings or header-based opt-out, V2 allows granular customization of each feature independently.

## Base URLs

- **V1 (Legacy)**: `http://localhost:20128/v1` - Uses dashboard global settings only
- **V2 (New)**: `http://localhost:20128/v2` - Full custom control via request body

---

## Quick Start Examples

### Example 1: Disable ALL Token Savers

Perfect for testing baseline model performance without any optimizations:

```json
{
  "model": "anthropic/claude-sonnet-4",
  "messages": [{"role": "user", "content": "Hello"}],
  "token_saver_config": {
    "enabled": false
  }
}
```

### Example 2: Selective Enablement

Use only specific savers you trust:

```json
{
  "model": "anthropic/claude-sonnet-4",
  "messages": [{"role": "user", "content": "What is AI?"}],
  "token_saver_config": {
    "enabled": true,        // Global enable
    "rtk": true,            // ✅ Use RTK compression
    "headroom": false,      // ❌ No Headroom proxy
    "caveman": false,       // ❌ No system prompts
    "ponytail": false,      // ❌ No system prompts
    "pxpipe": true          // ✅ Use image optimization
  }
}
```

### Example 3: Maximum Savings

Enable everything for longest conversations:

```json
{
  "model": "anthropic/claude-sonnet-4",
  "messages": [{"role": "user", "content": "Long conversation start..."}],
  "stream": false,
  "token_saver_config": {
    "enabled": true,
    "rtk": true,            // Compress tool results
    "headroom": true,       // External compression proxy
    "caveman": "full",      // Aggressive brevity injection
    "ponytail": "minimal",  // Light developer hints
    "pxpipe": true          // Optimize image context
  }
}
```

### Example 4: Minimal Baseline

Cleanest possible response with basic compression only:

```json
{
  "model": "anthropic/claude-sonnet-4",
  "messages": [{"role": "user", "content": "Simple question?"}],
  "token_saver_config": {
    "enabled": true,
    "rtk": true,            // Only RTK - safe and fast
    "headroom": false,
    "caveman": false,
    "ponytail": false,
    "pxpipe": false
  }
}
```

---

## Configuration Fields Explained

### Global Toggle

**`enabled`** (boolean, optional)
- `true`: Enable all token savers (subject to individual flags below)
- `false`: **Disable ALL token savers immediately**
- Omitted: Follows global dashboard settings

This is the master switch that turns everything on/off at once.

### Per-Feature Toggles

All flags below are independent boolean options when `enabled: true`.

#### 1. **RTK Compression** (`rtk`)
- Type: `boolean` | `true` (default when enabled), `false`
- **What it does**: Compresses tool_result content in messages using Runtime Knowledge techniques
- **Benefits**: Reduces token count from function calls and tool usage by ~50-70%
- **When to use**: Always recommended for tool-using models
- **Example**: 
  ```json
  {"rtk": true}  // Compress tool outputs
  {"rtk": false} // Send full tool output (more verbose but detailed)
  ```

#### 2. **Headroom Proxy** (`headroom`)
- Type: `boolean` | `true`, `false`
- **What it does**: Sends payload through external compression service before forwarding to provider
- **Benefits**: Additional token reduction beyond RTK (especially effective for long contexts)
- **Caveats**: Adds ~50-100ms latency, requires external dependency
- **When to use**: Long conversations, production deployments with headroom available
- **Example**:
  ```json
  {"headroom": true}   // Use compression proxy
  {"headroom": false}  // Skip external compression
  ```

#### 3. **Caveman Prompt** (`caveman`)
- Type: `boolean` | `"full"` | `"minimal"` | `false`
- **What it does**: Injects terse-style system prompt encouraging concise responses
- **Levels**:
  - `true` / `"full"`: Maximum brevity ("Be brief")
  - `"minimal"`: Light conciseness hints
  - `false`: No brevity injection
- **Benefits**: Reduces response length, saves tokens on chatty models
- **Tradeoff**: May reduce explanation quality
- **When to use**: When you want shorter answers, Q&A scenarios
- **Examples**:
  ```json
  {"caveman": "full"}     // Maximum brevity
  {"caveman": "minimal"}  // Subtle hints
  {"caveman": false}      // Natural style
  ```

#### 4. **Ponytail Prompt** (`ponytail`)
- Type: `boolean` | `"full"` | `"minimal"` | `false`
- **What it does**: Injects "lazy senior developer" persona into system prompt
- **Effect**: Models adopt more casual, efficient coding style
- **Benefits**: Faster reasoning, better code snippets, less verbosity
- **Tradeoff**: Can feel unprofessional in formal contexts
- **When to use**: Coding tasks, technical explanations, internal tools
- **Examples**:
  ```json
  {"ponytail": true}      // Full dev persona
  {"ponytail": "minimal"} // Light hints
  {"ponytail": false}     // Standard professional tone
  ```

#### 5. **PXPIPE Image Compression** (`pxpipe`)
- Type: `boolean` | `true`, `false`
- **What it does**: Compresses and optimizes image context in messages
- **Benefits**: Significant token savings when images are part of conversation
- **When to use**: Vision-enabled models with image inputs
- **Note**: Only affects Claude format requests
- **Example**:
  ```json
  {"pxpipe": true}        // Optimize images
  {"pxpipe": false}       // Send raw images
  ```

---

## Advanced Patterns

### Pattern 1: Progressive Enhancement

Start minimal and add features as needed:

```javascript
const configs = [
  { enabled: true, rtk: true },                    // Step 1: Basic
  { enabled: true, rtk: true, caveman: true },     // Step 2: Add brevity
  { enabled: true, rtk: true, headroom: true },    // Step 3: Add proxy
];

for (const config of configs) {
  const result = await fetch("/v2/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model, messages, token_saver_config: config })
  });
  // Compare token counts and quality
}
```

### Pattern 2: Context-Aware Configuration

Different modes for different scenarios:

```javascript
function getTokenSaverConfig(type, context) {
  switch (type) {
    case "coding":
      return {
        enabled: true,
        rtk: true,
        ponytail: "full",    // Dev mode for coding
        caveman: false,      // Detailed explanations
        headroom: false,     // Speed over compression
        pxpipe: false
      };
      
    case "casual":
      return {
        enabled: true,
        rtk: true,
        ponytail: "minimal",
        caveman: true,       // Short responses
        headroom: true,
        pxpipe: false
      };
      
    case "long_conversation":
      return {
        enabled: true,
        rtk: true,
        headroom: true,
        caveman: "minimal",
        ponytail: false,
        pxpipe: true         // If images involved
      };
      
    default:
      return null; // Use global defaults
  }
}
```

### Pattern 3: A/B Testing Strategies

Compare different configurations systematically:

```bash
#!/bin/bash
PROMPT="Explain machine learning to a 5-year-old"
MODEL="anthropic/claude-sonnet-4"

# Test baseline (no savers)
echo "Testing baseline..."
curl http://localhost:20128/v2/chat/completions \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"$PROMPT\"}],\"token_saver_config\":{\"enabled\":false}}"

# Test with all savers
echo "Testing max savings..."
curl http://localhost:20128/v2/chat/completions \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"$PROMPT\"}],\"token_saver_config\":{\"enabled\":true,\"caveman\":\"full\",\"ponytail\":\"full\",\"headroom\":true}}"
```

---

## Backward Compatibility

### Legacy Header-Based Opt-Out Still Works

You can still use the old approach if preferred:

```bash
curl http://localhost:20128/v2/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-9Router-Token-Saver: off" \
  -d '{"model":"...","messages":[...]}'
```

Or selective disable via header:

```bash
curl http://localhost:20128/v2/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-9Router-Token-Saver: caveman,ponytail" \
  -d '{"model":"...","messages":[...]}'
```

### V1 Endpoint Unchanged

The original `/v1` endpoint continues to work exactly as before.

---

## Implementation Details

### Request Format Validation

- Body must be valid JSON
- `model` field required
- `messages` array required
- `token_saver_config` is optional and ignored if not provided
- Invalid flag values fall back to sensible defaults

### Response Behavior

- All configurations return standard OpenAI-compatible responses
- Streaming (`stream: true`) works with all configurations
- Error handling identical across all modes
- No breaking changes to existing clients

### Performance Considerations

| Configuration | Latency Impact | Token Savings | Quality Impact |
|--------------|----------------|---------------|----------------|
| All disabled | Baseline | 0% | None (pure model) |
| RTK only | ~5ms | ~50% (tools) | Minimal |
| RTK + Caveman | ~10ms | ~60% | Concise but complete |
| RTK + Headroom | +50-100ms | ~70% | Minor compression artifacts |
| All enabled | +60-100ms | ~80% | Most aggressive |

---

## File Structure

```
src/app/api/v2/
├── route.js                          # Gateway + API info endpoint
├── chat/
│   └── completions/
│       ├── route.js                  # Main handler with toggle logic
│       └── README.md                 # This documentation
├── examples/
│   └── test-v2.js                    # Comprehensive test suite
└── README.md                         # Quick reference
```

---

## Testing

Run the included test suite:

```bash
node src/app/api/v2/examples/test-v2.js
```

Or test manually:

```bash
# Check API info
curl http://localhost:20128/v2

# Test basic functionality
curl -X POST http://localhost:20128/v2/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "anthropic/claude-sonnet-4",
    "messages": [{"role": "user", "content": "Test"}],
    "token_saver_config": { "enabled": false }
  }'
```

---

## Migration from V1

Simple migration path:

1. Change base URL from `/v1` to `/v2`
2. Add `token_saver_config` field only if you need custom behavior
3. Keep all other parameters identical

No breaking changes! V2 fully extends V1 functionality.
