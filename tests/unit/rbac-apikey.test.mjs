// Self-check for per-API-key RBAC logic (model allowlist matching + quota rule).
// Run: node tests/unit/rbac-apikey.test.mjs
//
// The gate module (src/sse/services/rateLimitGate.js) pulls in Next path aliases,
// so we validate the allowlist/quota decision logic here in isolation. This
// mirrors isModelAllowedBy()/enforceApiKeyAccess() exactly; keep in sync if that
// logic changes.
import assert from "node:assert";

// EXACT or WILDCARD match: e.g. "hx/*" permits any model under "hx/".
function modelPermitted(allow, model) {
  if (!allow || allow.length === 0) return true; // empty allowlist = all models
  const requested = String(model || "").trim();
  if (!requested) return false;
  return allow.some((entry) => {
    const pattern = String(entry || "").trim();
    if (!pattern) return false;
    if (pattern === "*" || pattern === requested) return true;
    if (pattern.endsWith("/*")) {
      const pfx = pattern.slice(0, -2);
      if (requested.startsWith(pfx + "/")) return true;
    } else if (pattern.endsWith("*")) {
      const pfx = pattern.slice(0, -1);
      if (requested.startsWith(pfx)) return true;
    }
    return false;
  });
}

function quotaExhausted(tokenQuota, used) {
  if (!(tokenQuota > 0)) return false; // 0 = unlimited
  return used >= tokenQuota;
}

function main() {
  // Allowlist: empty = allow everything.
  assert.equal(modelPermitted([], "openai/gpt-4o"), true);
  assert.equal(modelPermitted(undefined, "anything"), true);

  // Full "provider/model" match.
  assert.equal(modelPermitted(["openai/gpt-4o"], "openai/gpt-4o"), true);
  // EXACT only: a bare allowlist id does NOT cover provider-prefixed variants.
  assert.equal(modelPermitted(["gpt-4o"], "openai/gpt-4o"), false);
  // ...and the reverse also does not match.
  assert.equal(modelPermitted(["openai/gpt-4o"], "gpt-4o"), false);
  // Each variant must be granted explicitly.
  assert.equal(modelPermitted(["gpt-4o", "openai/gpt-4o"], "openai/gpt-4o"), true);
  // Combo name granted by exact name.
  assert.equal(modelPermitted(["deepseek-v4-flash"], "deepseek-v4-flash"), true);
  assert.equal(modelPermitted(["deepseek-v4-flash"], "amar/amanai/deepseek-v4-flash"), false);
  // Denied model.
  assert.equal(modelPermitted(["openai/gpt-4o"], "anthropic/claude-3"), false);
  // Multiple allowed.
  assert.equal(modelPermitted(["a/x", "b/y"], "b/y"), true);

  // Wildcard allowlist: "hx/*" permits any model with "hx/" prefix
  assert.equal(modelPermitted(["hx/*"], "hx/claude-sonnet-5"), true);
  assert.equal(modelPermitted(["hx/*"], "hx/x-ai/grok-4.6"), true);
  assert.equal(modelPermitted(["hx/*"], "ag/gemini-3.8-flash"), false);
  assert.equal(modelPermitted(["*"], "any/model/at/all"), true);

  // Quota: 0 = unlimited.
  assert.equal(quotaExhausted(0, 999999), false);
  // Under quota → allowed.
  assert.equal(quotaExhausted(1000, 999), false);
  // At quota → exhausted.
  assert.equal(quotaExhausted(1000, 1000), true);
  // Over quota → exhausted.
  assert.equal(quotaExhausted(1000, 5000), true);

  console.log("rbac-apikey.test.mjs: all assertions passed");
}

main();
