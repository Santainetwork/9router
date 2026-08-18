export const DEFAULT_FOOTER_FIELDS = Object.freeze({
  providerModel: true,
  tokens: true,
  apiKeyQueue: true,
  providerQueue: true,
  duration: true,
});

export function footerSettingsFromServer(settings = {}) {
  const fields = settings.responseFooterBasicChatFields;
  return {
    enabled: settings.responseFooterBasicChatEnabled !== false,
    fields: Object.keys(DEFAULT_FOOTER_FIELDS).reduce(
      (result, key) => ({ ...result, [key]: fields?.[key] !== false }),
      {},
    ),
    customMessage: typeof settings.responseFooterBasicChatText === "string"
      ? settings.responseFooterBasicChatText.slice(0, 500)
      : "",
  };
}

export function footerSettingsPatch(value = {}) {
  const fields = value.fields && typeof value.fields === "object" ? value.fields : {};
  return {
    responseFooterBasicChatEnabled: value.enabled !== false,
    responseFooterBasicChatFields: Object.keys(DEFAULT_FOOTER_FIELDS).reduce(
      (result, key) => ({ ...result, [key]: fields[key] !== false }),
      {},
    ),
    responseFooterBasicChatText: String(value.customMessage ?? "").slice(0, 500),
  };
}
