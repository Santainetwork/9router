import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../../src/app/api/ready/route.js", import.meta.url), "utf8");
const readinessDepsSource = await readFile(new URL("../../src/lib/db/workerReadinessDeps.js", import.meta.url), "utf8");
const { buildWorkerReadyDeps } = await import("../../src/lib/db/workerReadinessDeps.js");

test("internal readiness route uses Redis-aware worker gate", () => {
  assert.match(source, /checkWorkerReady/);
  assert.doesNotMatch(source, /const result = await checkDatabaseReady\(\)/);
});

test("worker gate wiring uses shared Redis command client and Go limiter health", () => {
  assert.match(source, /getRedisManager/);
  assert.match(source, /isGoLimiterActive/);
  assert.match(readinessDepsSource, /redisManager\(\)\.command\(\)|redisManager\(\)\.command/);
});

test("Redis connection failure becomes an unhealthy dependency instead of escaping GET", async () => {
  const deps = await buildWorkerReadyDeps({
    isWorker: () => true,
    redisManager: () => ({ command: async () => { throw new Error("redis://secret@internal"); } }),
    limiterHealth: async () => true,
  });
  assert.equal(deps.redis, null);
  assert.equal(await deps.goLimiterHealth(), true);
});
