// Command Code v1 speaks plain OpenAI. If the router still translated the
// request into the CLI envelope, the body has no top-level `messages` and v1
// answers: "Invalid input: expected array, received undefined".
import { test } from "node:test";
import assert from "node:assert/strict";
import { getTargetFormat } from "../../open-sse/services/provider.js";

test("commandcode defaults to the CLI envelope format", () => {
  assert.equal(getTargetFormat("commandcode", { providerSpecificData: {} }), "commandcode");
  assert.equal(getTargetFormat("commandcode", null), "commandcode");
});

test("commandcode with v1 transport targets plain OpenAI", () => {
  const creds = { providerSpecificData: { commandcodeTransport: "v1" } };
  assert.equal(getTargetFormat("commandcode", creds), "openai");
});

test("other providers are unaffected by the flag", () => {
  const creds = { providerSpecificData: { commandcodeTransport: "v1" } };
  assert.notEqual(getTargetFormat("openai", creds), undefined);
  assert.equal(getTargetFormat("openrouter", creds), "openai");
});
