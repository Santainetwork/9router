export function redactProviderFooterText(text) {
  if (!text || typeof text !== "string") return "";
  let redacted = text;
  for (const pattern of [
    /Bearer\s+[a-zA-Z0-9._~-]+/gi,
    /sk-[a-zA-Z0-9]{20,}/g,
    /[a-zA-Z0-9_-]{32,}/g,
  ]) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return redacted;
}

const PROVIDER_FOOTER_PATTERNS = [
  /this response was delivered by ai\.amanai\.dev/i,
  /delivered by ai\.amanai\.dev/i,
];

export function detectProviderFooter(text) {
  if (!text || typeof text !== "string") return null;
  for (const pattern of PROVIDER_FOOTER_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return match[0];
  }
  return null;
}
