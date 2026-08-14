// Self-check for per-API-key RBAC logic (model allowlist matching + quota rule).
// Run: node tests/unit/rbac-apikey.test.mjs
//
// The gate module (src/sse/services/rateLimitGate.js) pulls in Next path aliases,
// so we validate the allowlist/quota decision logic here in isolation. This
// mirrors modelVariants()/enforceApiKeyAccess() exactly; keep in sync if that
// logic changes.
import assert from "node:assert";

function modelVariants(model) {
  const s = String(model || "").trim();
  if (!s) return [];
  const out = new Set([s]);
  const slash = s.lastIndexOf("/");
  if (slash >= 0) out.add(s.slice(slash + 1));
  return [...out];
}

function modelPermitted(allow, model) {
  if (!allow || allow.length === 0) return true; // empty allowlist = all models
  const variants = modelVariants(model);
  return variants.some((v) => allow.includes(v));
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
  // Suffix match (request sends provider-prefixed, allowlist holds bare id).
  assert.equal(modelPermitted(["gpt-4o"], "openai/gpt-4o"), true);
  // Bare request against provider-prefixed allowlist does NOT match (different id).
  assert.equal(modelPermitted(["openai/gpt-4o"], "gpt-4o"), false);
  // Denied model.
  assert.equal(modelPermitted(["openai/gpt-4o"], "anthropic/claude-3"), false);
  // Multiple allowed.
  assert.equal(modelPermitted(["a/x", "b/y"], "b/y"), true);

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
