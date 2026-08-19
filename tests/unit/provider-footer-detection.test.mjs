import test from "node:test";
import assert from "node:assert/strict";
import {
  detectProviderFooter,
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
  assert.equal(detectProviderFooter("The answer mentions delivered by another.example in prose"), null);
});

test("redacts key-like values before persistence", () => {
  const result = redactProviderFooterText("via provider sk-abcdefghijklmnopqrstuvwxyz1234567890");
  assert.match(result, /via provider \[REDACTED\]/);
  assert.doesNotMatch(result, /abcdefghijklmnopqrstuvwxyz1234567890/);
});
