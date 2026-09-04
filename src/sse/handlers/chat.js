import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { handleAntigravityQuotaError, clearAntigravityStrikes } from "../services/antigravityQuota.js";
import { getSettings } from "@/lib/localDb";
import { acquire, RateLimitTimeoutError } from "open-sse/services/rateLimiter.js";
import { enforceApiKeyRateLimit, enforceApiKeyAccess } from "../services/rateLimitGate.js";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { handleComboChat, handleFusionChat, detectRequiredCapabilities } from "open-sse/services/combo.js";
import { augmentModelsWithCapacityAdapter, withCapacityAdapterStripping, getActiveAdapterStrategy } from "open-sse/services/capacityAdapter.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { stripModelContextMarker } from "open-sse/utils/modelMarkers.js";

function isBasicChatRequest(clientRawRequest) {
  return clientRawRequest?.headers?.["x-9router-basic-chat"] === "1";
}

function attachBasicChatMetadata(response, metadata) {
  if (!response || !metadata) return response;
  const headers = new Headers(response.headers);
  headers.set("x-9router-provider", metadata.provider || "");
  headers.set("x-9router-model", metadata.model || "");
  if (metadata.requestedModel) headers.set("x-9router-requested-model", metadata.requestedModel);
  if (metadata.connectionName) headers.set("x-9router-provider-name", metadata.connectionName);
  if (metadata.apiKeyQueued) headers.set("x-9router-queue-apikey-ms", String(metadata.apiKeyWaitMs || 0));
  if (metadata.providerQueued) headers.set("x-9router-queue-provider-ms", String(metadata.providerWaitMs || 0));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null) {
  let releaseApiKey = () => {};
  let apiKeyReleased = false;
  const safeReleaseApiKey = () => {
    if (apiKeyReleased) return;
    apiKeyReleased = true;
    try { releaseApiKey(); } catch {}
  };

  if (clientRawRequest) {
    clientRawRequest._releaseApiKey = safeReleaseApiKey;
  }

  try {
    const res = await doHandleChat(request, clientRawRequest, (rel) => {
      releaseApiKey = rel;
    }, safeReleaseApiKey);

    const contentType = res?.headers?.get ? (res.headers.get("content-type") || "") : "";
    if (!contentType.includes("text/event-stream")) {
      safeReleaseApiKey();
    }
    return res;
  } catch (err) {
    safeReleaseApiKey();
    throw err;
  }
}

async function doHandleChat(request, clientRawRequest, setReleaseApiKey, safeReleaseApiKey) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    // Detect API version from path (v1/v2). Match both bare and /api-prefixed
    // paths since both /v2/chat/completions and /api/v2/chat/completions are valid.
    let apiVersion = "v1"; // default to v1
    if (url.pathname.startsWith("/v2/") || url.pathname.startsWith("/api/v2/")) {
      apiVersion = "v2";
    } else if (url.pathname.startsWith("/v1/") || url.pathname.startsWith("/api/v1/")) {
      apiVersion = "v1";
    }
    
    clientRawRequest = {
      endpoint: url.pathname,
      apiVersion,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  if (isBasicChatRequest(clientRawRequest)) clientRawRequest.responseMetadata ||= {};
  // Claude Code marks a 1M-context request as `<model>[1m]`; the marker matches
  // no combo, alias or provider/model pair, so it must not reach resolution.
  // The capability travels in the anthropic-beta header, forwarded as-is.
  const { model: modelStr, contextMarker } = stripModelContextMarker(body.model);
  if (contextMarker) body.model = modelStr;

  // Request summary is emitted as the unified "▶" line in chatCore (has fmt/thinking/account)

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    const valid = await isValidApiKey(apiKey);
    if (!valid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  // Per-API-key RPM rate limit + concurrency + queue (applies whenever a known key is presented).
  {
    const gateResult = await enforceApiKeyRateLimit(apiKey, clientRawRequest?.responseMetadata);
    if (gateResult?.limited) return gateResult.limited;
    if (gateResult?.release) {
      setReleaseApiKey(gateResult.release);
    }
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    try { releaseApiKey(); } catch {}
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  // Per-API-key RBAC: model allowlist + total-token quota.
  {
    const denied = await enforceApiKeyAccess(apiKey, modelStr);
    if (denied) {
      try { releaseApiKey(); } catch {}
      return denied;
    }
  }

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) {
    try { releaseApiKey(); } catch {}
    return bypassResponse.response || bypassResponse;
  }

  const requiredCapabilities = detectRequiredCapabilities(body);

  // Check if model is a combo (has multiple models with fallback)
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    // Check for combo-specific strategy first, fallback to global
    const comboStrategies = settings.comboStrategies || {};
    const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
    const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";
    const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, settings);
    const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

    if (comboStrategy === "fusion") {
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
      return handleFusionChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m, isPanel) => {
          let cleanRawReq = clientRawRequest;
          if (isPanel && clientRawRequest) {
            const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
            cleanRawReq = { ...clientRawRequest, body: cleanBody };
          }
          return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, modelStr);
        },
        log,
        comboName: modelStr,
        judgeModel: comboStrategies[modelStr]?.judgeModel,
        tuning: comboStrategies[modelStr]?.fusionTuning,
      });
    }

    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: augmentedModels,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, modelStr),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit
    });
  }

  // Single model request — may still switch to a capacity-adapter model if the
  // target lacks a capability the request needs (e.g. no vision, request has an image).
  const soloAugmented = augmentModelsWithCapacityAdapter([modelStr], requiredCapabilities, settings);
  if (soloAugmented.length > 1) {
    const adapterAdded = soloAugmented.filter((m) => m !== modelStr);
    log.info("CHAT", `Capacity adapter for [${[...requiredCapabilities].join(",")}] on "${modelStr}" → trying ${soloAugmented.join(", ")}`);
    return handleComboChat({
      body,
      models: soloAugmented,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, modelStr),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy: getActiveAdapterStrategy(requiredCapabilities, settings)
    });
  }

  return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey);
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, displayModel = null) {
  // The model id to REPORT to the client (response.model + footer). For combos
  // this is the combo name the caller sent, not the resolved member model.
  const reportModel = displayModel || modelStr;
  const modelInfo = await getModelInfo(modelStr);

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      const chatSettings = await getSettings();
      // Check for combo-specific strategy first, fallback to global
      const comboStrategies = chatSettings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || chatSettings.comboStrategy || "fallback";
      const requiredCapabilities = detectRequiredCapabilities(body);
      const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, chatSettings);
      const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
        return handleFusionChat({
          body,
          models: comboModels,
          handleSingleModel: (b, m, isPanel) => {
            let cleanRawReq = clientRawRequest;
            if (isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, modelStr);
          },
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: comboStrategies[modelStr]?.fusionTuning,
        });
      }

      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: augmentedModels,
        handleSingleModel: withCapacityAdapterStripping(
          (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, modelStr),
          adapterAdded
        ),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    try { releaseApiKey(); } catch {}
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;
  const responseMetadata = isBasicChatRequest(clientRawRequest)
    ? (clientRawRequest.responseMetadata ||= {})
    : null;
  if (responseMetadata) Object.assign(responseMetadata, { provider, model, requestedModel: reportModel });

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model);

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      try { releaseApiKey(); } catch {}
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    // Account selection shown in the unified "▶" line (acc:...)
    // Per-provider (per-connection) RPM and Concurrency limit + queue.
    let releaseProvider = () => {};
    const hasProviderLimits = Number(credentials.rpm) > 0 || Number(credentials.concurrency) > 0;
    if (credentials.connectionId && credentials.connectionId !== "noauth" && hasProviderLimits) {
      try {
        let queued = false;
        const startedAt = Date.now();
        const releaseFn = await acquire("provider", credentials.connectionId, {
          rpm: credentials.rpm,
          concurrency: credentials.concurrency,
          timeoutMs: credentials.queueTimeoutMs,
          onQueued: () => { queued = true; },
        });
        if (releaseFn) releaseProvider = releaseFn;
        if (responseMetadata && queued) {
          responseMetadata.providerQueued = true;
          responseMetadata.providerWaitMs = (responseMetadata.providerWaitMs || 0) + (Date.now() - startedAt);
        }
      } catch (e) {
        if (e instanceof RateLimitTimeoutError) {
          const reason = credentials.concurrency > 0 && !(credentials.rpm > 0)
            ? `[${provider}/${model}] connection ${credentials.connectionName} reached ${credentials.concurrency} max concurrency`
            : `[${provider}/${model}] connection ${credentials.connectionName} exceeded limit (${credentials.rpm} rpm / ${credentials.concurrency} concurrent)`;
          log.warn("RATELIMIT", reason);
          try { releaseApiKey(); } catch {}
          return unavailableResponse(HTTP_STATUS.RATE_LIMITED, e.message || `[${provider}/${model}] provider rate limit / concurrency exceeded`, e.retryAfter, `${e.retryAfter}s`);
        }
        try { releaseApiKey(); } catch {}
        throw e;
      }
    }
    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);
    const hasValidCred = refreshedCredentials && (refreshedCredentials.accessToken || refreshedCredentials.apiKey || refreshedCredentials.id === "noauth");
    if (!hasValidCred) {
      excludeConnectionIds.add(credentials.connectionId);
      lastError = "Failed to refresh credentials";
      try { releaseProvider(); } catch {}
      continue;
    }
    if (responseMetadata) responseMetadata.connectionName = credentials.connectionName || "";

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken, provider);
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    // Use shared chatCore
    const chatSettings = await getSettings();
    const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
    const result = await handleChatCore({
      body: { ...body, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      clientRawRequest,
      connectionId: credentials.connectionId,
      userAgent,
      apiKey,
      ccFilterNaming: !!chatSettings.ccFilterNaming,
      rtkEnabled: !!chatSettings.rtkEnabled,
      headroomEnabled: !!chatSettings.headroomEnabled,
      headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
      headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
      headroomTimeoutMs: chatSettings.headroomTimeoutMs,
      cavemanEnabled: !!chatSettings.cavemanEnabled,
      cavemanLevel: chatSettings.cavemanLevel || "full",
      ponytailEnabled: !!chatSettings.ponytailEnabled,
      ponytailLevel: chatSettings.ponytailLevel || "full",
      pxpipeEnabled: !!chatSettings.pxpipeEnabled,
      pxpipeMinChars: chatSettings.pxpipeMinChars,
      pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs,
      // Lazily warms the in-process module on first use; null when not installed (fail-open)
      pxpipeTransform: chatSettings.pxpipeEnabled ? await getPxpipeTransform() : null,
      onPxpipeEvent: appendPxpipeEvent,
      providerThinking,
      // Basic Chat renders its own footer under each reply (per-browser field
      // toggles + custom note), so injecting the server footer into the text
      // as well would show it twice. Server footer is for external API clients.
      // Footer API version scope: "v1" | "v2" | "both" (default "both").
      // Allows footer to be enabled only on /v1 or only on /v2 endpoints.
      responseFooterEnabled: !!chatSettings.responseFooterEnabled
        && !isBasicChatRequest(clientRawRequest)
        && (() => {
          const scope = chatSettings.responseFooterApiVersions || "both";
          const ver = clientRawRequest?.apiVersion || "v1";
          if (scope === "both") return true;
          return scope === ver;
        })(),
      responseFooterText: chatSettings.responseFooterText || "",
      requestedModel: reportModel,
      // Detect source format by endpoint + body
      sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
      onRelease: () => {
        try { releaseProvider(); } catch {}
        try { clientRawRequest?._releaseApiKey?.(); } catch {}
      },
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          ...newCreds,
          existingProviderSpecificData: credentials.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
        // "Consecutive" strikes: a success clears the breaker for this pair.
        clearAntigravityStrikes(credentials.connectionId, model);
      }
    });

    if (result.success) return attachBasicChatMetadata(result.response, responseMetadata);

    // Antigravity 409/429: refresh live quota to get exact resetAt before locking
    let quotaResetMs = null;
    let resetsAtMs = result.resetsAtMs;
    if (provider === "antigravity" && (result.status === 409 || result.status === 429)) {
      quotaResetMs = await handleAntigravityQuotaError(
        credentials.connectionId, result.status, model,
        refreshedCredentials.accessToken, credentials.providerSpecificData
      );
      if (quotaResetMs) resetsAtMs = quotaResetMs;
    }

    // Exhausted Antigravity model is blocked only in RAM cache until upstream resetAt.
    // Do not persist a modelLock_* for this path.
    const shouldFallback = provider === "antigravity" && quotaResetMs
      ? true
      : (await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, resetsAtMs)).shouldFallback;

    if (shouldFallback) {
      log.warn("FALLBACK", `⇄ ACC:${credentials.connectionName} UNAVAILABLE (${result.status}) → NEXT ACCOUNT`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      try { releaseProvider(); } catch {}
      continue;
    }

    try { releaseProvider(); } catch {}
    try { clientRawRequest?._releaseApiKey?.(); } catch {}
    return result.response;
  }
}
