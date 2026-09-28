// Task 8: external Redis server config preflight. The bundled Compose profile
// enforces AOF/noeviction via redis-server flags; an operator-supplied external
// REDIS_URL is untrusted and must be probed before the control writer starts.
// Fail closed on any missing/unsafe setting or probe failure. Never leaks raw
// errors or credentials in the result.

const SAFE_EVICTION_POLICIES = new Set(["noeviction", ""]);

// One CONFIG GET parameter per call. RESP2 servers answer a flat [key, value]
// array; RESP3 and node-redis answer a single-key object. Both shapes map to
// the parameter's string value, or "" when absent.
function configValue(response, name) {
  if (Array.isArray(response)) {
    for (let i = 0; i + 1 < response.length; i += 2) {
      if (String(response[i]).toLowerCase() === name) return String(response[i + 1] ?? "");
    }
    return "";
  }
  if (response && typeof response === "object") {
    const value = Object.entries(response).find(([key]) => String(key).toLowerCase() === name);
    if (value) return String(value[1] ?? "");
  }
  return "";
}

export async function checkRedisServerConfig(redis) {
  if (!redis || typeof redis.configGet !== "function") {
    return { ok: false, issues: ["redis client unavailable"] };
  }
  let config;
  try {
    // node-redis v4 CONFIG GET takes one parameter per call and returns a
    // single-key object; a "a b" multi-parameter string yields {} silently.
    const [aofResp, policyResp] = await Promise.all([
      redis.configGet("appendonly"),
      redis.configGet("maxmemory-policy"),
    ]);
    config = {
      appendonly: configValue(aofResp, "appendonly"),
      policy: configValue(policyResp, "maxmemory-policy"),
    };
  } catch {
    return { ok: false, issues: ["redis config probe failed"] };
  }

  const issues = [];
  const appendonly = (config.appendonly || "").trim().toLowerCase();
  if (appendonly !== "yes") {
    issues.push("appendonly must be yes for durable SQLite mutations");
  }
  const policy = (config.policy || "").trim().toLowerCase();
  if (!SAFE_EVICTION_POLICIES.has(policy)) {
    issues.push("maxmemory-policy must be noeviction so queued mutations are never evicted");
  }
  return { ok: issues.length === 0, issues };
}
