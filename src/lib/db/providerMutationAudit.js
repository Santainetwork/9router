// Task 5: provider mutation audit registry. Every updateProviderConnection call
// reachable from API-worker routes must be classified as either a synchronous
// correctness mutation (routed through the Redis single-writer bridge) or
// control-only (never runs in an API worker). Unknown sites fail the audit.
//
// Classification key is the repo-relative file path. A file may only carry one
// class: mixed files must split their calls or add per-line overrides.
export const MUTATION_CLASS = Object.freeze({
  SYNC: "sync",
  CONTROL_ONLY: "control-only",
});

// Token-bearing credential updates are control-only until the worker proves it
// can encrypt them; the audit keeps this boundary explicit.
export const KNOWN_MUTATION_SITES = Object.freeze({
  "src/app/api/models/availability/route.js": MUTATION_CLASS.SYNC,
  "src/app/api/v1/models/route.js": MUTATION_CLASS.SYNC,
  "src/app/api/providers/[id]/models/route.js": MUTATION_CLASS.CONTROL_ONLY,
  "src/app/api/oauth/xiaomi-mimo/api-key/route.js": MUTATION_CLASS.CONTROL_ONLY,
  "src/app/api/provider-nodes/[id]/route.js": MUTATION_CLASS.SYNC,
  "src/app/api/providers/[id]/route.js": MUTATION_CLASS.CONTROL_ONLY,
  "src/app/api/translator/send/route.js": MUTATION_CLASS.SYNC,
  "src/app/api/usage/[connectionId]/route.js": MUTATION_CLASS.SYNC,
  "src/sse/services/auth.js": MUTATION_CLASS.SYNC,
  "src/sse/handlers/chat.js": MUTATION_CLASS.SYNC,
  "src/sse/handlers/embeddings.js": MUTATION_CLASS.SYNC,
  "src/sse/handlers/fetch.js": MUTATION_CLASS.SYNC,
  "src/sse/handlers/imageGeneration.js": MUTATION_CLASS.SYNC,
  "src/sse/handlers/search.js": MUTATION_CLASS.SYNC,
  "src/sse/handlers/videoGeneration.js": MUTATION_CLASS.SYNC,
  "src/sse/services/tokenRefresh.js": MUTATION_CLASS.SYNC,
  "src/shared/services/quotaAutoPing.js": MUTATION_CLASS.CONTROL_ONLY,
  "src/lib/oauth/providers/index.js": MUTATION_CLASS.CONTROL_ONLY,
});

export function classifyMutationSite(relativePath) {
  return KNOWN_MUTATION_SITES[relativePath] ?? "unknown";
}

export function isSyncMutation(relativePath) {
  return classifyMutationSite(relativePath) === MUTATION_CLASS.SYNC;
}

export function isControlOnlyMutation(relativePath) {
  return classifyMutationSite(relativePath) === MUTATION_CLASS.CONTROL_ONLY;
}
