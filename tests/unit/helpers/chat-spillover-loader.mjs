// Module loader for tests that need the REAL src/sse/handlers/chat.js under plain
// node (no Next runtime, no DB). It layers on top of alias-loader.mjs:
//
//   * "@/lib/localDb"                 -> in-memory fixtures from globalThis
//     (also matched through relative specifiers, see DB_BARRELS)
//   * "@/lib/usageDb"                 -> no-op usage/telemetry stub
//   * "open-sse/handlers/chatCore.js" -> controllable stub recording attempts
//   * "node-machine-id"               -> deterministic id (ESM interop shim)
//
// Controlled through globalThis:
//   __TEST_CONNS__     provider connections returned by getProviderConnections()
//   __TEST_SETTINGS__  settings object returned by getSettings()
//   __TEST_CORE_CALLS__ recorded [{ connectionId, connectionName, releaseCalls }]
//
// The rate limiter is NOT stubbed here: these tests exercise the real
// open-sse/services/rateLimiter.js JS implementation.

const LOCAL_DB_STUB = `
  const settings = () => globalThis.__TEST_SETTINGS__ ?? {};
  export async function getSettings() { return settings(); }
  export async function getProviderConnections() { return globalThis.__TEST_CONNS__ ?? []; }
  export async function getProviderConnectionById(id) {
    return (globalThis.__TEST_CONNS__ ?? []).find((c) => c.id === id) ?? null;
  }
  export async function getProviderNodes() { return []; }
  export async function getComboByName() { return null; }
  export async function getCombos() { return []; }
  export async function getComboById() { return null; }
  export async function getModelAliases() { return {}; }
  export async function getCustomModels() { return []; }
  export async function getProxyPools() { return []; }
  export async function validateApiKey() { return false; }
  export async function getApiKeyLimits() { return null; }
  export async function getApiKeyTokenUsage() { return 0; }
  export async function getApiKeys() { return []; }
  export async function getApiKeyById() { return null; }
  export async function getApiKeyByKey() { return null; }
  export async function getApiKeyUsageInRange() { return []; }
  export async function createApiKey() {}
  export async function updateApiKey() {}
  export async function deleteApiKey() {}
  export async function updateProviderConnection() {}
  export async function updateSettings() {}
  export async function createCombo() {}
  export async function updateCombo() {}
  export async function deleteCombo() {}
  export async function cleanupProviderConnections() {}
  export async function exportDb() {}
  export async function importDb() {}
`;

const CHAT_CORE_STUB = `
  export async function handleChatCore(opts) {
    const calls = (globalThis.__TEST_CORE_CALLS__ ||= []);
    const call = {
      connectionId: opts?.credentials?.connectionId ?? null,
      connectionName: opts?.credentials?.connectionName ?? null,
      releaseCalls: 0,
    };
    calls.push(call);
    // Mirror chatCore's ownership handoff: the caller-provided onRelease is how
    // a granted provider slot is returned once the request completes.
    call.releaseCalls += 0;
    return {
      success: true,
      response: new Response("data: ok\\n\\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    };
  }
`;

const USAGE_DB_STUB = `
  export function trackPendingRequest() {}
  export function getActiveRequests() { return []; }
  export function getSharedActiveRequests() { return []; }
  export async function appendRequestLog() {}
  export async function saveRequestDetail() {}
  export async function saveRequestUsage() {}
  export async function getRecentLogs() { return []; }
  export async function getUsageStats() { return {}; }
  export async function getUsageHistory() { return []; }
  export async function getChartData() { return []; }
  export async function getRequestDetails() { return []; }
  export async function getRequestDetailById() { return null; }
  export const statsEmitter = { on() {}, off() {}, emit() {} };
`;

const VIRTUALS = {
  "@/lib/localDb": LOCAL_DB_STUB,
  "@/lib/usageDb": USAGE_DB_STUB,
  "open-sse/handlers/chatCore.js": CHAT_CORE_STUB,
  "node-machine-id": `export function machineIdSync() { return "test-machine-id"; }`,
};

// Both DB barrels are also reached through RELATIVE specifiers that never match
// the "@/" virtual keys: tokenRefresh.js does `from "../../lib/localDb.js"` and
// stream.js does `from "@/lib/usageDb.js"`. Left unhandled, those resolve to the
// real shim files, which re-export src/lib/db/index.js and drag the whole SQLite
// layer (adapter init, migrations, the production data file) into the test
// process. Match on the specifier tail so every form hits the stub.
const DB_BARRELS = [
  { pattern: /(^|\/)lib\/localDb(\.js)?$/, key: "@/lib/localDb" },
  { pattern: /(^|\/)lib\/usageDb(\.js)?$/, key: "@/lib/usageDb" },
];

function dbBarrelKey(specifier) {
  for (const { pattern, key } of DB_BARRELS) {
    if (pattern.test(specifier)) return key;
  }
  return null;
}

// alias-loader.mjs replaces the rate limiter with an always-throwing stub (for
// the 503 wiring test). These tests need the REAL implementation, so pin the
// specifier to the on-disk file and short-circuit past that virtual.
const REAL_RATE_LIMITER = new URL("../../../open-sse/services/rateLimiter.js", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "open-sse/services/rateLimiter.js") {
    return { url: REAL_RATE_LIMITER, shortCircuit: true };
  }
  const barrelKey = dbBarrelKey(specifier);
  if (barrelKey) {
    return { url: `virtual:chat-spillover:${barrelKey}`, shortCircuit: true };
  }
  if (specifier in VIRTUALS) {
    return { url: `virtual:chat-spillover:${specifier}`, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  const prefix = "virtual:chat-spillover:";
  if (url.startsWith(prefix)) {
    return {
      format: "module",
      shortCircuit: true,
      source: VIRTUALS[url.slice(prefix.length)],
    };
  }
  return nextLoad(url, context);
}
