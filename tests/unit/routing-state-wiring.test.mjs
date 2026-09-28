// Task 6: routing-state wiring for combo and proxy rotation in multicore.
import test from "node:test";
import assert from "node:assert/strict";

const { getRotatedModelsMulticore } = await import("../../open-sse/services/combo.js");
const { pickProxyPoolIdMulticore } = await import("../../src/lib/network/connectionProxy.js");
const { checkWorkerReady } = await import("../../src/lib/db/workerReadiness.js");

function fakeRedisManager() {
  const store = new Map();
  const redis = {
    async eval(_script, { keys, arguments: args }) {
      const key = keys[0];
      if (args.length > 1) {
        const n = Number(args[0]);
        const sticky = Number(args[1]);
        const raw = store.get(key) || "0:0";
        const sep = raw.indexOf(":");
        const cur = Number(raw.slice(0, sep)) || 0;
        const count = Number(raw.slice(sep + 1)) || 0;
        const idx = cur % n;
        const nextCount = count + 1;
        if (nextCount >= sticky) store.set(key, `${(cur + 1) % n}:0`);
        else store.set(key, `${cur}:${nextCount}`);
        return idx;
      }
      const n = Number(args[0]);
      const cur = Number(store.get(key) || "0") || 0;
      const idx = cur % n;
      store.set(key, String((cur + 1) % n));
      return idx;
    },
  };
  return { manager: { command: async () => redis }, store };
}

test("combo multicore rotation advances atomically across calls", async () => {
  const { manager } = fakeRedisManager();
  const models = ["a/x", "b/y"];
  const opts = { getRedisManager: async () => manager, isWorker: async () => true };

  const first = await getRotatedModelsMulticore(models, "code", 2, opts);
  const second = await getRotatedModelsMulticore(models, "code", 2, opts);
  assert.equal(first[0], "a/x");
  assert.equal(second[0], "a/x"); // sticky limit 2 keeps the same front
  const third = await getRotatedModelsMulticore(models, "code", 2, opts);
  assert.equal(third[0], "b/y");
});

test("combo multicore falls back to local rotation when not a worker", async () => {
  const models = ["a/x", "b/y"];
  const opts = { getRedisManager: async () => { throw new Error("must not call"); }, isWorker: async () => false };
  const first = await getRotatedModelsMulticore(models, "code", 1, opts);
  assert.equal(first[0], "a/x");
});

test("combo multicore rejects on Redis failure without local fallback", async () => {
  const opts = {
    getRedisManager: async () => ({ command: async () => ({ eval: async () => { throw new Error("down"); } }) }),
    isWorker: async () => true,
  };
  await assert.rejects(
    getRotatedModelsMulticore(["a/x", "b/y"], "code", 1, opts),
    (e) => e.code === "ROUTING_REDIS_UNAVAILABLE",
  );
});

test("proxy pool multicore rotation advances atomically", async () => {
  const { manager } = fakeRedisManager();
  const pools = ["p1", "p2"];
  const opts = { getRedisManager: async () => manager, isWorker: async () => true };
  assert.equal(await pickProxyPoolIdMulticore(pools, "round-robin", "prov", opts), "p1");
  assert.equal(await pickProxyPoolIdMulticore(pools, "round-robin", "prov", opts), "p2");
  assert.equal(await pickProxyPoolIdMulticore(pools, "round-robin", "prov", opts), "p1");
});

test("proxy pool multicore rejects on Redis failure without local fallback", async () => {
  const opts = {
    getRedisManager: async () => ({ command: async () => ({ eval: async () => { throw new Error("down"); } }) }),
    isWorker: async () => true,
  };
  await assert.rejects(
    pickProxyPoolIdMulticore(["p1", "p2"], "round-robin", "prov", opts),
    (e) => e.code === "ROUTING_REDIS_UNAVAILABLE",
  );
});

test("routing Redis failure removes the worker from readiness", async () => {
  const result = await checkWorkerReady({
    env: { WORKER_ROLE: "api", SQLITE_MULTICORE: "redis" },
    isSqliteMulticoreWorker: () => true,
    checkDatabaseReady: async () => ({ ready: true, database: "sqlite" }),
    getAdapter: async () => ({ readOnly: true }),
    redis: {
      ping: async () => "PONG",
      eval: async () => { throw new Error("down"); },
      pTTL: async () => 15_000,
      xLen: async () => 0,
      xPending: async () => ({ pending: 0, firstId: null }),
    },
    goLimiterHealth: async () => true,
  });
  assert.equal(result.ready, false);
  assert.equal(result.reason, "redis_unhealthy");
});
