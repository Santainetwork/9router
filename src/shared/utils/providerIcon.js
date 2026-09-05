// Provider icon paths under /public/providers.
// Alias related brands; session-cache 404s so one miss never spams again.

const ICON_ALIASES = {
  "perplexity-agent": "perplexity",
  "gitlab-duo": "gitlab",
  "vercel-ai-gateway": "vercel",
  "ollama-search": "ollama",
  "gemini-cli": "gemini",
  "grok-cli": "xai",
  "grok-web": "xai",
  "opencode": "opencode-go",
  "heraxles": "openai",
  "hx": "openai",
  "amanai": "openai",
  "amai": "openai",
  "b.ai": "openai",
  "bai": "openai",
  "bai-nebula": "openai",
  "moyra": "openai",
  "srbyte": "openai",
  "geraikita": "openai",
  "lapakvip": "openai",
  "qwenbaik": "openai",
  "yogathedev": "openai",
  "minervax": "openai",
  "nexus": "openai",
};

// Runtime only — first 404 remembers id for the whole session
const failedIds = new Set();

function normalizeId(providerId) {
  if (!providerId || typeof providerId !== "string") return "";
  const id = providerId.trim().toLowerCase();
  if (
    id.startsWith("openai-compatible-") ||
    id.startsWith("anthropic-compatible-") ||
    id.startsWith("custom-embedding-") ||
    id.startsWith("custom-") ||
    id.includes("-compatible-")
  ) {
    if (id.startsWith("anthropic-compatible-") || id.includes("anthropic")) return "anthropic";
    return "openai";
  }
  return id;
}

/** Resolve icon file id (after alias). Empty if previously failed this session. */
export function resolveProviderIconId(providerId) {
  const id = normalizeId(providerId);
  if (!id) return "";
  if (failedIds.has(id)) return "";
  const aliased = ICON_ALIASES[id] || id;
  if (failedIds.has(aliased)) return "";
  return aliased;
}

/** `/providers/{id}.png` or null when previously failed. */
export function getProviderIconSrc(providerId) {
  const id = resolveProviderIconId(providerId);
  return id ? `/providers/${id}.png` : null;
}

/** Call from img onError so later mounts skip the request. */
export function markProviderIconMissing(providerId) {
  const id = normalizeId(providerId);
  if (id) failedIds.add(id);
  const aliased = ICON_ALIASES[id];
  if (aliased) failedIds.add(aliased);
}
