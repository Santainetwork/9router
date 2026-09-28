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

export const ELIGIBILITY_ERROR = "PROVIDER_NOT_WORKER_SAFE";

export class ProviderNotWorkerSafeError extends Error {
  constructor(provider) {
    super(`provider ${provider || "(unknown)"} is not worker-safe`);
    this.name = "ProviderNotWorkerSafeError";
    this.code = ELIGIBILITY_ERROR;
  }
}

export function isProviderWorkerSafe(provider) {
  if (!provider || typeof provider !== "string") return false;
  return WORKER_SAFE_PROVIDERS.includes(provider);
}

// Runtime enforcement for SQLite multicore workers. Throws a typed fail-closed
// signal before auth selection/dispatch so the gateway can route back to
// control. A no-op in single-process and Postgres (isWorker false).
export function assertProviderWorkerSafe(provider, { isWorker }) {
  if (!isWorker || !isWorker()) return;
  if (!isProviderWorkerSafe(provider)) throw new ProviderNotWorkerSafeError(provider);
}

// HTTP boundary: a typed refusal response the gateway can identify and route
// back to a healthy direct-write control. The body never names the rejected
// provider (it would be an internal identifier), only a generic message + the
// ELIGIBILITY_ERROR code, so providers stay unlogged to operators reading 4xx.
export function providerNotWorkerSafeResponse(error) {
  if (!(error instanceof ProviderNotWorkerSafeError)) return null;
  const body = JSON.stringify({
    error: {
      message: "provider is not eligible for SQLite multicore API workers",
      type: "invalid_request_error",
      code: ELIGIBILITY_ERROR,
    },
  });
  return new Response(body, {
    status: 409,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "x-9router-worker-refusal": ELIGIBILITY_ERROR,
    },
  });
}

// Shared entrypoint wrapper: credential-bearing handlers throw the typed
// refusal from deep inside getProviderCredentials; without this wrapper the
// error surfaces as a generic Next 500 and the Go gateway can neither see
// the 409 + header signature nor route the retry back to control.
export function withWorkerRefusal(handler) {
  return async function (...args) {
    try {
      return await handler(...args);
    } catch (err) {
      const refusal = providerNotWorkerSafeResponse(err);
      if (refusal) return refusal;
      throw err;
    }
  };
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
