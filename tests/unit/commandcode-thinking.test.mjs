// Effort must follow the selected wire: alpha nests it in params (CLI envelope),
// v1 takes the native top-level reasoning_effort. Before the fix, the v1 path
// still emitted params.reasoning_effort because the capability block describes
// the alpha envelope, so effort was silently dropped by the OpenAI gateway.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";

const MODEL = "deepseek/deepseek-v4.1-flash";

test("v1 (openai target) sends top-level reasoning_effort, no params", () => {
  const body = {};
  applyThinking("openai", MODEL, body, "commandcode", { mode: "level", level: "high" });
  assert.equal(body.reasoning_effort, "high");
  assert.equal("params" in body, false);
});

test("alpha (commandcode target) keeps nesting effort in params", () => {
  const body = { params: { model: MODEL } };
  applyThinking("commandcode", MODEL, body, "commandcode", { mode: "level", level: "high" });
  assert.equal(body.params.reasoning_effort, "high");
});

test("v1 honours none by sending reasoning_effort none", () => {
  const body = {};
  applyThinking("openai", MODEL, body, "commandcode", { mode: "none" });
  assert.equal(body.reasoning_effort, "none");
});
