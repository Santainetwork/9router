// Upstreams can answer HTTP 200 with an error envelope instead of a 4xx/5xx
// (e.g. Lucif.ai on a connection failure). The gateway must treat that as a
// failure so combo falls back to the next model, and must not misclassify a
// valid completion that carries an optional `error` key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractEmbeddedBodyError } from "../../open-sse/utils/error.js";

test("detects an error envelope delivered with HTTP 200", () => {
  assert.equal(extractEmbeddedBodyError({ error: { type: "server_error", message: "upstream connect timeout" } }), "upstream connect timeout");
});

test("detects the live Lucif.ai shape (object chat.completion, empty choices)", () => {
  const real = { id: "chatcmpl-streamer", object: "chat.completion", created: 1791965085, model: "claude-opus-4.8", choices: [], error: { type: "server_error", message: "upstream error: upstream connect timeout" } };
  assert.equal(extractEmbeddedBodyError(real), "upstream error: upstream connect timeout");
});

test("does not flag a chat.completion with a non-empty choices array", () => {
  assert.equal(extractEmbeddedBodyError({ object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "hi" } }] }), null);
});

test("accepts a string error", () => {
  assert.equal(extractEmbeddedBodyError({ error: "boom" }), "boom");
});

test("falls back to code/type when message is absent", () => {
  assert.equal(extractEmbeddedBodyError({ error: { code: "bad_gateway" } }), "bad_gateway");
});

test("does not flag a normal completion", () => {
  assert.equal(extractEmbeddedBodyError({ id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "hi" } }] }), null);
});

test("does not flag a body with choices even if it carries an error key", () => {
  assert.equal(extractEmbeddedBodyError({ choices: [{ index: 0 }], error: { message: "ignored" } }), null);
});

test("does not flag an object-typed body", () => {
  assert.equal(extractEmbeddedBodyError({ object: "response", error: { message: "ignored" } }), null);
});

test("handles null / non-object bodies", () => {
  assert.equal(extractEmbeddedBodyError(null), null);
  assert.equal(extractEmbeddedBodyError(undefined), null);
  assert.equal(extractEmbeddedBodyError("string"), null);
});
