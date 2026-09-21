// Shared per-API-key RPM gate used by every /v1 handler (chat, embeddings,
// images, audio, video, search). Keeps the acquire/limit/429 logic in one place
// so media endpoints enforce the same key-scope limit as chat/messages.
//
// Provider-scope limiting stays inline in each handler because it needs the
// resolved connection (connectionId/rpm) from getProviderCredentials.

import { getApiKeyLimits, getApiKeyTokenUsage } from "@/lib/localDb";
import { acquire, RateLimitTimeoutError } from "open-sse/services/rateLimiter.js";
import { unavailableResponse, errorResponse, limiterUnavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import * as log from "../utils/logger.js";

/**
 * Enforce the per-API-key RPM limit + queue for a request.
 *
 * @param {string|null} apiKey  raw API key presented on the request (may be null)
 * @returns {Promise<Response|null>} a 429 Response when the limit is exceeded,
 *          otherwise null (caller proceeds).
 */
export async function enforceApiKeyRateLimit(apiKey, queueMeta = null, signal = null) {
  if (!apiKey) return { limited: null, release: () => {} };

  const limits = await getApiKeyLimits(apiKey);
  const hasRpm = Number(limits?.rpm) > 0;
  const hasConcurrency = Number(limits?.concurrency) > 0;

  if (!limits || (!hasRpm && !hasConcurrency)) {
    return { limited: null, release: () => {} };
  }

  try {
    let queued = false;
    const startedAt = Date.now();
    const timeoutMs = Number(limits.queueTimeoutMs) > 0 ? limits.queueTimeoutMs : 60000;
    const releaseFn = await acquire("apikey", limits.id, {
      rpm: limits.rpm,
      concurrency: limits.concurrency,
      timeoutMs,
      onQueued: () => { queued = true; },
      signal,
    });
    if (queueMeta && queued) {
      queueMeta.apiKeyQueued = true;
      queueMeta.apiKeyWaitMs = (queueMeta.apiKeyWaitMs || 0) + (Date.now() - startedAt);
    }
    return { limited: null, release: releaseFn || (() => {}) };
  } catch (e) {
    if (e instanceof RateLimitTimeoutError) {
      const reason = hasConcurrency && !hasRpm
        ? `API key ${log.maskKey(apiKey)} exceeded ${limits.concurrency} max concurrency`
        : `API key ${log.maskKey(apiKey)} exceeded limit (${limits.rpm} rpm / ${limits.concurrency} concurrent)`;
      log.warn("RATELIMIT", reason);
      const resp = unavailableResponse(
        HTTP_STATUS.RATE_LIMITED,
        e.message || "API key rate limit / concurrency exceeded",
        e.retryAfter,
        `${e.retryAfter}s`,
      );
      return { limited: resp, release: () => {} };
    }
    // API-worker Go limiter unavailable: surface its own 503 instead of letting
    // it bubble to a generic Next 500. Timeout/429 handling stays above.
    const limiterResp = limiterUnavailableResponse(e);
    if (limiterResp) {
      log.warn("RATELIMIT", e.message || "Go hybrid limiter unavailable");
      return { limited: limiterResp, release: () => {} };
    }
    throw e;
  }
}

// ─── RBAC: per-key model allowlist + total-token quota ──────────────────────

/**
 * Is `model` permitted by an allowlist? Matching is EXACT on the model string
 * the caller requested — listing "deepseek-v4-flash" permits only that id, not
 * "amar/amanai/deepseek-v4-flash". Grant each id (or combo name) explicitly.
 * An empty/absent allowlist means unrestricted.
 *
 * The same function backs /v1/models, so the catalog a key sees is exactly the
 * set it may call.
 */
export function isModelAllowedBy(allowedModels, model) {
  const allow = Array.isArray(allowedModels) ? allowedModels : [];
  if (allow.length === 0) return true;
  const requested = String(model || "").trim();
  if (!requested) return false;

  return allow.some((entry) => {
    const pattern = String(entry || "").trim();
    if (!pattern) return false;
    if (pattern === "*" || pattern === requested) return true;

    // Wildcard prefix matching e.g. "hx/*" matches "hx/claude-sonnet-5", "hx/x-ai/grok-4.6"
    if (pattern.endsWith("/*")) {
      const pfx = pattern.slice(0, -2);
      if (requested.startsWith(pfx + "/")) return true;
    } else if (pattern.endsWith("*")) {
      const pfx = pattern.slice(0, -1);
      if (requested.startsWith(pfx)) return true;
    }

    return false;
  });
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
  if (allow.length > 0 && !isModelAllowedBy(allow, model)) {
    log.warn("RBAC", `API key ${log.maskKey(apiKey)} denied model ${model}`);
    return errorResponse(
      HTTP_STATUS.FORBIDDEN,
      `Model not permitted for this API key: ${model}`,
    );
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
