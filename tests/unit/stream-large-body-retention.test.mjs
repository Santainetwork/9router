import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { register } from "node:module";

register(new URL("./helpers/alias-loader.mjs", import.meta.url));

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const read = (path) => readFileSync(join(root, path), "utf8");

function loadRequestDetailHelpers() {
  const source = read("open-sse/handlers/chatCore/requestDetail.js")
    .replace(/^import .*;\n/gm, "")
    .replace(/^export /gm, "");
  const module = { exports: {} };
  vm.runInNewContext(
    `${source}\nmodule.exports = { extractRequestConfig, boundedProviderRequest };`,
    { module, exports: module.exports, Date, console },
  );
  return module.exports;
}

test("stream completion snapshot does not retain full request trees", () => {
  const source = read("open-sse/handlers/chatCore/streamingHandler.js");
  assert.match(source, /extractRequestConfig\(body, stream, \{ includeContent: false \}\)/);
  assert.doesNotMatch(source, /providerRequestSnapshot = finalBody \|\| translatedBody/);
});

test("stream transform estimates input tokens before retaining stream state", () => {
  const handler = read("open-sse/handlers/chatCore/streamingHandler.js");
  const stream = read("open-sse/utils/stream.js");
  const builder = handler.slice(
    handler.indexOf("function buildTransformStream"),
    handler.indexOf("export async function handleStreamingResponse"),
  );
  assert.match(handler, /estimatedInputTokens/);
  assert.doesNotMatch(builder, /\bbody\b/);
  assert.doesNotMatch(stream, /\bbody = null,/);
  assert.match(stream, /estimatedInputTokens = 0/);
});

test("request detail config can omit messages and tools for bounded streaming snapshots", () => {
  const source = read("open-sse/handlers/chatCore/requestDetail.js");
  assert.match(source, /includeContent = true/);
  assert.match(source, /if \(includeContent\)/);
  assert.match(source, /typeof body\[param\] !== "object"/);
});

test("bounded snapshots preserve useful metadata without retaining full content", () => {
  const { extractRequestConfig, boundedProviderRequest } = loadRequestDetailHelpers();
  const body = {
    model: "test-model",
    stream: true,
    temperature: 0.2,
    messages: Array.from({ length: 8 }, (_, i) => ({ role: "user", content: `${i}:${"x".repeat(1000)}` })),
    tools: Array.from({ length: 30 }, (_, i) => ({ type: "function", function: { name: `tool_${i}`, description: "y".repeat(1000) } })),
    metadata: { giant: "z".repeat(1000) },
  };

  const snapshot = extractRequestConfig(body, true, { includeContent: false });
  assert.equal(snapshot.messageCount, 8);
  assert.equal(snapshot.toolCount, 30);
  assert.equal(snapshot.messagePreview.length, 5);
  assert.ok(snapshot.messagePreview.every((message) => message.preview.length <= 240));
  assert.equal(snapshot.toolNames.length, 20);
  assert.equal(snapshot.temperature, 0.2);
  assert.equal(snapshot.messages, undefined);
  assert.equal(snapshot.tools, undefined);
  assert.equal(snapshot.metadata, undefined);
  assert.deepEqual(
    JSON.parse(JSON.stringify(boundedProviderRequest(body))),
    JSON.parse(JSON.stringify(snapshot)),
  );
});

test("stream completion captures scalar client metadata before clearing the raw request", () => {
  const source = read("open-sse/handlers/chatCore/streamingHandler.js");
  assert.match(source, /const apiVersion = clientRawRequest\?\.apiVersion/);
  assert.match(source, /const endpoint = clientRawRequest\?\.endpoint/);
  assert.match(source, /clientRawRequest = null/);
});

test("legacy positional stream factory snapshots input tokens before streaming", async () => {
  const [{ createPassthroughStreamWithLogger }, { estimateInputTokens }] = await Promise.all([
    import("../../open-sse/utils/stream.js"),
    import("../../open-sse/utils/usageTracking.js"),
  ]);
  const body = { model: "test-model", messages: [{ role: "user", content: "x".repeat(4000) }] };
  const expectedInput = estimateInputTokens(body) + 2000;
  const transform = createPassthroughStreamWithLogger("openai", null, "test-model", null, body);

  body.messages[0].content = "changed after stream construction";
  const writer = transform.writable.getWriter();
  const reader = transform.readable.getReader();
  const write = writer.write(new TextEncoder().encode(
    'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
  ));

  let output = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    output += new TextDecoder().decode(value);
    if (output.includes("[DONE]")) break;
  }
  await write;
  await writer.close().catch(() => {});

  const finish = output
    .split("\n")
    .filter((line) => line.startsWith("data: {") && line.includes("finish_reason"))
    .map((line) => JSON.parse(line.slice(6)))
    .find((chunk) => chunk.choices?.[0]?.finish_reason === "stop");
  assert.equal(finish?.usage?.prompt_tokens, expectedInput);
});
