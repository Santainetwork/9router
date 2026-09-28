// Task 6/8: queue, writer, readiness, and routing keys share one safe,
// deployment-scoped REDIS_KEY_PREFIX. Default preserves existing installations.
import test from "node:test";
import assert from "node:assert/strict";

const client = await import("../../src/lib/redis/client.js");
const { createMutationQueue } = await import("../../src/lib/db/sqliteMutationQueue.js");
const { createMutationWriter } = await import("../../src/lib/db/sqliteMutationWriter.js");
const { createRoutingState } = await import("../../src/lib/redis/routingState.js");
const { checkWorkerReady } = await import("../../src/lib/db/workerReadiness.js");

function withPrefix(prefix, fn) {
  const old = process.env.REDIS_KEY_PREFIX;
  if (prefix === undefined) delete process.env.REDIS_KEY_PREFIX;
  else process.env.REDIS_KEY_PREFIX = prefix;
  return Promise.resolve(fn()).finally(() => {
    if (old === undefined) delete process.env.REDIS_KEY_PREFIX;
    else process.env.REDIS_KEY_PREFIX = old;
  });
}

test("redisNamespace resolves a safe deployment prefix and preserves default", () => {
  assert.equal(client.redisNamespace({ REDIS_KEY_PREFIX: "santa-prod" }), "santa-prod");
  assert.equal(client.redisNamespace({}), "9router:sqlite");
  assert.equal(client.redisNamespace({ REDIS_KEY_PREFIX: "" }), "9router:sqlite");
});

test("unsafe REDIS_KEY_PREFIX is rejected, never truncated", () => {
  assert.throws(() => client.redisNamespace({ REDIS_KEY_PREFIX: "santa\nXADD bad" }), /REDIS_KEY_PREFIX/);
  assert.throws(() => client.redisNamespace({ REDIS_KEY_PREFIX: "a/b" }), /REDIS_KEY_PREFIX/);
});

test("queue stream key uses REDIS_KEY_PREFIX", () => withPrefix("stack-a", async () => {
  const calls = [];
  const redis = {
    command: async () => ({
      async eval(_script, options) { calls.push(options); return "1-0"; },
    }),
    blocking: async () => ({ blPop: async () => null }),
  };
  const queue = createMutationQueue({ redis, maxQueued: 5 });
  await queue.enqueueMutation({
    type: "footerLog.add",
    payload: { provider: "x", model: "y", referralText: "z" },
  });
  assert.deepEqual(calls[0].keys, ["stack-a:mutations"]);
}));

test("writer stream and heartbeat keys use REDIS_KEY_PREFIX", () => withPrefix("stack-b", async () => {
  const groups = [];
  const heartbeats = [];
  const redis = {
    async xGroupCreate(...args) { groups.push(args); },
    async set(...args) { heartbeats.push(args); return "OK"; },
    async xAutoClaim() { return { nextId: "0-0", messages: [] }; },
    async xReadGroup() { return null; },
    async eval() { return [1, 1]; },
    async publish() { return 1; },
  };
  const db = { get: () => null, run() {}, transaction(fn) { return fn(); } };
  const writer = createMutationWriter({ redis, db, applyMutation() {} });
  await writer.start();
  assert.equal(groups[0][0], "stack-b:mutations");
  assert.equal(heartbeats[0][0], "stack-b:writer:heartbeat");
}));

test("routing selection key uses REDIS_KEY_PREFIX", () => withPrefix("stack-c", async () => {
  const calls = [];
  const state = createRoutingState({ redis: {
    async eval(_script, options) { calls.push(options); return 0; },
  } });
  await state.rotate("model-scope", ["a", "b"]);
  assert.deepEqual(calls[0].keys, ["stack-c:routing:model-scope"]);
}));

test("worker readiness probes writer keys under REDIS_KEY_PREFIX", () => withPrefix("stack-d", async () => {
  const heartbeatKeys = [];
  const streamKeys = [];
  const routingKeys = [];
  const result = await checkWorkerReady({
    env: process.env,
    isSqliteMulticoreWorker: () => true,
    checkDatabaseReady: async () => ({ ready: true, database: "sqlite" }),
    getAdapter: async () => ({ readOnly: true }),
    redis: {
      ping: async () => "PONG",
      eval: async (_script, options) => { routingKeys.push(options.keys[0]); return 1; },
      pTTL: async (key) => { heartbeatKeys.push(key); return 5000; },
      xLen: async (key) => { streamKeys.push(key); return 0; },
      xPending: async (key) => { streamKeys.push(key); return { pending: 0, firstId: null }; },
    },
    goLimiterHealth: async () => true,
  });
  assert.equal(result.ready, true, JSON.stringify(result));
  assert.deepEqual(routingKeys, ["stack-d:routing:readiness"]);
  assert.deepEqual(heartbeatKeys, ["stack-d:writer:heartbeat"]);
  assert.deepEqual(streamKeys, ["stack-d:mutations", "stack-d:mutations"]);
}));
