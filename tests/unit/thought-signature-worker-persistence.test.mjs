import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// The store talks to two collaborators: the SQLite kv helper and the DB driver
// that reports read-only worker mode. Stub both so no real database is needed.
// `isSqliteMulticoreWorker` reads env per call, so one process can exercise
// control mode and worker mode in sequence.
const KV_STUB = `data:text/javascript,${encodeURIComponent(`
globalThis.__kvCalls = globalThis.__kvCalls || [];
export function makeKv(scope) {
  const rec = (op) => (key, value) => {
    globalThis.__kvCalls.push({ op, scope, key, value });
    return Promise.resolve();
  };
  return {
    get: async () => null,
    getAll: async () => ({}),
    set: rec("set"),
    setMany: async () => {},
    remove: rec("remove"),
    clear: async () => {},
  };
}
`)}`;

const DRIVER_STUB = `data:text/javascript,${encodeURIComponent(`
export function isSqliteMulticoreWorker() {
  const role = String(process.env.WORKER_ROLE || "").toLowerCase();
  const mode = String(process.env.SQLITE_MULTICORE || "").toLowerCase();
  return role === "api" && mode === "redis";
}
`)}`;

register(
  `data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier.endsWith("/helpers/kvStore.js")) return { url: ${JSON.stringify(KV_STUB)}, shortCircuit: true };
  if (specifier.endsWith("/db/driver.js")) return { url: ${JSON.stringify(DRIVER_STUB)}, shortCircuit: true };
  return next(specifier, context);
}
`)}`,
);

// THOUGHT_SIG_STORE lets the same test run against a pre-fix copy to observe RED.
const storeUrl = process.env.THOUGHT_SIG_STORE
  ? pathToFileURL(resolve(process.env.THOUGHT_SIG_STORE)).href
  : new URL("../../open-sse/services/thoughtSignatureStore.js", import.meta.url).href;

const { storeGeminiThoughtSignature, getGeminiThoughtSignatureSync } = await import(storeUrl);

const kvCalls = globalThis.__kvCalls;
const tick = () => new Promise((r) => setTimeout(r, 0));
let n = 0;

beforeEach(() => {
  kvCalls.length = 0;
  delete process.env.WORKER_ROLE;
  delete process.env.SQLITE_MULTICORE;
});

test("control process persists signatures to SQLite kv", async () => {
  const id = `ctl_${Date.now()}_${n++}`;
  assert.doesNotThrow(() => storeGeminiThoughtSignature(id, "SIG", "sess", "gemini-3.7-flash"));
  await tick();

  const sets = kvCalls.filter((c) => c.op === "set");
  assert.equal(sets.length, 2, "expected session key + bare key writes");
  assert.deepEqual(sets.map((c) => c.key), [`sess:${id}`, id]);
  assert.equal(sets[0].value.signature, "SIG");
  assert.equal(sets[0].value.family, "gemini");
  assert.ok(sets[0].value.expiresAt > Date.now(), "persisted entries carry a future TTL");
});

test("read-only multicore worker skips kv writes and does not throw", async () => {
  process.env.WORKER_ROLE = "api";
  process.env.SQLITE_MULTICORE = "redis";
  const id = `wrk_${Date.now()}_${n++}`;

  assert.doesNotThrow(() => storeGeminiThoughtSignature(id, "SIG", "sess", "gemini-3.7-flash"));
  await tick();

  assert.equal(kvCalls.length, 0, "no kv mutation may be attempted on a read-only worker");
  // RAM cache still serves the current process.
  assert.equal(getGeminiThoughtSignatureSync(id, "sess", "gemini-3.7-flash"), "SIG");
});
