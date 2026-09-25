// Task 7 of docs/superpowers/plans/2026-09-24-sqlite-redis-multicore.md
//
//   * Non-multicore roles delegate to checkDatabaseReady without touching Redis,
//     the Go limiter or the writer heartbeat.
//   * A SQLite Redis API worker is ready only when all five dependencies hold,
//     and fails on the first missing one in a fixed order.
//   * Counters are bounded numbers; the payload never carries a URL, secret, raw
//     error text, schemaVersion or latency.

import test from "node:test";
import assert from "node:assert/strict";

const { checkWorkerReady } = await import("../../src/lib/db/workerReadiness.js");

const SECRET_URL = "redis://user:sup3rsecret@redis.internal:6379/0";

function workerEnv() {
  return { WORKER_ROLE: "api", SQLITE_MULTICORE: "redis" };
}

function controlEnv() {
  return { WORKER_ROLE: "control" };
}

const dbReady = { ready: true, database: "sqlite", schemaVersion: 4, latencyMs: 1 };
const dbNotReady = { ready: false, database: "sqlite", reason: "schema_missing" };

function okRedis(overrides = {}) {
  return {
    async ping() { return "PONG"; },
    async get() { return new Date(Date.now()).toISOString(); },
    async xLen() { return 5; },
    async xPending() { return { pending: 2, firstId: `${Date.now()}-0`, lastId: `${Date.now()}-0` }; },
    ...overrides,
  };
}

function okDeps(overrides = {}) {
  return {
    env: workerEnv(),
    isSqliteMulticoreWorker: (env) => env.SQLITE_MULTICORE === "redis" && env.WORKER_ROLE === "api",
    checkDatabaseReady: async () => dbReady,
    getAdapter: async () => ({ readOnly: true }),
    redis: okRedis(),
    goLimiterHealth: async () => true,
    now: () => Date.now(),
    ...overrides,
  };
}

test("non-multicore role delegates to checkDatabaseReady and skips worker checks", async () => {
  const seen = [];
  const result = await checkWorkerReady({
    env: controlEnv(),
    isSqliteMulticoreWorker: () => false,
    checkDatabaseReady: async (deps) => { seen.push(deps); return { ready: true, database: "postgres", reason: undefined }; },
    getAdapter: async () => { throw new Error("must not load adapter"); },
    redis: null,
    goLimiterHealth: async () => { throw new Error("must not probe limiter"); },
  });

  assert.equal(result.ready, true);
  assert.equal(result.database, "postgres");
  assert.equal(result.reason, undefined);
  assert.deepEqual(result.counters, {});
  assert.equal(seen.length, 1);
});

test("non-multicore role surfaces the delegated not-ready reason", async () => {
  const result = await checkWorkerReady({
    env: controlEnv(),
    isSqliteMulticoreWorker: () => false,
    checkDatabaseReady: async () => ({ ready: false, database: "sqlite", reason: "schema_mismatch" }),
  });
  assert.equal(result.ready, false);
  assert.equal(result.reason, "schema_mismatch");
});

test("multicore worker with all dependencies healthy is ready with bounded counters", async () => {
  const now = 1_000_000;
  const result = await checkWorkerReady(okDeps({
    now: () => now,
    redis: okRedis({
      async get() { return new Date(now - 5_000).toISOString(); },
      async xLen() { return 42; },
      async xPending() { return { pending: 3, firstId: `${now - 10_000}-0`, lastId: `${now}-0` }; },
    }),
  }));

  assert.equal(result.ready, true);
  assert.equal(result.database, "sqlite");
  assert.equal(result.reason, undefined);
  assert.deepEqual(result.counters, { streamLength: 42, pending: 3, oldestPendingAgeMs: 10_000 });
});

test("database not ready fails first with the probe reason", async () => {
  const result = await checkWorkerReady(okDeps({ checkDatabaseReady: async () => dbNotReady }));
  assert.equal(result.ready, false);
  assert.equal(result.reason, "schema_missing");
});

test("adapter load failure is a sanitized adapter_error", async () => {
  const result = await checkWorkerReady(okDeps({
    getAdapter: async () => { throw new Error(`connect ECONNREFUSED ${SECRET_URL}`); },
  }));
  assert.equal(result.ready, false);
  assert.equal(result.reason, "adapter_error");
  assert.ok(!JSON.stringify(result).includes("sup3rsecret"));
  assert.ok(!JSON.stringify(result).includes("ECONNREFUSED"));
});

test("adapter that is not read-only fails closed", async () => {
  const result = await checkWorkerReady(okDeps({ getAdapter: async () => ({ readOnly: false }) }));
  assert.equal(result.ready, false);
  assert.equal(result.reason, "db_not_readonly");
});

test("missing redis dependency fails redis_unhealthy", async () => {
  const result = await checkWorkerReady(okDeps({ redis: null }));
  assert.equal(result.ready, false);
  assert.equal(result.reason, "redis_unhealthy");
});

test("redis ping that throws is redis_unhealthy and never leaks the error", async () => {
  const result = await checkWorkerReady(okDeps({
    redis: okRedis({ async ping() { throw new Error(`ECONNREFUSED ${SECRET_URL}`); } }),
  }));
  assert.equal(result.ready, false);
  assert.equal(result.reason, "redis_unhealthy");
  assert.ok(!JSON.stringify(result).includes("sup3rsecret"));
});

test("writer heartbeat missing or too old fails writer_heartbeat_stale", async () => {
  for (const value of [null, "not-a-date", ""]) {
    const result = await checkWorkerReady(okDeps({ redis: okRedis({ async get() { return value; } }) }));
    assert.equal(result.ready, false, `heartbeat value ${JSON.stringify(value)}`);
    assert.equal(result.reason, "writer_heartbeat_stale");
  }

  const stale = await checkWorkerReady(okDeps({
    now: () => 1_000_000,
    redis: okRedis({ async get() { return new Date(1_000_000 - 60_000).toISOString(); } }),
  }));
  assert.equal(stale.ready, false);
  assert.equal(stale.reason, "writer_heartbeat_stale");
});

test("fresh heartbeat within the configured window passes", async () => {
  const result = await checkWorkerReady(okDeps({
    now: () => 1_000_000,
    redis: okRedis({ async get() { return new Date(1_000_000 - 20_000).toISOString(); } }),
    heartbeatFreshMs: 30_000,
  }));
  assert.equal(result.ready, true);
});

test("go limiter unhealthy fails go_limiter_unhealthy", async () => {
  for (const probe of [async () => false, async () => { throw new Error("down"); }]) {
    const result = await checkWorkerReady(okDeps({ goLimiterHealth: probe }));
    assert.equal(result.ready, false);
    assert.equal(result.reason, "go_limiter_unhealthy");
  }
});

test("stream backlog over the limit fails backlog_exceeded with counters", async () => {
  const result = await checkWorkerReady(okDeps({
    maxBacklog: 10,
    redis: okRedis({ async xLen() { return 11; } }),
  }));
  assert.equal(result.ready, false);
  assert.equal(result.reason, "backlog_exceeded");
  assert.equal(result.counters.streamLength, 11);
});

test("oldest pending entry over the age limit fails pending_age_exceeded", async () => {
  const now = 1_000_000;
  const result = await checkWorkerReady(okDeps({
    now: () => now,
    maxPendingAgeMs: 30_000,
    redis: okRedis({ async xPending() { return { pending: 1, firstId: `${now - 60_000}-0`, lastId: `${now}-0` }; } }),
  }));
  assert.equal(result.ready, false);
  assert.equal(result.reason, "pending_age_exceeded");
  assert.equal(result.counters.oldestPendingAgeMs, 60_000);
});

test("no pending entries means no age failure even with a zero firstId", async () => {
  const result = await checkWorkerReady(okDeps({
    redis: okRedis({ async xPending() { return { pending: 0, firstId: null, lastId: null }; } }),
  }));
  assert.equal(result.ready, true);
  assert.equal(result.counters.oldestPendingAgeMs, 0);
});

test("stream read failure is redis_unhealthy, not an age/backlog leak", async () => {
  const result = await checkWorkerReady(okDeps({
    redis: okRedis({ async xLen() { throw new Error(`NOAUTH ${SECRET_URL}`); } }),
  }));
  assert.equal(result.ready, false);
  assert.equal(result.reason, "redis_unhealthy");
  assert.ok(!JSON.stringify(result).includes("NOAUTH"));
});

test("counter fields are finite bounded numbers", async () => {
  const result = await checkWorkerReady(okDeps({
    redis: okRedis({
      async xLen() { return Number.MAX_SAFE_INTEGER; },
      async xPending() { return { pending: -3, firstId: "bogus", lastId: "0-0" }; },
    }),
  }));
  for (const key of ["streamLength", "pending", "oldestPendingAgeMs"]) {
    assert.ok(Number.isFinite(result.counters[key]), `${key} must be finite`);
    assert.ok(result.counters[key] >= 0, `${key} must be non-negative`);
  }
  assert.ok(result.counters.streamLength <= 1_000_000_000, "streamLength is clamped");
  assert.equal(result.counters.pending, 0, "negative pending is clamped to 0");
  assert.equal(result.counters.oldestPendingAgeMs, 0, "unparseable id yields 0 age");
});
