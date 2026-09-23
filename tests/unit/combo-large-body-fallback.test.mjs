import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";

register(new URL("./helpers/alias-loader.mjs", import.meta.url));

const { handleComboChat } = await import("../../open-sse/services/combo.js");
const { checkFallbackError } = await import("../../open-sse/services/accountFallback.js");
const chatHandler = readFileSync(new URL("../../src/sse/handlers/chat.js", import.meta.url), "utf8");

const silentLog = { info() {}, warn() {}, debug() {} };

test("chat routing enables body-read fallback only for configured combos", () => {
  assert.equal((chatHandler.match(/allowBodyReadFallback: true/g) || []).length, 2);
  assert.equal((chatHandler.match(/allowBodyReadFallback: false/g) || []).length, 1);
});

test("body-read 400 remains non-fallback at provider-account scope", () => {
  assert.deepEqual(
    checkFallbackError(400, '[400]: {"error":{"message":"failed to read request body"}}'),
    { shouldFallback: false, cooldownMs: 0 },
  );
});

test("combo falls through when one upstream cannot read a large valid body", async () => {
  const content = "x".repeat(1024 * 1024);
  const body = {
    model: "kimi-k3",
    stream: true,
    messages: [{ role: "user", content }],
  };
  const attempts = [];

  const response = await handleComboChat({
    body,
    models: ["oni/kimi-k3", "ama/amanai/kimi-k3"],
    comboName: "kimi-k3",
    comboStrategy: "fallback",
    allowBodyReadFallback: true,
    log: silentLog,
    handleSingleModel: async (received, model) => {
      attempts.push({ model, bytes: Buffer.byteLength(JSON.stringify(received)) });
      if (model === "oni/kimi-k3") {
        return Response.json({
          error: {
            code: "bad_request",
            message: "failed to read request body",
            type: "invalid_request_error",
          },
        }, { status: 400 });
      }
      return Response.json({ choices: [{ message: { role: "assistant", content: "ok" } }] });
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(attempts.map(({ model }) => model), ["oni/kimi-k3", "ama/amanai/kimi-k3"]);
  assert.equal(attempts[0].bytes, attempts[1].bytes);
  assert.equal(body.messages[0].content.length, content.length);
});

test("capacity-adapter routing keeps the same body-read 400 terminal", async () => {
  let attempts = 0;
  const response = await handleComboChat({
    body: { model: "direct-model", messages: [{ role: "user", content: "x".repeat(1024 * 1024) }] },
    models: ["one/model", "vision-adapter/model"],
    comboName: "direct-model",
    comboStrategy: "fallback",
    log: silentLog,
    handleSingleModel: async () => {
      attempts += 1;
      return Response.json({ error: { message: "failed to read request body" } }, { status: 400 });
    },
  });

  assert.equal(response.status, 400);
  assert.equal(attempts, 1);
});

test("combo still returns semantic 400 errors without trying another model", async () => {
  let attempts = 0;
  const response = await handleComboChat({
    body: { model: "combo", messages: [{ role: "user", content: "hello" }] },
    models: ["one/model", "two/model"],
    comboName: "combo",
    comboStrategy: "fallback",
    log: silentLog,
    handleSingleModel: async () => {
      attempts += 1;
      return Response.json({
        error: { message: "maximum context length exceeded", type: "invalid_request_error" },
      }, { status: 400 });
    },
  });

  assert.equal(response.status, 400);
  assert.equal(attempts, 1);
});
