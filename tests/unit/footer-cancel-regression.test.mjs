// Regression: downstream cancel of footer/model-rewrite streams must not
// raise unhandledRejection from an upstream locked ReadableStream cancel.
import test from "node:test";
import assert from "node:assert/strict";
import { wrapOpenAIStreamWithFooter, rewriteStreamModel } from "../../open-sse/handlers/chatCore/responseFooter.js";

test("footer stream cancel does not reject asynchronously on locked upstream", async () => {
  let unhandled = 0;
  const onRejection = () => { unhandled++; };
  process.on("unhandledRejection", onRejection);
  try {
    const enc = new TextEncoder();
    const upstream = new ReadableStream({ start(c){ c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')); } });
    const footered = wrapOpenAIStreamWithFooter(upstream, "by SantaiNetwork · test", {});
    const reader = footered.getReader();
    await reader.read();
    await reader.cancel("client abort");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(unhandled, 0);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

test("model rewrite stream cancel does not reject asynchronously on locked upstream", async () => {
  let unhandled = 0;
  const onRejection = () => { unhandled++; };
  process.on("unhandledRejection", onRejection);
  try {
    const enc = new TextEncoder();
    const upstream = new ReadableStream({ start(c){ c.enqueue(enc.encode('data: {"model":"up-x","choices":[]}\n\n')); } });
    const rewritten = rewriteStreamModel(upstream, "req-model");
    const reader = rewritten.getReader();
    await reader.read();
    await reader.cancel("client abort");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(unhandled, 0);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});
