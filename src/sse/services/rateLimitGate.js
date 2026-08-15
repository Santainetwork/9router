// Shared per-API-key RPM gate used by every /v1 handler (chat, embeddings,
// images, audio, video, search). Keeps the acquire/limit/429 logic in one place
// so media endpoints enforce the same key-scope limit as chat/messages.
//
// Provider-scope limiting stays inline in each handler because it needs the
// resolved connection (connectionId/rpm) from getProviderCredentials.

import { getApiKeyLimits, getApiKeyTokenUsage } from "@/lib/localDb";
import { acquire, RateLimitTimeoutError } from "open-sse/services/rateLimiter.js";
import { unavailableResponse, errorResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import * as log from "../utils/logger.js";

/**
 * Enforce the per-API-key RPM limit + queue for a request.
 *
 * @param {string|null} apiKey  raw API key presented on the request (may be null)
 * @returns {Promise<Response|null>} a 429 Response when the limit is exceeded,
 *          otherwise null (caller proceeds).
 */
export async function enforceApiKeyRateLimit(apiKey, queueMeta = null) {
  if (!apiKey) return null;

  const limits = await getApiKeyLimits(apiKey);
  if (!limits || !(limits.rpm > 0)) return null;

  try {
    let queued = false;
    const startedAt = Date.now();
    await acquire("apikey", limits.id, {
      rpm: limits.rpm,
      timeoutMs: limits.queueTimeoutMs,
      onQueued: () => { queued = true; },
    });
    if (queueMeta && queued) {
      queueMeta.apiKeyQueued = true;
      queueMeta.apiKeyWaitMs = (queueMeta.apiKeyWaitMs || 0) + (Date.now() - startedAt);
    }
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

// ─── RBAC: per-key model allowlist + total-token quota ──────────────────────

// Normalize a model string for allowlist comparison. Requests may arrive as
// "provider/model", "model", or a combo name; we compare against both the full
// string and the part after the last "/".
function modelVariants(model) {
  const s = String(model || "").trim();
  if (!s) return [];
  const out = new Set([s]);
  const slash = s.lastIndexOf("/");
  if (slash >= 0) out.add(s.slice(slash + 1));
  return [...out];
}

/**
 * Enforce per-key RBAC before a request runs:
 *   1. model allowlist — if the key has allowedModels set, the requested model
 *      must be in it (matched by full id or the part after "/").
 *   2. token quota — if tokenQuota > 0, reject once cumulative
 *      prompt+completion tokens for this key reach the quota.
 *
 * @param {string|null} apiKey  raw API key (may be null → no key, no RBAC)
 * @param {string} model        requested model string
 * @returns {Promise<Response|null>} 403 Response on violation, else null.
 */
export async function enforceApiKeyAccess(apiKey, model) {
  if (!apiKey) return null;

  const limits = await getApiKeyLimits(apiKey);
  if (!limits) return null;

  // 1. Model allowlist
  const allow = limits.allowedModels || [];
  if (allow.length > 0) {
    const variants = modelVariants(model);
    const permitted = variants.some((v) => allow.includes(v));
    if (!permitted) {
      log.warn("RBAC", `API key ${log.maskKey(apiKey)} denied model ${model}`);
      return errorResponse(
        HTTP_STATUS.FORBIDDEN,
        `Model not permitted for this API key: ${model}`,
      );
    }
  }

  // 2. Token quota (all-time prompt+completion tokens)
  if (limits.tokenQuota > 0) {
    const used = await getApiKeyTokenUsage(apiKey);
    if (used >= limits.tokenQuota) {
      log.warn("RBAC", `API key ${log.maskKey(apiKey)} token quota exhausted (${used}/${limits.tokenQuota})`);
      return errorResponse(
        HTTP_STATUS.FORBIDDEN,
        `Token quota exhausted for this API key (${used}/${limits.tokenQuota})`,
      );
    }
  }

  return null;
}
