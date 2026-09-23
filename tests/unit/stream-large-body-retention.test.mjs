import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const read = (path) => readFileSync(join(root, path), "utf8");

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

test("stream completion captures scalar client metadata before clearing the raw request", () => {
  const source = read("open-sse/handlers/chatCore/streamingHandler.js");
  assert.match(source, /const apiVersion = clientRawRequest\?\.apiVersion/);
  assert.match(source, /const endpoint = clientRawRequest\?\.endpoint/);
  assert.match(source, /clientRawRequest = null/);
});
