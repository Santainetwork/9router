// Task 5: synchronous provider-state mutations and provider worker eligibility.
import test from "node:test";
import assert from "node:assert/strict";

const { buildConnectionUpdatePayload, enqueueSyncConnectionUpdate } = await import("../../src/lib/db/workerMutation.js");
const { isProviderWorkerSafe, isTokenBearingUpdate } = await import("../../src/lib/db/providerEligibility.js");

test("isTokenBearingUpdate detects credential material", () => {
  assert.equal(isTokenBearingUpdate({ accessToken: "x" }), true);
  assert.equal(isTokenBearingUpdate({ refreshToken: "x" }), true);
  assert.equal(isTokenBearingUpdate({ idToken: "x" }), true);
  assert.equal(isTokenBearingUpdate({ apiKey: "x" }), true);
  assert.equal(isTokenBearingUpdate({ providerSpecificData: { copilotToken: "x" } }), true);
  assert.equal(isTokenBearingUpdate({ testStatus: "unavailable", lastError: "429" }), false);
  assert.equal(isTokenBearingUpdate({ modelLock_claude: "2026-01-01" }), false);
  assert.equal(isTokenBearingUpdate({ lastUsedAt: "now", consecutiveUseCount: 1 }), false);
});

test("unknown providers are control-only; explicit allowlist is worker-safe", () => {
  assert.equal(isProviderWorkerSafe("some-unknown-provider"), false);
  assert.equal(isProviderWorkerSafe("openai"), true);
  assert.equal(isProviderWorkerSafe("anthropic"), true);
  assert.equal(isProviderWorkerSafe("claude"), true);
});

test("buildConnectionUpdatePayload carries connectionId plus updates, no raw secrets", () => {
  const payload = buildConnectionUpdatePayload("conn-1", { testStatus: "active", lastError: null });
  assert.deepEqual(Object.keys(payload).sort(), ["connectionId", "updates"]);
  assert.equal(payload.connectionId, "conn-1");
  assert.equal(payload.updates.testStatus, "active");
  assert.equal(JSON.stringify(payload).includes("Bearer"), false);
});

test("enqueueSyncConnectionUpdate waits for the committed receipt and returns its result", async () => {
  const calls = [];
  const queue = {
    enqueueMutation: (input) => {
      calls.push(input);
      return Promise.resolve({ enqueued: true, receiptId: input.receiptId, result: { updated: true, version: 3 } });
    },
  };
  const result = await enqueueSyncConnectionUpdate(queue, "conn-1", { testStatus: "unavailable" });
  assert.equal(result.updated, true);
  assert.equal(result.version, 3);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, "connection.update");
  assert.equal(calls[0].consistency, "sync");
});

test("enqueueSyncConnectionUpdate fails closed on queue error, never falls back to direct write", async () => {
  const queue = {
    enqueueMutation: () => Promise.reject(Object.assign(new Error("down"), { code: "MUTATION_QUEUE_UNAVAILABLE" })),
  };
  await assert.rejects(
    enqueueSyncConnectionUpdate(queue, "conn-1", { testStatus: "unavailable" }),
    (e) => e.code === "MUTATION_QUEUE_UNAVAILABLE",
  );
});

test("token-bearing updates are encrypted: Redis command JSON excludes raw tokens", async () => {
  process.env.SQLITE_QUEUE_ENCRYPTION_KEY = "a".repeat(64);
  delete process.env.API_KEY_SECRET;
  delete process.env.REDIS_URL;
  const captured = [];
  const queue = {
    enqueueMutation: (input) => {
      captured.push(input);
      return Promise.resolve({ enqueued: true, receiptId: input.receiptId, result: { updated: true, version: 1 } });
    },
  };
  await enqueueSyncConnectionUpdate(queue, "conn-1", {
    testStatus: "active",
    accessToken: "at-raw-secret",
    refreshToken: "rt-raw-secret",
    providerSpecificData: { copilotToken: "cp-raw-secret" },
  });

  const command = captured[0];
  assert.equal(command.type, "connection.update");
  assert.equal(command.payload.updates.testStatus, "active");
  assert.equal("accessToken" in command.payload.updates, false);
  assert.equal("refreshToken" in command.payload.updates, false);
  assert.equal("providerSpecificData" in command.payload.updates, false);
  assert.ok(command.payload.ciphertext, "credential fields are encrypted");
  const json = JSON.stringify(command);
  assert.equal(json.includes("at-raw-secret"), false);
  assert.equal(json.includes("rt-raw-secret"), false);
  assert.equal(json.includes("cp-raw-secret"), false);
  delete process.env.SQLITE_QUEUE_ENCRYPTION_KEY;
});

test("plaintext secret fields are still rejected by the protocol scan even with ciphertext present", async () => {
  const { buildMutation } = await import("../../src/lib/db/mutationProtocol.js");
  assert.throws(
    () => buildMutation({
      type: "connection.update",
      workerId: "w",
      payload: { connectionId: "conn-1", updates: { accessToken: "at-raw" } },
    }),
    /sensitive/i,
  );
});
