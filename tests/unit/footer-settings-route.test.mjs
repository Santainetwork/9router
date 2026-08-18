import test from "node:test";
import assert from "node:assert/strict";
import { footerSettingsPatch } from "../../src/shared/utils/footerSettings.js";

test("global footer patch keeps only known fields and clamps text", () => {
  const patch = footerSettingsPatch({
    enabled: false,
    fields: { tokens: false, unknown: true },
    customMessage: "a".repeat(501),
  });

  assert.equal(patch.responseFooterBasicChatEnabled, false);
  assert.deepEqual(patch.responseFooterBasicChatFields, {
    providerModel: true,
    tokens: false,
    apiKeyQueue: true,
    providerQueue: true,
    duration: true,
  });
  assert.equal(patch.responseFooterBasicChatText.length, 500);
});
