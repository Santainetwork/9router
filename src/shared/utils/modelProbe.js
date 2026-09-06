export const DEFAULT_BASELINES = [
  "anthropic/claude-fable-5",
  "anthropic/claude-fable-5.1",
  "anthropic/claude-haiku-4.5",
  "anthropic/claude-opus-4.6",
  "anthropic/claude-opus-4.7",
  "anthropic/claude-opus-4.8",
  "anthropic/claude-opus-5",
  "anthropic/claude-sonnet-4.6",
  "anthropic/claude-sonnet-5",
  "deepseek/deepseek-v3.2",
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-pro",
  "google/gemini-3.1-pro-preview",
  "google/gemini-3.5-flash-lite",
  "google/gemini-3.6-flash",
  "google/gemini-3.7-flash",
  "google/gemini-3.8-flash",
  "openai/gpt-3.5-turbo",
  "openai/gpt-4",
  "openai/gpt-4o",
  "openai/gpt-5.2",
  "openai/gpt-5.3-codex",
  "openai/gpt-5.4",
  "openai/gpt-5.4-mini",
  "openai/gpt-5.5",
  "openai/gpt-5.6-luna",
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-terra",
  "openai/gpt-6-astra",
  "x-ai/grok-4.3",
  "x-ai/grok-4.5",
  "z-ai/glm-5",
  "z-ai/glm-5.1",
  "z-ai/glm-5.2",
];

export function resolveClaimedModel(claimed, modelId, baselines = DEFAULT_BASELINES) {
  const candidate = (claimed || modelId || "").trim();
  if (!candidate) return "";
  if (baselines.includes(candidate)) return candidate;

  const clean = candidate.includes("/") ? candidate.split("/").pop() : candidate;
  const cleanLower = clean.toLowerCase();

  // 1. Direct match on sub-model name
  for (const b of baselines) {
    const bModel = (b.split("/")[1] || b).toLowerCase();
    if (bModel === cleanLower) return b;
  }

  // 2. Normalized match (ignoring separators like hyphens vs dots)
  const normClean = cleanLower.replace(/[-_.]/g, "");
  for (const b of baselines) {
    const bModel = (b.split("/")[1] || b).toLowerCase().replace(/[-_.]/g, "");
    if (bModel === normClean) return b;
  }

  return candidate;
}
