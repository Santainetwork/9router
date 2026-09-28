// Review P6: worker telemetry loss/backpressure must be observable. The queue
// already tracks telemetryDropped/backpressure, but nothing surfaced them, so a
// silently degraded worker looked healthy. These tests pin the worker telemetry
// status probe, the loss counter on async drop, and the readiness counters.
import test from "node:test";
import assert from "node:assert/strict";

const state = global.__workerMutationState ??= { queue: null };
const telemetry = await import("../../src/lib/db/workerMutation.js");
const { checkWorkerReady } = await import("../../src/lib/db/workerReadiness.js");
const { buildWorkerReadyDeps } = await import("../../src/lib/db/workerReadinessDeps.js");

function fakeQueue(status, result) {
  return {
    enqueueMutation: async () => result ?? { enqueued: false, dropped: true, receiptId: "r1" },
    status: () => status,
  };
}

function okDeps(overrides = {}) {
  return {
    env: { WORKER_ROLE: "api", SQLITE_MULTICORE: "redis" },
    isSqliteMulticoreWorker: (env) => env.SQLITE_MULTICORE === "redis" && env.WORKER_ROLE === "api",
    checkDatabaseReady: async () => ({ ready: true, database: "sqlite" }),
    getAdapter: async () => ({ readOnly: true }),
    redis: {
      async ping() { return "PONG"; },
      async eval() { return 1; },
      async pTTL() { return 15_000; },
      async xLen() { return 5; },
      async xPending() { return { pending: 1, firstId: `${Date.now()}-0`, lastId: `${Date.now()}-0` }; },
    },
    goLimiterHealth: async () => true,
    ...overrides,
  };
}

test("worker telemetry status surfaces the queue dropped/backpressure counters", () => {
  state.queue = fakeQueue({ enqueued: 7, telemetryDropped: 3, backpressure: 2, failures: 1 });
  assert.deepEqual(telemetry.getWorkerTelemetryStatus(), {
    enqueued: 7, telemetryDropped: 3, backpressure: 2, failures: 1, telemetryLost: 0,
  });
});

test("worker telemetry status is bounded zeros when no queue exists", () => {
  state.queue = null;
  assert.deepEqual(telemetry.getWorkerTelemetryStatus(), {
    enqueued: 0, telemetryDropped: 0, backpressure: 0, failures: 0, telemetryLost: 0,
  });
});

test("enqueueTelemetry counts each async drop so loss is observable", async () => {
  const queue = fakeQueue({ enqueued: 0, telemetryDropped: 5, backpressure: 4, failures: 0 });
  state.queue = queue;
  const before = telemetry.getWorkerTelemetryStatus().telemetryLost;
  const result = await telemetry.enqueueTelemetry(queue, { type: "usage.save", payload: {} });
  assert.equal(result.dropped, true);
  assert.equal(telemetry.getWorkerTelemetryStatus().telemetryLost, before + 1);
});

test("enqueueTelemetry counts a thrown enqueue as loss too", async () => {
  const queue = { enqueueMutation: async () => { throw new Error("redis down"); }, status: () => ({}) };
  state.queue = queue;
  const before = telemetry.getWorkerTelemetryStatus().telemetryLost;
  const result = await telemetry.enqueueTelemetry(queue, { type: "usage.save", payload: {} });
  assert.equal(result.dropped, true);
  assert.equal(telemetry.getWorkerTelemetryStatus().telemetryLost, before + 1);
});

test("readiness counters carry telemetry loss and backpressure", async () => {
  const result = await checkWorkerReady(okDeps({
    telemetryStatus: () => ({ telemetryDropped: 9, backpressure: 4, telemetryLost: 2 }),
  }));
  assert.equal(result.ready, true);
  assert.equal(result.counters.telemetryDropped, 9);
  assert.equal(result.counters.backpressure, 4);
  assert.equal(result.counters.telemetryLost, 2);
});

test("telemetry counters never make a healthy worker unready and stay bounded", async () => {
  const result = await checkWorkerReady(okDeps({
    telemetryStatus: () => ({ telemetryDropped: Number.MAX_SAFE_INTEGER, backpressure: -5, telemetryLost: NaN }),
  }));
  assert.equal(result.ready, true);
  assert.equal(result.counters.telemetryDropped, 1_000_000_000);
  assert.equal(result.counters.backpressure, 0);
  assert.equal(result.counters.telemetryLost, 0);
});

test("a telemetry probe failure is ignored instead of breaking readiness", async () => {
  const result = await checkWorkerReady(okDeps({
    telemetryStatus: () => { throw new Error("probe exploded"); },
  }));
  assert.equal(result.ready, true);
  assert.equal(result.counters.telemetryDropped, undefined);
});

test("buildWorkerReadyDeps wires the worker telemetry status probe", async () => {
  state.queue = fakeQueue({ enqueued: 1, telemetryDropped: 6, backpressure: 2, failures: 0 });
  const deps = await buildWorkerReadyDeps({
    isWorker: () => true,
    redisManager: () => ({ command: async () => ({}) }),
    limiterHealth: async () => true,
  });
  assert.equal(typeof deps.telemetryStatus, "function");
  assert.equal(deps.telemetryStatus().telemetryDropped, 6);
  assert.equal(deps.telemetryStatus().backpressure, 2);
});
