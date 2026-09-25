import test from "node:test";
import assert from "node:assert/strict";

const { createMutationQueue } = await import("../../src/lib/db/sqliteMutationQueue.js");

function fakeRedis({ evalResult = "1-0", receipt = null, evalError = null } = {}) {
  const calls = { eval: [], blPop: [] };
  const command = {
    async eval(...args) {
      calls.eval.push(args);
      if (evalError) throw evalError;
      return evalResult;
    },
  };
  const blocking = {
    async blPop(...args) {
      calls.blPop.push(args);
      return receipt === undefined ? null : receipt;
    },
  };
  return { calls, manager: { command: async () => command, blocking: async () => blocking } };
}

const input = {
  type: "footerLog.add",
  payload: { provider: "anthropic", model: "claude", referralText: "safe" },
  workerId: "worker-1",
  receiptId: "m-1234567890abcdef",
  createdAt: "2026-09-25T00:00:00.000Z",
};

test("rejects unsafe namespaces before creating Redis clients", () => {
  const redis = fakeRedis();
  assert.throws(() => createMutationQueue({ redis: redis.manager, namespace: "tenant\nXADD bad" }), /namespace/);
  assert.equal(redis.calls.eval.length, 0);
});

test("namespaces stream and receipt keys; EVAL bounds queue and adds validated command atomically", async () => {
  const redis = fakeRedis();
  const queue = createMutationQueue({ redis: redis.manager, namespace: "tenant-a:sqlite", maxQueued: 12 });

  const result = await queue.enqueueMutation(input);

  assert.equal(result.enqueued, true);
  assert.equal(result.receiptId, input.receiptId);
  const [script, options] = redis.calls.eval[0];
  assert.match(script, /XLEN/);
  assert.match(script, /XADD/);
  assert.match(script, /return -1/);
  assert.deepEqual(options.keys, ["tenant-a:sqlite:mutations"]);
  assert.equal(options.arguments[0], "12");
  const command = JSON.parse(options.arguments[1]);
  assert.equal(command.receiptId, input.receiptId);
  assert.equal(command.consistency, "async");
  assert.equal(queue.status().enqueued, 1);
});

test("same receipt ID survives retry and accepted async call waits for Redis EVAL acknowledgement", async () => {
  let acknowledge;
  let attempt = 0;
  const redis = fakeRedis();
  redis.manager.command = async () => ({
    eval(...args) {
      redis.calls.eval.push(args);
      if (attempt++) return Promise.resolve("2-0");
      return new Promise((resolve) => { acknowledge = resolve; });
    },
  });
  const queue = createMutationQueue({ redis: redis.manager, namespace: "n" });
  const first = queue.enqueueMutation(input);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queue.status().enqueued, 0);
  acknowledge("1-0");
  await first;
  await queue.enqueueMutation(input);
  assert.deepEqual(redis.calls.eval.map(([, options]) => JSON.parse(options.arguments[1]).receiptId), [input.receiptId, input.receiptId]);
  assert.equal(queue.status().enqueued, 2);
});

test("sync call uses separate blocking client and resolves only committed receipt", async () => {
  const redis = fakeRedis({ receipt: { key: "n:receipt:m-1234567890abcdef", element: JSON.stringify({ ok: true, receiptId: input.receiptId, result: { saved: true } }) } });
  const queue = createMutationQueue({ redis: redis.manager, namespace: "n", syncTimeoutMs: 2500 });

  const result = await queue.enqueueMutation({ ...input, consistency: "sync" });

  assert.deepEqual(result, { enqueued: true, receiptId: input.receiptId, result: { saved: true } });
  assert.deepEqual(redis.calls.blPop[0], ["n:receipt:m-1234567890abcdef", 2.5]);
  assert.equal(queue.status().enqueued, 1);
});

test("sync timeout fails with sanitized error and increments failures", async () => {
  const redis = fakeRedis({ receipt: undefined });
  const queue = createMutationQueue({ redis: redis.manager, namespace: "n", syncTimeoutMs: 30 });

  await assert.rejects(queue.enqueueMutation({ ...input, consistency: "sync" }), (error) => {
    assert.equal(error.code, "MUTATION_SYNC_TIMEOUT");
    assert.doesNotMatch(error.message, /m-1234567890abcdef|safe/);
    return true;
  });
  assert.equal(queue.status().failures, 1);
});

test("bounded queue drops async telemetry and counts backpressure without trimming", async () => {
  const redis = fakeRedis({ evalResult: -1 });
  const queue = createMutationQueue({ redis: redis.manager, namespace: "n", maxQueued: 1 });

  const result = await queue.enqueueMutation(input);

  assert.deepEqual(result, { enqueued: false, dropped: true, receiptId: input.receiptId });
  assert.equal(queue.status().backpressure, 1);
  assert.equal(queue.status().telemetryDropped, 1);
  assert.equal(queue.status().enqueued, 0);
  assert.doesNotMatch(redis.calls.eval[0][0], /XTRIM/);
});

test("sync backpressure fails closed without waiting for a receipt", async () => {
  const redis = fakeRedis({ evalResult: -1 });
  const queue = createMutationQueue({ redis: redis.manager, namespace: "n" });

  await assert.rejects(queue.enqueueMutation({ ...input, consistency: "sync" }), (error) => {
    assert.equal(error.code, "MUTATION_QUEUE_FULL");
    assert.doesNotMatch(error.message, /m-1234567890abcdef|safe/);
    return true;
  });
  assert.equal(redis.calls.blPop.length, 0);
  assert.deepEqual(queue.status(), { enqueued: 0, telemetryDropped: 0, backpressure: 1, failures: 1 });
});

test("async Redis failure drops telemetry without exposing Redis error text", async () => {
  const redis = fakeRedis({ evalError: new Error("redis://user:password@host secret payload") });
  const queue = createMutationQueue({ redis: redis.manager, namespace: "n" });

  const result = await queue.enqueueMutation(input);

  assert.deepEqual(result, { enqueued: false, dropped: true, receiptId: input.receiptId });
  assert.equal(queue.status().telemetryDropped, 1);
  assert.equal(queue.status().failures, 1);
});

test("invalid mutation is rejected before Redis and sensitive values never enter Redis calls", async () => {
  const redis = fakeRedis();
  const queue = createMutationQueue({ redis: redis.manager, namespace: "n" });

  await assert.rejects(queue.enqueueMutation({ ...input, payload: { ...input.payload, authorization: "Bearer topsecretvalue123" } }), (error) => {
    assert.equal(error.code, "MUTATION_SENSITIVE_FIELD");
    assert.doesNotMatch(error.message, /topsecret|Bearer/);
    return true;
  });
  assert.equal(redis.calls.eval.length, 0);
  assert.equal(queue.status().failures, 1);
});

test("consistency override builds a sync mutation with queue worker identity", async () => {
  const redis = fakeRedis({ receipt: { key: "n:receipt:m-1234567890abcdef", element: JSON.stringify({ ok: true, receiptId: input.receiptId, result: null }) } });
  const queue = createMutationQueue({ redis: redis.manager, namespace: "n", workerId: "injected-worker" });

  await queue.enqueueMutation({ type: input.type, payload: input.payload, receiptId: input.receiptId, createdAt: input.createdAt }, { consistency: "sync" });

  const command = JSON.parse(redis.calls.eval[0][1].arguments[1]);
  assert.equal(command.workerId, "injected-worker");
  assert.equal(command.consistency, "sync");
});

test("sync Redis failure rejects with sanitized error rather than falling back", async () => {
  const redis = fakeRedis({ evalError: new Error("secret redis password") });
  const queue = createMutationQueue({ redis: redis.manager, namespace: "n" });

  await assert.rejects(queue.enqueueMutation({ ...input, consistency: "sync" }), (error) => {
    assert.equal(error.code, "MUTATION_QUEUE_UNAVAILABLE");
    assert.doesNotMatch(error.message, /secret|password/);
    return true;
  });
  assert.equal(redis.calls.blPop.length, 0);
  assert.equal(queue.status().failures, 1);
});
