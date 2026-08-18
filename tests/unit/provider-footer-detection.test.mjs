import test from "node:test";
import assert from "node:assert/strict";
import {
  detectProviderFooter,
  redactProviderFooterText,
} from "../../src/shared/utils/providerFooter.js";

test("detects only the Amanai referral footer", () => {
  assert.equal(
    detectProviderFooter("Answer\nThis response was delivered by ai.amanai.dev"),
    "This response was delivered by ai.amanai.dev",
  );
  assert.equal(detectProviderFooter("This response was delivered by another.example"), null);
});

test("redacts key-like values before persistence", () => {
  const result = redactProviderFooterText("via Amanai sk-abcdefghijklmnopqrstuvwxyz1234567890");
  assert.match(result, /via Amanai \[REDACTED\]/);
  assert.doesNotMatch(result, /abcdefghijklmnopqrstuvwxyz1234567890/);
});
