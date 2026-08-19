import test from "node:test";
import assert from "node:assert/strict";
import {
  detectProviderFooter,
  extractProviderFooterChunkText,
  providerFooterDisplayText,
  redactProviderFooterText,
} from "../../src/shared/utils/providerFooter.js";

test("detects generic provider referral footer lines", () => {
  assert.equal(
    detectProviderFooter("Answer\nThis response was delivered by provider.example"),
    "This response was delivered by provider.example",
  );
  assert.equal(
    detectProviderFooter("Answer\nThis response was delivered by another.example"),
    "This response was delivered by another.example",
  );
  assert.equal(detectProviderFooter("Powered by provider.example"), "Powered by provider.example");
  assert.equal(detectProviderFooter("via provider.example"), "via provider.example");
  assert.equal(detectProviderFooter("The answer mentions delivered by another.example in prose"), null);
});

test("extracts footer text from OpenAI SSE content chunks", () => {
  assert.equal(
    extractProviderFooterChunkText('data: {"choices":[{"delta":{"content":"Powered by provider.example"}}]}'),
    "Powered by provider.example",
  );
});

test("presents detected footer text without internal provider metadata", () => {
  assert.equal(
    providerFooterDisplayText({
      provider: "openai-compatible-chat-internal-id",
      model: "internal-model-id",
      referral_text: "Powered by provider.example",
    }),
    "Powered by provider.example",
  );
});

test("redacts key-like values before persistence", () => {
  const result = redactProviderFooterText("via provider sk-abcdefghijklmnopqrstuvwxyz1234567890");
  assert.match(result, /via provider \[REDACTED\]/);
  assert.doesNotMatch(result, /abcdefghijklmnopqrstuvwxyz1234567890/);
});
