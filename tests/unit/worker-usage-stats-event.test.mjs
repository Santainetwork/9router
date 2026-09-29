// Review P5: the worker (SQLite Redis multicore) usage path must fire the same
// stats "update" event the direct-write path fires, otherwise the usage
// dashboard/stream never refreshes for worker-committed requests.
import test from "node:test";
import assert from "node:assert/strict";

process.env.WORKER_ROLE = "api";
process.env.SQLITE_MULTICORE = "redis";

const queued = [];
const mutations = [];
global.__workerMutationState = {
  queue: {
    enqueueMutation: async (mutation) => {
      mutations.push(mutation);
      return queued.shift() ?? { enqueued: true, receiptId: "r1" };
    },
    status: () => ({}),
  },
};

const { saveRequestUsage, statsEmitter } = await import("../../src/lib/db/repos/usageRepo.js");
const { isSqliteMulticoreWorker } = await import("../../src/lib/db/driver.js");

function nextEvent(event, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { statsEmitter.off(event, onEvent); resolve(false); }, timeoutMs);
    function onEvent() {
      clearTimeout(timer);
      statsEmitter.off(event, onEvent);
      resolve(true);
    }
    statsEmitter.on(event, onEvent);
  });
}

test("worker usage mutation loads configured provider prefix before persisting model", async () => {
  const provider = "openai-compatible-chat-123";
  global._dbAdapter.instance = {
    get: () => ({ version: 1 }),
    all: () => [{ id: provider, data: JSON.stringify({ prefix: "myr" }) }],
  };

  await saveRequestUsage({ provider, model: "deepseek-v4-flash" });

  assert.equal(mutations.at(-1).payload.model, "myr/deepseek-v4-flash");
});

test("worker usage mutation path fires the same stats update event as the direct path", async () => {
  assert.equal(isSqliteMulticoreWorker(), true, "test must exercise the worker branch");

  const wait = nextEvent("update");
  const result = await saveRequestUsage({
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    connectionId: "conn-1",
    endpoint: "/v1/messages",
    status: "ok",
  });

  assert.equal(result.enqueued, true);
  assert.equal(await wait, true, "usage update event must fire so dashboards refresh");
});

test("dropped worker telemetry does not fire a stats update", async () => {
  queued.push({ enqueued: false, dropped: true, receiptId: "r2" });
  const wait = nextEvent("update", 600);
  const result = await saveRequestUsage({
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    connectionId: "conn-1",
  });
  assert.equal(result.dropped, true);
  assert.equal(await wait, false);
});
