import test from "node:test";
import assert from "node:assert/strict";
import { detectFormatByEndpoint, FORMATS } from "../../open-sse/translator/formats.js";

const BASE_URL = "http://localhost:20128";

test("detectFormatByEndpoint detects Claude format for nosaver messages routes", () => {
  assert.equal(detectFormatByEndpoint("/v1/nosaver/messages", {}), FORMATS.CLAUDE);
  assert.equal(detectFormatByEndpoint("/api/v1/nosaver/messages", {}), FORMATS.CLAUDE);
  assert.equal(detectFormatByEndpoint("/nosaver/messages", {}), FORMATS.CLAUDE);
  assert.equal(detectFormatByEndpoint("/v1/messages", {}), FORMATS.CLAUDE);
});

test("detectFormatByEndpoint detects OpenAI Responses format for nosaver responses routes", () => {
  assert.equal(detectFormatByEndpoint("/v1/nosaver/responses", {}), FORMATS.OPENAI_RESPONSES);
  assert.equal(detectFormatByEndpoint("/api/v1/nosaver/responses", {}), FORMATS.OPENAI_RESPONSES);
  assert.equal(detectFormatByEndpoint("/nosaver/responses", {}), FORMATS.OPENAI_RESPONSES);
});

test("/v1/nosaver/messages and /api/v1/nosaver/messages handle OPTIONS preflight", async () => {
  for (const path of ["/v1/nosaver/messages", "/api/v1/nosaver/messages"]) {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: "OPTIONS"
    });
    assert.equal(res.status, 200, `OPTIONS ${path} returns 200`);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
  }
});

test("/v1/nosaver/messages rejects unauthenticated request with 401", async () => {
  const res = await fetch(`${BASE_URL}/v1/nosaver/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "Hello" }]
    })
  });
  assert.equal(res.status, 401, "unauthenticated POST /v1/nosaver/messages must return 401");
});

test("/v1/nosaver/messages/count_tokens estimates tokens correctly", async () => {
  const res = await fetch(`${BASE_URL}/v1/nosaver/messages/count_tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "Hello world" }]
    })
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(typeof data.input_tokens === "number");
  assert.ok(data.input_tokens > 0);
});
