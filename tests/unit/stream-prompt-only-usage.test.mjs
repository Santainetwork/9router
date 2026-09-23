import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./helpers/alias-loader.mjs", import.meta.url));

const [{ createPassthroughStreamWithLogger }, { estimateOutputTokens }] = await Promise.all([
  import("../../open-sse/utils/stream.js"),
  import("../../open-sse/utils/usageTracking.js"),
]);
const { createSSETransformStreamWithLogger } = await import("../../open-sse/utils/stream.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");

async function runPassthrough(chunks, estimatedInputTokens = 123) {
  let completion;
  let completionCalls = 0;
  const transform = createPassthroughStreamWithLogger(
    "openai-compatible-test",
    null,
    "model",
    "connection",
    estimatedInputTokens,
    (_content, usage) => { completionCalls += 1; completion = usage; },
  );
  const writer = transform.writable.getWriter();
  const reader = transform.readable.getReader();
  const reading = (async () => {
    while (!(await reader.read()).done) {}
  })();
  for (const chunk of chunks) await writer.write(new TextEncoder().encode(chunk));
  await writer.close();
  await reading;
  return { completion, completionCalls };
}

async function runTranslated(chunks) {
  let completion;
  let completionCalls = 0;
  const transform = createSSETransformStreamWithLogger(
    FORMATS.OPENAI,
    FORMATS.CLAUDE,
    "openai-compatible-test",
    null,
    null,
    "model",
    "connection",
    123,
    (_content, usage) => { completionCalls += 1; completion = usage; },
  );
  const writer = transform.writable.getWriter();
  const reader = transform.readable.getReader();
  const reading = (async () => { while (!(await reader.read()).done) {} })();
  for (const chunk of chunks) await writer.write(new TextEncoder().encode(chunk));
  await writer.close();
  await reading;
  return { completion, completionCalls };
}

test("prompt-only provider usage estimates completion tokens from streamed content", async () => {
  const content = "This is provider output that must count toward completion tokens.";
  const { completion: usage, completionCalls } = await runPassthrough([
    `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 900, completion_tokens: 0, total_tokens: 900 } })}\n\n`,
    "data: [DONE]\n\n",
  ]);

  assert.equal(completionCalls, 1);
  assert.equal(usage.prompt_tokens, 900);
  assert.equal(usage.completion_tokens, estimateOutputTokens(content.length));
  assert.equal(usage.total_tokens, usage.prompt_tokens + usage.completion_tokens);
  assert.equal(usage.estimated, true);
});

test("real provider completion tokens are never replaced by an estimate", async () => {
  const { completion: usage, completionCalls } = await runPassthrough([
    `data: ${JSON.stringify({ choices: [{ delta: { content: "short" }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 77, total_tokens: 87 } })}\n\n`,
    "data: [DONE]\n\n",
  ]);

  assert.equal(completionCalls, 1);
  assert.equal(usage.prompt_tokens, 10);
  assert.equal(usage.completion_tokens, 77);
  assert.equal(usage.estimated, undefined);
});

test("tool-call-only streams estimate output from function name and arguments", async () => {
  const name = "run_command";
  const args = JSON.stringify({ command: "echo " + "x".repeat(240) });
  const usage = await runPassthrough([
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name, arguments: "" } }] }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 2000, completion_tokens: 0, total_tokens: 2000 } })}\n\n`,
    "data: [DONE]\n\n",
  ]);

  assert.equal(usage.completionCalls, 1);
  assert.ok(usage.completion.completion_tokens >= estimateOutputTokens(name.length + args.length));
  assert.equal(usage.completion.total_tokens, 2000 + usage.completion.completion_tokens);
});

test("translated streams also fill missing provider output usage", async () => {
  const content = "translated provider output";
  const usage = await runTranslated([
    `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 700, completion_tokens: 0 } })}\n\n`,
    "data: [DONE]\n\n",
  ]);

  assert.equal(usage.completionCalls, 1);
  assert.equal(usage.completion.input_tokens, 700);
  assert.equal(usage.completion.output_tokens, estimateOutputTokens(content.length));
});

test("stream cancellation notifies completion once with aborted metadata", async () => {
  let contentObj;
  let completionCalls = 0;
  const transform = createPassthroughStreamWithLogger(
    "openai-compatible-test",
    null,
    "model",
    "connection",
    123,
    (content) => { completionCalls += 1; contentObj = content; },
  );
  const reader = transform.readable.getReader();
  await reader.cancel("client disconnected");
  assert.equal(completionCalls, 1);
  assert.equal(contentObj.aborted, true);
});
