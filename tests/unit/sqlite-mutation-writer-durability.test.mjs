import test from "node:test";
import assert from "node:assert/strict";

const { createMutationWriter } = await import("../../src/lib/db/sqliteMutationWriter.js");

const command = {
  schemaVersion: 1,
  type: "footerLog.add",
  receiptId: "m-abcdef1234567890",
  workerId: "worker-1",
  createdAt: "2026-09-25T00:00:00.000Z",
  payload: { provider: "p", model: "m", referralText: "safe" },
  consistency: "async",
};

function redisFor(entry) {
  const calls = { ack: 0, dead: 0 };
  return {
    calls,
    async xGroupCreate() {},
    async set() {},
    async xReadGroup() { return [{ name: "stream", messages: [entry] }]; },
    async eval() { calls.ack++; return [1, 1]; },
    async xAdd() { calls.dead++; },
    async lPush() {},
    async expire() {},
  };
}

test("non-transient handler failure stays pending instead of being dead-lettered immediately", async () => {
  const redis = redisFor({ id: "1-0", message: { command: JSON.stringify(command) } });
  const db = { get() { return null; }, run() {}, transaction(fn) { return fn(); } };
  const writer = createMutationWriter({ redis, db, applyMutation() { throw new Error("disk I/O error"); } });
  await writer.start();
  await assert.rejects(writer.runOnce({ blockMs: 1 }), /disk I\/O error/);
  assert.equal(redis.calls.ack, 0);
  assert.equal(redis.calls.dead, 0);
});

test("poison command dead-letter record never includes original payload", async () => {
  const secret = "do-not-copy-this-payload";
  const redis = redisFor({ id: "1-0", message: { command: JSON.stringify({ ...command, payload: { ...command.payload, referralText: secret }, sql: "DROP TABLE settings" }) } });
  let deadFields;
  redis.xAdd = async (_key, _id, fields) => { redis.calls.dead++; deadFields = fields; };
  const db = { get() { return null; }, run() {}, transaction(fn) { return fn(); } };
  const writer = createMutationWriter({ redis, db, applyMutation() {} });
  await writer.start();
  await writer.runOnce({ blockMs: 1 });
  assert.equal(JSON.stringify(deadFields).includes(secret), false);
  assert.equal(redis.calls.ack, 1);
});
