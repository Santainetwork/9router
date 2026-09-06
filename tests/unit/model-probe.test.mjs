import test from "node:test";
import assert from "node:assert/strict";
import { resolveClaimedModel, DEFAULT_BASELINES } from "../../src/shared/utils/modelProbe.js";

test("DEFAULT_BASELINES contains official models", () => {
  assert.ok(Array.isArray(DEFAULT_BASELINES));
  assert.ok(DEFAULT_BASELINES.includes("anthropic/claude-sonnet-5"));
  assert.ok(DEFAULT_BASELINES.includes("openai/gpt-6-astra"));
});

test("resolveClaimedModel resolves modelId to canonical baseline", () => {
  assert.equal(resolveClaimedModel("", "hx/claude-sonnet-5"), "anthropic/claude-sonnet-5");
  assert.equal(resolveClaimedModel("", "claude-sonnet-4-6"), "anthropic/claude-sonnet-4.6");
  assert.equal(resolveClaimedModel("", "gpt-6-astra"), "openai/gpt-6-astra");
  assert.equal(resolveClaimedModel("", "gemini-3.8-flash"), "google/gemini-3.8-flash");
  assert.equal(resolveClaimedModel("", "deepseek-v4-flash"), "deepseek/deepseek-v4-flash");
  assert.equal(resolveClaimedModel("", "glm-5.1"), "z-ai/glm-5.1");
});

test("resolveClaimedModel preserves explicit canonical claimedModel", () => {
  assert.equal(resolveClaimedModel("anthropic/claude-opus-5", "my-custom-opus"), "anthropic/claude-opus-5");
  assert.equal(resolveClaimedModel("openai/gpt-4o", "gpt-4o"), "openai/gpt-4o");
});
