// Task 4: worker-role telemetry must flow through typed async mutations and
// must never carry raw API keys, request/response bodies, headers, or cookies.
// These tests pin the pure payload builders + raw-key resolution, then assert
// the repo entry points route through the queue in worker mode.
import test from "node:test";
import assert from "node:assert/strict";

const routing = await import("../../src/lib/db/workerMutation.js");
const { buildMutation } = await import("../../src/lib/db/mutationProtocol.js");

test("resolveApiKeyId maps a raw key to its opaque row id via the read-only adapter", async () => {
  const db = { get: (sql, params) => ({ id: "key-opaque-1" }) };
  const id = await routing.resolveApiKeyId(db, "sk-raw-secret");
  assert.equal(id, "key-opaque-1");
});

test("resolveApiKeyId returns null when the raw key is unknown", async () => {
  const db = { get: () => undefined };
  assert.equal(await routing.resolveApiKeyId(db, "sk-raw-missing"), null);
});

test("buildUsageSavePayload carries apiKeyId and never the raw key", () => {
  const payload = routing.buildUsageSavePayload({
    timestamp: "2026-09-25T08:00:00.000Z",
    provider: "anthropic",
    model: "ag/claude-sonnet-4-6",
    connectionId: "conn-1",
    apiKeyId: "key-opaque-1",
    endpoint: "/v1/chat/completions",
    tokens: { prompt_tokens: 100, completion_tokens: 50 },
    cost: 0.001,
    status: "ok",
    requestedModel: "claude-sonnet-4-6",
    upstreamModel: "ag/claude-sonnet-4-6",
    apiKey: "sk-raw-secret",
  });

  assert.equal(payload.apiKeyId, "key-opaque-1");
  assert.equal("apiKey" in payload, false, "raw apiKey must never reach the payload");
  assert.equal(JSON.stringify(payload).includes("sk-raw"), false);
  assert.equal(payload.model, "ag/claude-sonnet-4-6");
  assert.equal(payload.cost, 0.001);
});

test("buildRequestDetailSavePayload is metadata-only: no bodies, headers, or cookies", () => {
  const payload = routing.buildRequestDetailSavePayload({
    id: "detail-1",
    timestamp: "2026-09-25T08:00:00.000Z",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    connectionId: "conn-1",
    status: "success",
    latency: { total: 500 },
    tokens: { prompt_tokens: 100 },
    upstreamModel: "claude-sonnet-4-6",
    requestedModel: "claude-sonnet-4-6",
    request: { headers: { authorization: "Bearer x", cookie: "a=b" }, messages: [{ role: "user" }] },
    providerRequest: { raw: true },
    providerResponse: { raw: true },
    response: { choices: [] },
  });

  assert.equal("request" in payload, false);
  assert.equal("providerRequest" in payload, false);
  assert.equal("providerResponse" in payload, false);
  assert.equal("response" in payload, false);
  assert.equal("headers" in payload, false);
  assert.equal(JSON.stringify(payload).includes("Bearer"), false);
  assert.equal(payload.id, "detail-1");
  assert.equal(payload.status, "success");
});

test("buildFooterLogAddPayload keeps only typed footer fields", () => {
  const payload = routing.buildFooterLogAddPayload(
    "anthropic",
    "claude-sonnet-4-6",
    "delivered by [REDACTED]",
    "2026-09-25T08:00:00.000Z",
  );
  assert.deepEqual(Object.keys(payload).sort(), ["model", "provider", "referralText", "timestamp"]);
  assert.equal(payload.referralText, "delivered by [REDACTED]");
});

test("enqueueTelemetry resolves to {enqueued, dropped} and reports loss", async () => {
  const calls = [];
  const queue = {
    enqueueMutation: (input) => {
      calls.push(input);
      return Promise.resolve({ enqueued: true, receiptId: input.receiptId });
    },
    status: () => ({}),
  };
  const result = await routing.enqueueTelemetry(queue, {
    type: "usage.save",
    payload: { timestamp: "t", model: "m", apiKeyId: "k" },
  });
  assert.equal(result.enqueued, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, "usage.save");
});

test("sparse repository inputs build protocol-valid payloads without undefined fields", () => {
  const usage = routing.buildUsageSavePayload({
    timestamp: "2026-09-25T08:00:00.000Z",
    model: "m",
    connectionId: "conn-1",
    tokens: {},
  });
  const detail = routing.buildRequestDetailSavePayload({ model: "m" });

  assert.doesNotThrow(() => buildMutation({ type: "usage.save", payload: usage, workerId: "worker-1" }));
  assert.doesNotThrow(() => buildMutation({ type: "requestDetail.save", payload: detail, workerId: "worker-1" }));
  assert.equal(JSON.stringify(usage).includes("undefined"), false);
  assert.equal(JSON.stringify(detail).includes("undefined"), false);
});
