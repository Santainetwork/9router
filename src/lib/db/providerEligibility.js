// Task 5: provider worker eligibility. Unknown/stateful/token-bearing providers
// remain control-only. Only an explicit allowlist may run in API workers.
//
// ponytail: allowlist is conservative; extend after a provider's session state
// audit proves worker switching is safe (spec "Stateful Executor Eligibility").

// Providers whose request path is stateless and does not carry worker-local
// session state. Token-bearing providers stay out until worker credential
// encryption is proven (Task 5, "until available, keep token-bearing
// connection updates control-only").
export const WORKER_SAFE_PROVIDERS = Object.freeze([
  "openai",
  "anthropic",
  "claude",
  "google",
  "gemini",
]);

export function isProviderWorkerSafe(provider) {
  if (!provider || typeof provider !== "string") return false;
  return WORKER_SAFE_PROVIDERS.includes(provider);
}

const TOKEN_BEARING_KEYS = [
  "accessToken", "refreshToken", "idToken", "apiKey", "token",
  "copilotToken", "copilotTokenExpiresAt", "providerSpecificData",
];

// A connection update that would write raw credential material must never enter
// the Redis mutation stream. Callers keep such providers control-only.
export function isTokenBearingUpdate(updates) {
  if (!updates || typeof updates !== "object") return false;
  return TOKEN_BEARING_KEYS.some((key) => updates[key] !== undefined && updates[key] !== null);
}
