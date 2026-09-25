// Task 3 protocol contract: versioned allowlisted command union, stable receipt
// IDs, byte caps, strict JSON shape, secret rejection. Pure module: no Redis, no
// SQLite, no repo writes.
import test from "node:test";
import assert from "node:assert/strict";

import {
  MUTATION_PROTOCOL_VERSION,
  MUTATION_TYPES,
  MAX_MUTATION_BYTES,
  RECEIPT_ID_PATTERN,
  MAX_RECEIPT_AGE_MS,
  DEFAULT_RECEIPT_RETENTION,
  MutationValidationError,
  newReceiptId,
  isReceiptId,
  buildMutation,
  validateMutation,
  isReceiptExpired,
  selectReceiptsToPrune,
} from "../../src/lib/db/mutationProtocol.js";

const WORKER = "worker-abc";

const valid = {
  "usage.save": {
    timestamp: "2026-09-25T00:00:00.000Z",
    provider: "antigravity",
    model: "ag/gemini-3.7-flash",
    connectionId: "conn-1",
    apiKeyId: "8f2b1c4e-9a7d-4f3b-8c21-0d5e6f7a8b9c",
    endpoint: "/v1/chat/completions",
    promptTokens: 10,
    completionTokens: 5,
    cost: 0.001,
    status: "ok",
    tokens: { prompt_tokens: 10, completion_tokens: 5 },
    requestedModel: "gemini-3.7-flash",
    upstreamModel: "ag/gemini-3.7-flash",
  },
  "requestDetail.save": {
    id: "1758765600000-00000001-gemini-3-7-flash",
    provider: "antigravity",
    model: "ag/gemini-3.7-flash",
    connectionId: "conn-1",
    timestamp: "2026-09-25T00:00:00.000Z",
    status: "ok",
    latency: { total: 1200 },
    tokens: { prompt_tokens: 10 },
    pxpipe: { applied: true, imageCount: 1 },
    bytesIn: 1024,
    bytesOut: 2048,
    truncated: false,
  },
  "footerLog.add": {
    timestamp: "2026-09-25T00:00:00.000Z",
    provider: "antigravity",
    model: "ag/gemini-3.7-flash",
    referralText: "This response was delivered by Antigravity",
  },
};

function cmd(type, payload = valid[type]) {
  return buildMutation({ type, payload, workerId: WORKER });
}

function expectReject(mutation, pattern, message) {
  assert.throws(
    () => validateMutation(mutation),
    (err) => {
      assert.ok(err instanceof MutationValidationError, `expected MutationValidationError, got ${err?.name}: ${err?.message}`);
      assert.match(err.message, pattern);
      return true;
    },
    message,
  );
}

test("command union is exactly the three allowlisted types", () => {
  assert.deepEqual([...MUTATION_TYPES].sort(), ["footerLog.add", "requestDetail.save", "usage.save"]);
  assert.ok(Object.isFrozen(MUTATION_TYPES) || Array.isArray(MUTATION_TYPES));
});

test("protocol version is a positive integer and carried on every command", () => {
  assert.ok(Number.isInteger(MUTATION_PROTOCOL_VERSION) && MUTATION_PROTOCOL_VERSION >= 1);
  const m = cmd("usage.save");
  assert.equal(m.schemaVersion, MUTATION_PROTOCOL_VERSION);
});

test("payload byte cap default is 64 KiB", () => {
  assert.equal(MAX_MUTATION_BYTES, 64 * 1024);
});

test("buildMutation produces a stable, well-formed receipt envelope", () => {
  const a = cmd("usage.save");
  assert.match(a.receiptId, RECEIPT_ID_PATTERN);
  assert.equal(a.type, "usage.save");
  assert.equal(a.workerId, WORKER);
  assert.ok(!Number.isNaN(Date.parse(a.createdAt)));
  assert.equal(typeof a.payload, "object");
  assert.equal(a.consistency, "async");
  // Round-trips through JSON unchanged (transport is Redis Streams fields).
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a);
});

test("explicit receiptId is preserved for same-ID retry", () => {
  const receiptId = newReceiptId();
  const m = buildMutation({ type: "usage.save", payload: valid["usage.save"], workerId: WORKER, receiptId });
  assert.equal(m.receiptId, receiptId);
  const retry = buildMutation({ type: "usage.save", payload: valid["usage.save"], workerId: WORKER, receiptId });
  assert.equal(retry.receiptId, receiptId);
});

test("receipt IDs are unique and pass the shape check", () => {
  const ids = new Set(Array.from({ length: 500 }, () => newReceiptId()));
  assert.equal(ids.size, 500);
  for (const id of ids) assert.ok(isReceiptId(id), id);
  assert.ok(!isReceiptId("short"));
  assert.ok(!isReceiptId("has spaces and is long enough to look real"));
  assert.ok(!isReceiptId(`${"a".repeat(60)}!`));
});

test("each allowlisted type accepts its real repository payload", () => {
  for (const type of MUTATION_TYPES) {
    assert.doesNotThrow(() => validateMutation(cmd(type)), type);
  }
});

test("unknown type and arbitrary SQL are rejected", () => {
  expectReject({ ...cmd("usage.save"), type: "usage.delete" }, /unknown mutation type/i);
  expectReject({ ...cmd("usage.save"), type: "DELETE FROM usageHistory" }, /unknown mutation type/i);
  expectReject({ ...cmd("usage.save"), type: "eval" }, /unknown mutation type/i);
  expectReject({ ...cmd("usage.save"), type: "" }, /unknown mutation type/i);
  expectReject({ ...cmd("usage.save"), type: 42 }, /unknown mutation type/i);
});

test("no dynamic repo or function names are accepted", () => {
  expectReject({ ...cmd("usage.save"), handler: "dropTable" }, /unexpected field/i);
  expectReject({ ...cmd("usage.save"), fn: "db.exec" }, /unexpected field/i);
  expectReject({ ...cmd("usage.save"), repo: "connectionsRepo" }, /unexpected field/i);
  expectReject({ ...cmd("usage.save"), sql: "SELECT 1" }, /unexpected field/i);
});

test("schema version mismatch is rejected", () => {
  expectReject({ ...cmd("usage.save"), schemaVersion: MUTATION_PROTOCOL_VERSION + 1 }, /schema version/i);
  expectReject({ ...cmd("usage.save"), schemaVersion: "1" }, /schema version/i);
  expectReject({ ...cmd("usage.save"), schemaVersion: undefined }, /schema version/i);
});

test("envelope shape is strict", () => {
  expectReject(null, /object/i);
  expectReject([], /object/i);
  expectReject({ ...cmd("usage.save"), receiptId: "nope" }, /receipt/i);
  expectReject({ ...cmd("usage.save"), receiptId: undefined }, /receipt/i);
  expectReject({ ...cmd("usage.save"), workerId: "" }, /worker/i);
  expectReject({ ...cmd("usage.save"), workerId: undefined }, /worker/i);
  expectReject({ ...cmd("usage.save"), createdAt: "not-a-date" }, /createdAt|timestamp/i);
  expectReject({ ...cmd("usage.save"), consistency: "eventual" }, /consistency/i);
  expectReject({ ...cmd("usage.save"), payload: "{}" }, /payload/i);
  expectReject({ ...cmd("usage.save"), payload: null }, /payload/i);
});

test("payload byte cap is enforced before enqueue", () => {
  const big = { ...valid["usage.save"], model: "m".repeat(MAX_MUTATION_BYTES) };
  assert.throws(
    () => buildMutation({ type: "usage.save", payload: big, workerId: WORKER }),
    (err) => err instanceof MutationValidationError && /too large|exceeds/i.test(err.message),
  );
});

test("payload must stay strict JSON", () => {
  const circular = { ...valid["usage.save"] };
  circular.self = circular;
  assert.throws(() => buildMutation({ type: "usage.save", payload: circular, workerId: WORKER }), MutationValidationError);
  expectReject({ ...cmd("usage.save"), payload: { ...valid["usage.save"], fn: () => {} } }, /non-json|function/i);
  expectReject({ ...cmd("usage.save"), payload: { ...valid["usage.save"], at: new Date() } }, /non-json|date/i);
  expectReject({ ...cmd("usage.save"), payload: { ...valid["usage.save"], big: 10n } }, /non-json|bigint/i);
});

test("per-type payload shape is enforced", () => {
  // usage.save requires the fields the aggregate transaction needs.
  const missingTokens = { ...valid["usage.save"] };
  delete missingTokens.timestamp;
  expectReject({ ...cmd("usage.save"), payload: missingTokens }, /timestamp/);

  expectReject({ ...cmd("footerLog.add"), payload: { provider: "x", model: "y" } }, /referralText/);
  expectReject({ ...cmd("requestDetail.save"), payload: { provider: "x" } }, /id|model/i);
});

test("nested secrets, headers, cookies and raw bodies are rejected", () => {
  const usage = valid["usage.save"];
  const rd = valid["requestDetail.save"];

  expectReject({ ...cmd("usage.save"), payload: { ...usage, authorization: "Bearer abcdefghijklmnopqrstuvwxyz012345" } }, /sensitive/i);
  expectReject({ ...cmd("usage.save"), payload: { ...usage, apiKeySecret: "x" } }, /sensitive/i);
  expectReject({ ...cmd("usage.save"), payload: { ...usage, cookie: "session=1" } }, /sensitive/i);
  expectReject({ ...cmd("usage.save"), payload: { ...usage, rawBody: "{}" } }, /sensitive/i);
  expectReject({ ...cmd("usage.save"), payload: { ...usage, nested: { Authorization: "Bearer x" } } }, /sensitive/i);
  expectReject({ ...cmd("usage.save"), payload: { ...usage, nested: { deep: { "x-api-key": "k" } } } }, /sensitive/i);
  expectReject({ ...cmd("usage.save"), payload: { ...usage, nested: [ { cookie: "a=b" } ] } }, /sensitive/i);
  expectReject({ ...cmd("usage.save"), payload: { ...usage, apiKey: "raw-secret-key" } }, /sensitive/i);
  expectReject({ ...cmd("usage.save"), payload: { ...usage, headers: { "content-type": "application/json" } } }, /sensitive/i);
  expectReject({ ...cmd("requestDetail.save"), payload: { ...rd, request: { model: "x" } } }, /sensitive/i);
  expectReject({ ...cmd("requestDetail.save"), payload: { ...rd, providerRequest: { body: "x" } } }, /sensitive/i);
  expectReject({ ...cmd("requestDetail.save"), payload: { ...rd, providerResponse: { body: "x" } } }, /sensitive/i);
  expectReject({ ...cmd("requestDetail.save"), payload: { ...rd, response: { rawBody: "..." } } }, /sensitive/i);
  expectReject({ ...cmd("requestDetail.save"), payload: { ...rd, headers: { authorization: "Bearer x" } } }, /sensitive/i);
  expectReject({ ...cmd("footerLog.add"), payload: { ...valid["footerLog.add"], rawBody: "x" } }, /sensitive/i);

  // Long opaque secrets are rejected by value shape even without a telltale key.
  expectReject({ ...cmd("usage.save"), payload: { ...usage, note: "sk-abcdefghijklmnopqrstuvwxyz0123456789" } }, /sensitive|secret/i);
  expectReject({ ...cmd("usage.save"), payload: { ...usage, note: "Bearer abcdefghijklmnopqrstuvwxyz012345" } }, /sensitive|secret/i);
});

test("legitimate non-secret payloads still pass", () => {
  assert.doesNotThrow(() => validateMutation(cmd("usage.save")));
  assert.doesNotThrow(() => validateMutation(cmd("requestDetail.save")));
  assert.doesNotThrow(() => validateMutation(cmd("footerLog.add")));
  // No generic "key"/"token" substring ban: token counters and the opaque
  // API-key row id are required by the aggregate transaction.
  assert.doesNotThrow(() => validateMutation({ ...cmd("usage.save"), payload: { ...valid["usage.save"], apiKeyId: "apikey-row-1" } }));
  assert.doesNotThrow(() => validateMutation({ ...cmd("usage.save"), payload: { ...valid["usage.save"], tokens: { prompt_tokens: 10, cached_tokens: 2 } } }));
  assert.doesNotThrow(() => validateMutation(cmd("requestDetail.save")));
  // usage rows stay attributable without the raw key.
  const unattributed = { ...valid["usage.save"] };
  delete unattributed.connectionId;
  delete unattributed.apiKeyId;
  assert.throws(
    () => validateMutation({ ...cmd("usage.save"), payload: unattributed }),
    (err) => err instanceof MutationValidationError && /apiKeyId or connectionId/.test(err.message),
  );
});

test("consistency flag defaults to async and allows sync", () => {
  assert.equal(cmd("usage.save").consistency, "async");
  const sync = buildMutation({ type: "usage.save", payload: valid["usage.save"], workerId: WORKER, consistency: "sync" });
  assert.equal(sync.consistency, "sync");
  assert.doesNotThrow(() => validateMutation(sync));
});

test("receipt retention rules: no blanket expiry, bounded pruning of old rows", () => {
  assert.ok(Number.isInteger(MAX_RECEIPT_AGE_MS) && MAX_RECEIPT_AGE_MS >= 24 * 60 * 60 * 1000);
  assert.ok(Number.isInteger(DEFAULT_RECEIPT_RETENTION) && DEFAULT_RECEIPT_RETENTION >= 1000);

  const now = Date.parse("2026-09-25T00:00:00.000Z");
  const fresh = cmd("usage.save");
  // A duplicate delivered inside the retention window must stay a no-op, never "expired".
  assert.equal(isReceiptExpired({ createdAt: new Date(now - 1000).toISOString() }, { now }), false);
  assert.equal(isReceiptExpired({ createdAt: new Date(now - MAX_RECEIPT_AGE_MS + 1000).toISOString() }, { now }), false);
  assert.equal(isReceiptExpired({ createdAt: new Date(now - MAX_RECEIPT_AGE_MS - 1).toISOString() }, { now }), true);
  assert.equal(isReceiptExpired({ createdAt: "garbage" }, { now }), false);

  const rows = Array.from({ length: 10 }, (_, i) => ({ receiptId: `r${i}`, appliedAt: new Date(now - i * 1000).toISOString() }));
  const pruned = selectReceiptsToPrune(rows, { now, retention: 5 });
  assert.deepEqual(pruned.map((r) => r.receiptId), ["r5", "r6", "r7", "r8", "r9"]);
  // Recent rows are never pruned just because they are old-ish.
  assert.equal(selectReceiptsToPrune(rows.slice(0, 3), { now, retention: 5 }).length, 0);
  // fresh stays valid JSON-serializable
  assert.doesNotThrow(() => JSON.stringify(fresh));
});
