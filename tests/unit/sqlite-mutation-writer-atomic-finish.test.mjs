import test from "node:test";
import assert from "node:assert/strict";

const { createMutationWriter } = await import("../../src/lib/db/sqliteMutationWriter.js");

const STREAM = "n:mutations";
const GROUP = "writer";

const mutation = {
  schemaVersion: 1,
  type: "footerLog.add",
  receiptId: "m-1234567890abcdef",
  workerId: "worker-1",
  createdAt: "2026-09-25T00:00:00.000Z",
  payload: { provider: "anthropic", model: "claude", referralText: "safe" },
  consistency: "async",
};

function entry(id = "1-0") {
  return { id, message: { command: JSON.stringify(mutation) } };
}

function fakeRedis({ evalReply = [1, 1], evalError = null, withEval = true } = {}) {
  const calls = { eval: [], acks: [], deletes: [] };
  const redis = {
    calls,
    async xGroupCreate() {},
    async set() {},
    async xReadGroup() { return [{ name: STREAM, messages: [entry()] }]; },
    async xAutoClaim() { return { nextId: "0-0", messages: [] }; },
    async xAdd() { return "2-0"; },
    async lPush() { return 1; },
    async expire() { return 1; },
    // Legacy two-call API stays observable so the test can prove it is unused.
    async xAck(...args) { calls.acks.push(args); return 1; },
    async xDel(...args) { calls.deletes.push(args); return 1; },
  };
  if (withEval) {
    redis.eval = async (...args) => {
      calls.eval.push(args);
      if (evalError) throw evalError;
      return evalReply;
    };
  }
  return redis;
}

function fakeDb() {
  return {
    get() { return null; },
    run() { return { changes: 1 }; },
    transaction(fn) { return fn(); },
  };
}

function writerFor(redis, options = {}) {
  return createMutationWriter({
    redis,
    db: fakeDb(),
    streamKey: STREAM,
    deadLetterKey: "n:dead",
    group: GROUP,
    consumer: "control-1",
    applyMutation() { return { stored: true }; },
    ...options,
  });
}

test("finishing a committed entry is one atomic XACK+XDEL eval, never two commands", async () => {
  const redis = fakeRedis();
  const writer = writerFor(redis);

  await writer.start();
  assert.equal(await writer.runOnce({ blockMs: 1 }), 1);

  assert.equal(redis.calls.eval.length, 1, "finish must be a single atomic eval");
  const [script, options] = redis.calls.eval[0];
  assert.match(script, /XACK/);
  assert.match(script, /XDEL/);
  assert.deepEqual(options.keys, [STREAM]);
  assert.deepEqual(options.arguments, [GROUP, "1-0"]);
  assert.equal(redis.calls.acks.length, 0, "no separate xAck");
  assert.equal(redis.calls.deletes.length, 0, "no separate xDel");
});

test("missing atomic eval support fails loudly instead of ACKing without deleting", async () => {
  const redis = fakeRedis({ withEval: false });
  const writer = writerFor(redis);

  await writer.start();
  await assert.rejects(writer.runOnce({ blockMs: 1 }), /eval/);
  assert.equal(redis.calls.acks.length, 0, "must not fall back to a lone xAck");
  assert.equal(redis.calls.deletes.length, 0);
});

test("acknowledged-but-not-deleted entry is a hard failure, not silent XLEN growth", async () => {
  const redis = fakeRedis({ evalReply: [1, 0] });
  const writer = writerFor(redis);

  await writer.start();
  await assert.rejects(writer.runOnce({ blockMs: 1 }), /not deleted/);
});

test("atomic finish failure keeps the entry pending for recovery", async () => {
  const redis = fakeRedis({ evalError: new Error("LOADING Redis is loading the dataset in memory") });
  const writer = writerFor(redis);

  await writer.start();
  await assert.rejects(writer.runOnce({ blockMs: 1 }), /LOADING/);
  assert.equal(redis.calls.acks.length, 0);
  assert.equal(redis.calls.deletes.length, 0);
});
