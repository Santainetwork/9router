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
  /^\s*this response was delivered by\s+[^\r\n]+\s*$/im,
  /^\s*(?:powered by|via)\s+[^\r\n]+\s*$/im,
];

export function detectProviderFooter(text) {
  if (!text || typeof text !== "string") return null;
  for (const pattern of PROVIDER_FOOTER_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return match[0];
  }
  return null;
}

export function extractProviderFooterChunkText(line) {
  if (!line || typeof line !== "string") return "";
  const payload = line.trim().startsWith("data:") ? line.trim().slice(5).trim() : line.trim();
  if (!payload || payload === "[DONE]") return "";
  try {
    const value = JSON.parse(payload);
    const delta = value?.choices?.[0]?.delta;
    return typeof delta?.content === "string" ? delta.content : "";
  } catch {
    return "";
  }
}

export function providerFooterDisplayText(log) {
  return typeof log?.referral_text === "string" ? log.referral_text : "";
}
