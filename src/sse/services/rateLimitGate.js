// Shared per-API-key RPM gate used by every /v1 handler (chat, embeddings,
// images, audio, video, search). Keeps the acquire/limit/429 logic in one place
// so media endpoints enforce the same key-scope limit as chat/messages.
//
// Provider-scope limiting stays inline in each handler because it needs the
// resolved connection (connectionId/rpm) from getProviderCredentials.

import { getApiKeyLimits } from "@/lib/localDb";
import { acquire, RateLimitTimeoutError } from "open-sse/services/rateLimiter.js";
import { unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import * as log from "../utils/logger.js";

/**
 * Enforce the per-API-key RPM limit + queue for a request.
 *
 * @param {string|null} apiKey  raw API key presented on the request (may be null)
 * @returns {Promise<Response|null>} a 429 Response when the limit is exceeded,
 *          otherwise null (caller proceeds).
 */
export async function enforceApiKeyRateLimit(apiKey) {
  if (!apiKey) return null;

  const limits = await getApiKeyLimits(apiKey);
  if (!limits || !(limits.rpm > 0)) return null;

  try {
    await acquire("apikey", limits.id, { rpm: limits.rpm, timeoutMs: limits.queueTimeoutMs });
    return null;
  } catch (e) {
    if (e instanceof RateLimitTimeoutError) {
      log.warn("RATELIMIT", `API key ${log.maskKey(apiKey)} exceeded ${limits.rpm} rpm`);
      return unavailableResponse(
        HTTP_STATUS.RATE_LIMITED,
        "API key rate limit exceeded",
        e.retryAfter,
        `${e.retryAfter}s`,
      );
    }
    throw e;
  }
}
