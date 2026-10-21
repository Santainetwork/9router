// CodeBuddy Intl channel-verification gate (decolua/9router#5005).
//
// Since 2026-10-15 the intl gateway refuses any chat request missing the
// X-Conversation-* header family with 400 / code 11128, regardless of
// credentials. All three headers are required. These tests lock the executor's
// header contract so the gate cannot silently return.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CodeBuddyIntlExecutor } from "../../open-sse/executors/codebuddy-intl.js";

const creds = { apiKey: "test-key", connectionId: "conn-1" };
const body = { model: "glm-5.2", messages: [{ role: "user", content: "hi" }] };
const build = (c = creds, b = body) => new CodeBuddyIntlExecutor().buildHeaders(c, true, "url", "glm-5.2", b);

const FAMILY = ["X-Conversation-ID", "X-Conversation-Request-ID", "X-Conversation-Message-ID"];

test("sends the full X-Conversation-* family", () => {
  const h = build();
  for (const name of FAMILY) assert.ok(h[name], `missing ${name}`);
  assert.ok(h["X-Request-ID"], "missing X-Request-ID");
});

test("without an explicit session id, each request gets a fresh conversation id", () => {
  // Two different conversations that happen to share the same prompt must not be
  // joined upstream (decolua/9router#5086).
  assert.notEqual(build()["X-Conversation-ID"], build()["X-Conversation-ID"]);
});

test("conversation id is stable for the same explicit session id", () => {
  const withSession = { ...body, session_id: "session-a" };
  assert.equal(build(creds, withSession)["X-Conversation-ID"], build(creds, withSession)["X-Conversation-ID"]);
});

test("per-request ids rotate between calls", () => {
  const a = build();
  const b = build();
  assert.notEqual(a["X-Conversation-Request-ID"], b["X-Conversation-Request-ID"]);
  assert.notEqual(a["X-Conversation-Message-ID"], b["X-Conversation-Message-ID"]);
});

test("conversation id is derived from the session seed when present", () => {
  const a = build(creds, { ...body, session_id: "session-a" });
  const b = build(creds, { ...body, session_id: "session-b" });
  assert.notEqual(a["X-Conversation-ID"], b["X-Conversation-ID"]);
  assert.equal(a["X-Conversation-ID"], build(creds, { ...body, session_id: "session-a" })["X-Conversation-ID"]);
});

test("a caller-supplied family member is honoured, not replaced", () => {
  const ex = new CodeBuddyIntlExecutor();
  // A provider override puts the family on the bag before buildHeaders runs.
  const withOverride = { ...creds, rawHeaders: { "x-conversation-id": "CALLER-ID", "x-conversation-request-id": "REQ-ID" } };
  const headers = ex.buildHeaders(withOverride, true, "url", "glm-5.2", body);
  // Case-insensitive: the caller's value wins, and no duplicate key is added.
  const convKeys = Object.keys(headers).filter((k) => k.toLowerCase() === "x-conversation-id");
  assert.equal(convKeys.length, 1);
  assert.equal(headers[convKeys[0]], "CALLER-ID");
  const reqKeys = Object.keys(headers).filter((k) => k.toLowerCase() === "x-conversation-request-id");
  assert.equal(reqKeys.length, 1);
  assert.equal(headers[reqKeys[0]], "REQ-ID");
});

test("X-Request-ID mirrors X-Conversation-Message-ID", () => {
  const h = build();
  assert.equal(h["X-Request-ID"], h["X-Conversation-Message-ID"]);
});

test("keeps the registry identity headers alongside the family", () => {
  const h = build();
  assert.equal(h["X-Product"], "SaaS");
  assert.match(h["User-Agent"], /CodeBuddy/);
});
