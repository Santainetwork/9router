import test from "node:test";
import assert from "node:assert/strict";

const { createMutationWriter, isTransientSqliteError } = await import("../../src/lib/db/sqliteMutationWriter.js");

function fakeRedis(messages = []) {
  const calls = { groups: [], reads: [], claims: [], evals: [], adds: [], sets: [], pushes: [], publishes: [] };
  let read = 0;
  return {
    calls,
    async xGroupCreate(...args) { calls.groups.push(args); },
    async xReadGroup(...args) {
      calls.reads.push(args);
      if (read++) return null;
      return messages.length ? [{ name: "n:mutations", messages }] : null;
    },
    async xAutoClaim(...args) { calls.claims.push(args); return { nextId: "0-0", messages: [] }; },
    async eval(...args) { calls.evals.push(args); return [1, 1]; },
    async xAdd(...args) { calls.adds.push(args); return "2-0"; },
    async set(...args) { calls.sets.push(args); return "OK"; },
    async lPush(...args) { calls.pushes.push(args); return 1; },
    async publish(...args) { calls.publishes.push(args); return 1; },
    async publish(...args) { calls.publishes.push(args); return 1; },
    async expire() { return 1; },
  };
}

function fakeDb(existingReceipt = null) {
  const state = { inserted: [], applied: [], versions: 0 };
  return {
    state,
    get(sql, params) {
      if (sql.includes("sqliteMutationReceipts")) return existingReceipt;
      return null;
    },
    run(sql, params = []) {
      if (sql.includes("INSERT INTO sqliteMutationReceipts")) state.inserted.push(params);
      if (sql.includes("dbVersion")) state.versions++;
      return { changes: 1 };
    },
    transaction(fn) { return fn(); },
  };
}

const mutation = {
  schemaVersion: 1,
  type: "footerLog.add",
  receiptId: "m-1234567890abcdef",
  workerId: "worker-1",
  createdAt: "2026-09-25T00:00:00.000Z",
  payload: { provider: "anthropic", model: "claude", referralText: "safe" },
  consistency: "async",
};

function message(command = mutation, id = "1-0") {
  return { id, message: { command: JSON.stringify(command) } };
}

test("writer creates consumer group, commits mutation, then atomically finishes the entry", async () => {
  const redis = fakeRedis([message()]);
  const db = fakeDb();
  const order = [];
  db.transaction = (fn) => { const value = fn(); order.push("commit"); return value; };
  redis.eval = async (...args) => { order.push("ack"); redis.calls.evals.push(args); return [1, 1]; };
  const writer = createMutationWriter({
    redis,
    db,
    streamKey: "n:mutations",
    deadLetterKey: "n:dead",
    group: "writer",
    consumer: "control-1",
    applyMutation(_db, command) { db.state.applied.push(command.receiptId); return { stored: true }; },
  });

  await writer.start();
  assert.equal(await writer.runOnce({ blockMs: 1 }), 1);
  assert.deepEqual(order, ["commit", "ack"]);
  assert.deepEqual(db.state.applied, [mutation.receiptId]);
  assert.equal(db.state.inserted.length, 1);
  assert.equal(redis.calls.evals.length, 1);
  assert.equal(writer.status().committed, 1);
  await writer.stop();
});

test("writer publishes committed dbVersion channel after config mutation commit", async () => {
  const redis = fakeRedis([message()]);
  const db = fakeDb();
  const order = [];
  db.transaction = (fn) => { const value = fn(); order.push("commit"); return value; };
  redis.publish = async (...args) => { order.push("publish"); redis.calls.publishes.push(args); return 1; };
  redis.eval = async (...args) => { order.push("ack"); redis.calls.evals.push(args); return [1, 1]; };
  const writer = createMutationWriter({
    redis,
    db,
    namespace: "install-a",
    applyMutation() { return { updated: true, version: 7 }; },
  });
  await writer.start();
  await writer.runOnce({ blockMs: 1 });
  assert.deepEqual(order, ["commit", "publish", "ack"]);
  assert.deepEqual(redis.calls.publishes, [["install-a:db-version", "7"]]);
});

test("publish failure after commit leaves stream entry pending and replays via recovery", async () => {
  const redis = fakeRedis([message()]);
  const db = fakeDb();
  let committed = false;
  db.get = (sql) => sql.includes("sqliteMutationReceipts") && committed
    ? { result: JSON.stringify({ updated: true, version: 8 }), appliedAt: "2026-09-25T00:00:01.000Z" }
    : null;
  db.transaction = (fn) => { const value = fn(); committed = true; return value; };
  let publishes = 0;
  redis.publish = async () => {
    publishes++;
    if (publishes === 1) throw new Error("Redis disconnected");
    return 1;
  };
  // The failed entry stays unacknowledged and surfaces only when reclaimed.
  redis.xAutoClaim = async () => {
    redis.calls.claims.push(true);
    return { nextId: "0-0", messages: [message()] };
  };
  const writer = createMutationWriter({
    redis,
    db,
    namespace: "install-b",
    applyMutation() { return { updated: true, version: 8 }; },
  });
  await writer.start();
  await assert.rejects(writer.runOnce({ blockMs: 1 }), /Redis disconnected/);
  assert.equal(redis.calls.evals.length, 0);
  assert.equal(publishes, 1);
  await writer.recoverPending();
  assert.equal(publishes, 2);
  assert.equal(redis.calls.evals.length, 1);
  assert.equal(writer.status().duplicates, 1);
});

test("duplicate durable receipt is a successful no-op then acknowledged", async () => {
  const prior = { result: JSON.stringify({ stored: true }), appliedAt: "2026-09-25T00:00:01.000Z" };
  const redis = fakeRedis([message()]);
  const db = fakeDb(prior);
  let applied = 0;
  const writer = createMutationWriter({ redis, db, applyMutation() { applied++; } });

  await writer.start();
  await writer.runOnce({ blockMs: 1 });
  assert.equal(applied, 0);
  assert.equal(db.state.inserted.length, 0);
  assert.equal(redis.calls.evals.length, 1);
  assert.equal(writer.status().duplicates, 1);
});

test("invalid command moves to dead letter and is acknowledged", async () => {
  const redis = fakeRedis([message({ ...mutation, type: "sql.run" })]);
  const writer = createMutationWriter({ redis, db: fakeDb(), applyMutation() { throw new Error("must not run"); } });

  await writer.start();
  await writer.runOnce({ blockMs: 1 });
  assert.equal(redis.calls.adds.length, 1);
  assert.equal(redis.calls.evals.length, 1);
  assert.equal(writer.status().deadLettered, 1);
  assert.equal(JSON.stringify(redis.calls.adds[0]).includes("sql.run"), false);
});

test("exhausted SQLite busy retry is durably dead-lettered before source acknowledgement", async () => {
  const redis = fakeRedis([message()]);
  let attempts = 0;
  const writer = createMutationWriter({
    redis,
    db: fakeDb(),
    maxBusyRetries: 1,
    retryDelayMs: 0,
    applyMutation() {
      attempts++;
      const error = new Error("database is busy");
      error.code = "SQLITE_BUSY";
      throw error;
    },
  });

  await writer.start();
  await writer.runOnce({ blockMs: 1 });
  assert.equal(attempts, 2);
  assert.equal(redis.calls.adds.length, 1);
  assert.equal(redis.calls.evals.length, 1);
  assert.match(redis.calls.adds[0][2].command, /m-1234567890abcdef/);
});

test("pending messages are reclaimed after startup", async () => {
  const redis = fakeRedis();
  redis.xAutoClaim = async (...args) => {
    redis.calls.claims.push(args);
    return { nextId: "0-0", messages: [message()] };
  };
  const writer = createMutationWriter({ redis, db: fakeDb(), applyMutation() { return { stored: true }; } });
  await writer.start();
  assert.equal(await writer.recoverPending(), 1);
  assert.equal(redis.calls.claims.length, 1);
  assert.equal(redis.calls.evals.length, 1);
});

test("pending recovery drains every claim batch", async () => {
  const redis = fakeRedis();
  const claimed = [
    { nextId: "2-0", messages: [message(mutation, "1-0")] },
    { nextId: "0-0", messages: [message({ ...mutation, receiptId: "m-abcdef1234567890" }, "2-0")] },
  ];
  redis.xAutoClaim = async (...args) => {
    redis.calls.claims.push(args);
    return claimed.shift();
  };
  const db = fakeDb();
  const writer = createMutationWriter({ redis, db, applyMutation() { return { stored: true }; } });

  await writer.start();
  assert.equal(await writer.recoverPending(), 2);
  assert.equal(redis.calls.claims.length, 2);
  assert.equal(redis.calls.evals.length, 2);
});

test("sync mutation receives bounded receipt result only after commit", async () => {
  const sync = { ...mutation, consistency: "sync" };
  const redis = fakeRedis([message(sync)]);
  const writer = createMutationWriter({ redis, db: fakeDb(), applyMutation() { return { stored: true }; } });
  await writer.start();
  await writer.runOnce({ blockMs: 1 });
  // The receipt publish must be atomic: lPush then expire as two commands
  // leaves an orphaned receipt key without a TTL when the writer crashes in
  // between, and receipts accumulate forever. One EVAL does LPUSH + PEXPIRE.
  assert.equal(redis.calls.pushes.length, 0, "no separate lPush command");
  const receiptEval = redis.calls.evals.find((args) => String(args[0]).includes("LPUSH"));
  assert.ok(receiptEval, "receipt published via atomic LPUSH+PEXPIRE script");
  const [script, { keys, arguments: argv }] = receiptEval;
  assert.match(String(keys[0]), /m-1234567890abcdef/);
  assert.equal(JSON.parse(argv[0]).ok, true);
  assert.match(argv[1], /^60000$/, "PEXPIRE 60s in milliseconds");
});

test("SQLite transient classification is narrow", () => {
  assert.equal(isTransientSqliteError({ code: "SQLITE_BUSY" }), true);
  assert.equal(isTransientSqliteError({ code: "SQLITE_LOCKED" }), true);
  assert.equal(isTransientSqliteError({ code: "SQLITE_FULL" }), false);
  assert.equal(isTransientSqliteError(new Error("disk I/O error")), false);
});

test("stop waits for the active consumer loop to finish", async () => {
  let releaseRead;
  const redis = fakeRedis();
  redis.xReadGroup = () => new Promise((resolve) => { releaseRead = resolve; });
  const writer = createMutationWriter({ redis, db: fakeDb(), applyMutation() {} });

  const running = writer.run();
  await new Promise((resolve) => setImmediate(resolve));
  let stopped = false;
  const stopping = writer.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  releaseRead(null);
  await stopping;
  await running;
  assert.equal(writer.status().running, false);
});
