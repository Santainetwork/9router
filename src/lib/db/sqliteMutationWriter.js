import { validateMutation, MutationValidationError } from "./mutationProtocol.js";

const DEFAULT_STREAM_KEY = "9router:sqlite:mutations";
const DEFAULT_DEAD_LETTER_KEY = "9router:sqlite:mutations:dead";
const DEFAULT_GROUP = "sqlite-writer";
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_CLAIM_IDLE_MS = 30_000;
const DEFAULT_HEARTBEAT_TTL_MS = 15_000;
const RECEIPT_TTL_SECONDS = 60;

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function receiptKey(namespace, receiptId) {
  return `${namespace}:receipt:${receiptId}`;
}

export function isTransientSqliteError(error) {
  return error?.code === "SQLITE_BUSY" || error?.code === "SQLITE_LOCKED";
}

function isBusyGroup(error) {
  return String(error?.message || "").includes("BUSYGROUP");
}

function parseCommand(entry) {
  const raw = entry?.message?.command;
  if (typeof raw !== "string") {
    throw new MutationValidationError("stream entry has no command", "MUTATION_ENVELOPE_INVALID");
  }
  let command;
  try {
    command = JSON.parse(raw);
  } catch {
    throw new MutationValidationError("stream command is not JSON", "MUTATION_NOT_JSON");
  }
  validateMutation(command);
  return command;
}

export function createMutationWriter({
  redis,
  db,
  applyMutation,
  namespace = "9router:sqlite",
  streamKey,
  deadLetterKey,
  group = DEFAULT_GROUP,
  consumer = `control-${process.pid}`,
  batchSize = DEFAULT_BATCH_SIZE,
  claimIdleMs = DEFAULT_CLAIM_IDLE_MS,
  heartbeatTtlMs = DEFAULT_HEARTBEAT_TTL_MS,
  maxBusyRetries = 3,
  retryDelayMs = 25,
  now = () => new Date().toISOString(),
} = {}) {
  if (!redis || !db || typeof applyMutation !== "function") {
    throw new TypeError("redis, db and applyMutation are required");
  }

  let running = false;
  let stopping = false;
  let runPromise = null;
  streamKey ||= namespace === "9router:sqlite" ? DEFAULT_STREAM_KEY : `${namespace}:mutations`;
  deadLetterKey ||= namespace === "9router:sqlite" ? DEFAULT_DEAD_LETTER_KEY : `${namespace}:mutations:dead`;
  const metrics = {
    committed: 0,
    duplicates: 0,
    retries: 0,
    deadLettered: 0,
    failures: 0,
    lastCommittedAt: null,
  };

  async function publishReceipt(command, result) {
    if (command.consistency !== "sync") return;
    const key = receiptKey(namespace, command.receiptId);
    await redis.lPush(key, JSON.stringify({ ok: true, receiptId: command.receiptId, result }));
    await redis.expire(key, RECEIPT_TTL_SECONDS);
  }

  async function heartbeat() {
    await redis.set(`${namespace}:writer:heartbeat`, now(), { PX: heartbeatTtlMs });
  }

  async function finishSource(messageId) {
    await redis.xAck(streamKey, group, messageId);
    // XLEN is the producer's hard backpressure bound. Remove committed/poison
    // entries after ACK so acknowledged history cannot permanently fill it.
    await redis.xDel?.(streamKey, messageId);
  }

  function applyInTransaction(command) {
    let duplicate = false;
    let result;
    db.transaction(() => {
      const prior = db.get(
        "SELECT result, appliedAt FROM sqliteMutationReceipts WHERE receiptId = ?",
        [command.receiptId],
      );
      if (prior) {
        duplicate = true;
        try { result = prior.result ? JSON.parse(prior.result) : null; } catch { result = null; }
        return;
      }

      result = applyMutation(db, command);
      db.run(
        "INSERT INTO sqliteMutationReceipts(receiptId, type, workerId, appliedAt, result) VALUES(?, ?, ?, ?, ?)",
        [command.receiptId, command.type, command.workerId, now(), JSON.stringify(result ?? null)],
      );
    });
    return { duplicate, result };
  }

  async function deadLetter(entry, error, command) {
    const failure = {
      messageId: String(entry?.id || "unknown"),
      code: String(error?.code || "MUTATION_FAILED").slice(0, 64),
      failedAt: now(),
    };
    // Only validated commands are retained for operator replay. Invalid stream
    // input may contain secrets or arbitrary fields, so it is never copied.
    if (command) failure.command = JSON.stringify(command);
    await redis.xAdd(deadLetterKey, "*", {
      failure: JSON.stringify(failure),
      ...(command ? { command: JSON.stringify(command) } : {}),
    });
    await finishSource(entry.id);
    metrics.deadLettered++;
  }

  async function processEntry(entry) {
    let command;
    try {
      command = parseCommand(entry);
    } catch (error) {
      await deadLetter(entry, error);
      return;
    }

    let attempt = 0;
    while (true) {
      try {
        const { duplicate, result } = applyInTransaction(command);
        await publishReceipt(command, result);
        await finishSource(entry.id);
        if (duplicate) metrics.duplicates++;
        else metrics.committed++;
        metrics.lastCommittedAt = now();
        await heartbeat();
        return;
      } catch (error) {
        if (isTransientSqliteError(error)) {
          if (attempt++ < maxBusyRetries) {
            metrics.retries++;
            await sleep(retryDelayMs * attempt);
            continue;
          }
          metrics.failures++;
          await deadLetter(entry, error, command);
          return;
        }
        metrics.failures++;
        // Runtime SQLite failures remain pending for operator recovery. ACKing
        // disk-full/corruption/I/O errors here would silently lose telemetry.
        throw error;
      }
    }
  }

  async function processMessages(streams) {
    let processed = 0;
    for (const stream of streams || []) {
      for (const entry of stream.messages || []) {
        await processEntry(entry);
        processed++;
      }
    }
    return processed;
  }

  async function start() {
    try {
      await redis.xGroupCreate(streamKey, group, "0", { MKSTREAM: true });
    } catch (error) {
      if (!isBusyGroup(error)) throw error;
    }
    stopping = false;
    await heartbeat();
  }

  async function runOnce({ blockMs = 1000 } = {}) {
    const streams = await redis.xReadGroup(
      group,
      consumer,
      [{ key: streamKey, id: ">" }],
      { COUNT: batchSize, BLOCK: blockMs },
    );
    if (!streams) await heartbeat();
    return processMessages(streams);
  }

  async function recoverPending() {
    let cursor = "0-0";
    let processed = 0;
    do {
      const claimed = await redis.xAutoClaim(
        streamKey,
        group,
        consumer,
        claimIdleMs,
        cursor,
        { COUNT: batchSize },
      );
      processed += await processMessages(claimed?.messages?.length
        ? [{ name: streamKey, messages: claimed.messages }]
        : []);
      cursor = claimed?.nextId ?? "0-0";
    } while (cursor !== "0-0");
    return processed;
  }

  async function consume() {
    if (running) return;
    running = true;
    stopping = false;
    await start();
    await recoverPending();
    while (!stopping) {
      try {
        await runOnce();
      } catch (error) {
        if (stopping) break;
        metrics.failures++;
        await sleep(100);
      }
    }
    running = false;
  }

  function run() {
    if (runPromise) return runPromise;
    runPromise = consume().finally(() => { runPromise = null; });
    return runPromise;
  }

  async function stop() {
    stopping = true;
    await runPromise;
  }

  return {
    start,
    run,
    runOnce,
    recoverPending,
    stop,
    heartbeat,
    status: () => ({ ...metrics, running, stopping }),
  };
}
