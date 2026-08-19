import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_FOOTER_FIELDS,
  footerSettingsFromServer,
  footerSettingsPatch,
} from "../../src/shared/utils/footerSettings.js";

test("global footer settings merge server values with default fields", () => {
  assert.deepEqual(
    footerSettingsFromServer({
      responseFooterBasicChatEnabled: false,
      responseFooterBasicChatFields: { tokens: false },
      responseFooterBasicChatText: "Powered by provider",
    }),
    {
      enabled: false,
      fields: { ...DEFAULT_FOOTER_FIELDS, tokens: false },
      customMessage: "Powered by provider",
    },
  );
});

test("footer settings patch normalizes text and unknown fields", () => {
  assert.deepEqual(
    footerSettingsPatch({
      enabled: true,
      fields: { tokens: false, unknown: true },
      customMessage: "x".repeat(600),
    }),
    {
      responseFooterBasicChatEnabled: true,
      responseFooterBasicChatFields: { ...DEFAULT_FOOTER_FIELDS, tokens: false },
      responseFooterBasicChatText: "x".repeat(500),
    },
  );
});
