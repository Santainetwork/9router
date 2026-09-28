import { buildMutation, validateMutation, MutationValidationError } from "./mutationProtocol.js";
import { redisNamespace } from "../redis/client.js";

const DEFAULT_MAX_QUEUED = 10_000;
const DEFAULT_SYNC_TIMEOUT_MS = 5_000;
const MAX_SYNC_TIMEOUT_MS = 60_000;
const NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;

const BOUNDED_XADD = `
local length = redis.call('XLEN', KEYS[1])
if length >= tonumber(ARGV[1]) then
  return -1
end
return redis.call('XADD', KEYS[1], '*', 'command', ARGV[2])
`;

export class MutationQueueError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "MutationQueueError";
    this.code = code;
  }
}

function queueError(code, message) {
  return new MutationQueueError(message, code);
}

function assertOptions({ redis, namespace, maxQueued, syncTimeoutMs }) {
  if (!redis || typeof redis.command !== "function" || typeof redis.blocking !== "function") {
    throw new TypeError("redis manager with command and blocking clients is required");
  }
  if (!NAMESPACE_PATTERN.test(namespace)) throw new TypeError("safe Redis namespace is required");
  if (!Number.isSafeInteger(maxQueued) || maxQueued < 1) throw new TypeError("maxQueued must be a positive safe integer");
  if (!Number.isInteger(syncTimeoutMs) || syncTimeoutMs < 1 || syncTimeoutMs > MAX_SYNC_TIMEOUT_MS) {
    throw new TypeError(`syncTimeoutMs must be an integer from 1 to ${MAX_SYNC_TIMEOUT_MS}`);
  }
}

function receiptResult(reply, receiptId) {
  if (!reply) throw queueError("MUTATION_SYNC_TIMEOUT", "mutation receipt timed out");
  let receipt;
  try {
    receipt = JSON.parse(reply.element);
  } catch {
    throw queueError("MUTATION_RECEIPT_INVALID", "mutation receipt was invalid");
  }
  if (!receipt || receipt.ok !== true || receipt.receiptId !== receiptId) {
    throw queueError("MUTATION_RECEIPT_INVALID", "mutation receipt was invalid");
  }
  return receipt.result ?? null;
}

export function createMutationQueue({
  redis,
  namespace = redisNamespace(),
  workerId = `worker-${process.pid}`,
  maxQueued = DEFAULT_MAX_QUEUED,
  syncTimeoutMs = DEFAULT_SYNC_TIMEOUT_MS,
} = {}) {
  assertOptions({ redis, namespace, maxQueued, syncTimeoutMs });

  const streamKey = `${namespace}:mutations`;
  const metrics = { enqueued: 0, telemetryDropped: 0, backpressure: 0, failures: 0 };

  function dropped(command) {
    metrics.telemetryDropped++;
    return { enqueued: false, dropped: true, receiptId: command.receiptId };
  }

  async function enqueueMutation(input, { consistency } = {}) {
    let command;
    try {
      command = buildMutation({
        ...input,
        workerId: input?.workerId ?? workerId,
        consistency: consistency ?? input?.consistency,
      });
      validateMutation(command);
    } catch (error) {
      metrics.failures++;
      if (error instanceof MutationValidationError) throw error;
      throw queueError("MUTATION_INVALID", "mutation was invalid");
    }

    let messageId;
    try {
      const client = await redis.command();
      messageId = await client.eval(BOUNDED_XADD, {
        keys: [streamKey],
        arguments: [String(maxQueued), JSON.stringify(command)],
      });
    } catch {
      metrics.failures++;
      if (command.consistency === "async") return dropped(command);
      throw queueError("MUTATION_QUEUE_UNAVAILABLE", "mutation queue unavailable");
    }

    if (Number(messageId) === -1) {
      metrics.backpressure++;
      if (command.consistency === "async") return dropped(command);
      metrics.failures++;
      throw queueError("MUTATION_QUEUE_FULL", "mutation queue capacity exceeded");
    }
    if (typeof messageId !== "string" && !Buffer.isBuffer(messageId)) {
      metrics.failures++;
      if (command.consistency === "async") return dropped(command);
      throw queueError("MUTATION_QUEUE_UNAVAILABLE", "mutation queue unavailable");
    }

    metrics.enqueued++;
    if (command.consistency === "async") {
      return { enqueued: true, receiptId: command.receiptId, messageId: String(messageId) };
    }

    // A connection runs one blocking command at a time, so concurrent sync waiters
    // must not share one. Take a dedicated connection for this wait and always give
    // it back, otherwise a lost receipt stalls every other waiter past its timeout.
    let client;
    try {
      client = await (redis.dedicated ? redis.dedicated() : redis.blocking());
      const reply = await client.blPop(`${namespace}:receipt:${command.receiptId}`, syncTimeoutMs / 1000);
      return { enqueued: true, receiptId: command.receiptId, result: receiptResult(reply, command.receiptId) };
    } catch (error) {
      metrics.failures++;
      if (error instanceof MutationQueueError) throw error;
      throw queueError("MUTATION_QUEUE_UNAVAILABLE", "mutation receipt unavailable");
    } finally {
      if (client && typeof redis.release === "function") {
        try { await redis.release(client); } catch {}
      }
    }
  }

  return {
    enqueueMutation,
    status: () => ({ ...metrics }),
  };
}
