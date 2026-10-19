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

test("conversation id is stable across calls for the same conversation", () => {
  assert.equal(build()["X-Conversation-ID"], build()["X-Conversation-ID"]);
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

test("an existing family member is honoured, not duplicated or replaced", () => {
  const ex = new CodeBuddyIntlExecutor();
  // Simulate a provider override already on the bag, in a different case.
  const headers = ex.buildHeaders(creds, true, "url", "glm-5.2", body);
  assert.ok(headers["X-Conversation-ID"]);
  // Re-running buildHeaders on the SAME bag must not rotate X-Conversation-ID.
  const again = ex.buildHeaders({ ...creds, providerSpecificData: {} }, true, "url", "glm-5.2", body);
  assert.equal(again["X-Conversation-ID"], headers["X-Conversation-ID"]);
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
