// Task 8: external Redis preflight. The spec requires external REDIS_URL
// deployments to be validated at startup for persistence (AOF), eviction policy
// (noeviction) and required command support before the control writer starts.
// The bundled Compose profile enforces these via redis-server flags; an
// operator-supplied external Redis is untrusted and must be probed at runtime.
// Fail closed: any missing/unsafe setting refuses to start the writer.
import test from "node:test";
import assert from "node:assert/strict";

const { checkRedisServerConfig } = await import("../../src/lib/redis/serverConfig.js");

function okRedis(overrides = {}) {
  const config = new Map([
    ["appendonly", "yes"],
    ["maxmemory-policy", "noeviction"],
  ]);
  const probed = [];
  return {
    async configGet(pattern) {
      probed.push(pattern);
      const out = {};
      for (let i = 0; i < config.size; i += 2) {}
      // node-redis v4 configGet returns array or object depending on version;
      // the implementation must handle both.
      return { appendonly: config.get("appendonly"), "maxmemory-policy": config.get("maxmemory-policy") };
    },
    async ping() { return "PONG"; },
    ...overrides,
  };
}

test("passes when AOF is on and eviction is noeviction", async () => {
  const result = await checkRedisServerConfig(okRedis());
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
});

test("fails closed when AOF is off", async () => {
  const redis = okRedis({ async configGet() { return { appendonly: "no", "maxmemory-policy": "noeviction" }; } });
  const result = await checkRedisServerConfig(redis);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => /appendonly/i.test(i)));
});

test("fails closed when eviction policy can evict keys", async () => {
  for (const policy of ["allkeys-lru", "volatile-lru", "allkeys-lfu", "volatile-ttl"]) {
    const redis = okRedis({ async configGet() { return { appendonly: "yes", "maxmemory-policy": policy }; } });
    const result = await checkRedisServerConfig(redis);
    assert.equal(result.ok, false, `policy ${policy} must fail`);
    assert.ok(result.issues.some((i) => /maxmemory-policy/i.test(i)));
  }
});

test("probe failure fails closed without leaking the error", async () => {
  const redis = okRedis({
    async configGet() { throw new Error("NOPERM redis://secret@host"); },
  });
  const result = await checkRedisServerConfig(redis);
  assert.equal(result.ok, false);
  assert.ok(JSON.stringify(result).indexOf("secret") === -1);
});

test("missing client fails closed", async () => {
  const result = await checkRedisServerConfig(null);
  assert.equal(result.ok, false);
});

test("array-shaped config responses are handled", async () => {
  // Redis 7 RESP2 CONFIG GET returns a flat [key, value] array per call.
  const redis = okRedis({
    async configGet(name) {
      return name === "appendonly" ? ["appendonly", "yes"] : ["maxmemory-policy", "noeviction"];
    },
  });
  const result = await checkRedisServerConfig(redis);
  assert.equal(result.ok, true);
});
