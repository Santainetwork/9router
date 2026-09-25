import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "redis";

import { createMutationQueue } from "../../src/lib/db/sqliteMutationQueue.js";
import { createMutationWriter } from "../../src/lib/db/sqliteMutationWriter.js";

const url = process.env.REDIS_TEST_URL;
const run = url ? test : test.skip;

function memoryDb() {
  const receipts = new Map();
  return {
    receipts,
    get(sql, [id]) {
      if (sql.includes("sqliteMutationReceipts")) return receipts.get(id) || null;
      return null;
    },
    run(sql, params) {
      if (sql.includes("INSERT INTO sqliteMutationReceipts")) {
        receipts.set(params[0], { result: params[4], appliedAt: params[3] });
      }
      return { changes: 1 };
    },
    transaction(fn) { return fn(); },
  };
}

run("real Redis stream enqueue, commit, ACK, deletion and duplicate replay", async () => {
  const namespace = `9router:test:${process.pid}:${Date.now()}`;
  const command = createClient({ url, disableOfflineQueue: true });
  const blocking = command.duplicate();
  await Promise.all([command.connect(), blocking.connect()]);
  const manager = { command: async () => command, blocking: async () => blocking };
  const db = memoryDb();
  let applied = 0;
  const writer = createMutationWriter({
    redis: command,
    db,
    namespace,
    applyMutation() { applied++; return { saved: true }; },
    retryDelayMs: 0,
  });
  const queue = createMutationQueue({ redis: manager, namespace, maxQueued: 10 });
  const input = {
    type: "footerLog.add",
    receiptId: "m-redis-integration-0001",
    workerId: "integration-worker",
    createdAt: new Date().toISOString(),
    payload: { provider: "p", model: "m", referralText: "safe" },
  };

  try {
    await command.del(`${namespace}:mutations`, `${namespace}:mutations:dead`);
    await writer.start();
    await queue.enqueueMutation(input);
    assert.equal(await writer.runOnce({ blockMs: 50 }), 1);
    assert.equal(applied, 1);
    assert.equal(await command.xLen(`${namespace}:mutations`), 0);

    await queue.enqueueMutation(input);
    assert.equal(await writer.runOnce({ blockMs: 50 }), 1);
    assert.equal(applied, 1);
    assert.equal(writer.status().duplicates, 1);
  } finally {
    await command.del(`${namespace}:mutations`, `${namespace}:mutations:dead`, `${namespace}:writer:heartbeat`);
    await Promise.all([command.close(), blocking.close()]);
  }
});

run("real Redis bounded queue reports backpressure without trimming accepted work", async () => {
  const namespace = `9router:test:${process.pid}:${Date.now()}:bounded`;
  const command = createClient({ url, disableOfflineQueue: true });
  const blocking = command.duplicate();
  await Promise.all([command.connect(), blocking.connect()]);
  const queue = createMutationQueue({
    redis: { command: async () => command, blocking: async () => blocking },
    namespace,
    maxQueued: 1,
  });
  const base = {
    type: "footerLog.add",
    workerId: "integration-worker",
    createdAt: new Date().toISOString(),
    payload: { provider: "p", model: "m", referralText: "safe" },
  };

  try {
    const first = await queue.enqueueMutation({ ...base, receiptId: "m-redis-integration-0002" });
    const second = await queue.enqueueMutation({ ...base, receiptId: "m-redis-integration-0003" });
    assert.equal(first.enqueued, true);
    assert.deepEqual(second, { enqueued: false, dropped: true, receiptId: "m-redis-integration-0003" });
    assert.equal(await command.xLen(`${namespace}:mutations`), 1);
  } finally {
    await command.del(`${namespace}:mutations`);
    await Promise.all([command.close(), blocking.close()]);
  }
});
