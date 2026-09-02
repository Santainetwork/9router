/**
 * Custom / OpenAI-compatible / Custom-Embedding Usage & Credit Check
 * 
 * Supports flexible credit check adoption strategies:
 * - "amanai": GET {baseUrl}/usage (e.g. https://api.amanai.dev/v1/usage)
 * - "newapi": GET {baseUrl}/dashboard/billing/usage
 * - "deepseek": GET {baseUrl}/user/balance
 * - "custom": custom url & json path
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { toFiniteNumber } from "./shared.js";

async function getProviderNodesSafe() {
  try {
    const { getProviderNodes } = await import("../../../src/lib/db/repos/providerNodesRepo.js");
    return await getProviderNodes();
  } catch {
    return [];
  }
}

function getBaseUrlForProvider(provider, providerSpecificData) {
  if (providerSpecificData?.baseUrl) return providerSpecificData.baseUrl;
  return null;
}

export async function getCustomCompatibleUsage(connection, proxyOptions = null) {
  const { provider, apiKey, providerSpecificData } = connection;
  if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
    return { message: "API key not available for credit check." };
  }

  // Resolve base URL
  let baseUrl = getBaseUrlForProvider(provider, providerSpecificData);
  if (!baseUrl) {
    try {
      const nodes = await getProviderNodesSafe();
      const node = nodes.find(n => n.id === provider || provider.includes(n.id) || n.provider === provider);
      if (node?.baseUrl) baseUrl = node.baseUrl;
      if (!baseUrl && node?.data) {
        const d = typeof node.data === "string" ? JSON.parse(node.data) : node.data;
        baseUrl = d.baseUrl;
      }
    } catch (e) {
      console.error("[CustomUsage] Failed to resolve node baseUrl:", e.message);
    }
  }

  // Determine credit check strategy
  let creditCheckType = providerSpecificData?.creditCheckType || "auto";

  if (creditCheckType === "auto") {
    if (baseUrl && baseUrl.includes("amanai.dev")) {
      creditCheckType = "amanai";
    } else if (baseUrl && baseUrl.includes("openrouter.ai")) {
      creditCheckType = "openrouter";
    } else if (baseUrl && baseUrl.includes("siliconflow.cn")) {
      creditCheckType = "siliconflow";
    } else if (baseUrl && (baseUrl.includes("oneapi") || baseUrl.includes("newapi") || baseUrl.includes("api.b.ai"))) {
      creditCheckType = "newapi";
    } else {
      creditCheckType = "none";
    }
  }

  if (creditCheckType === "none") {
    return {
      plan: "Custom Endpoint",
      message: "No credit check system configured for this connection.",
      quotas: {}
    };
  }

  const cleanKey = apiKey.trim();

  // 1. Amanai Strategy
  if (creditCheckType === "amanai") {
    return await fetchAmanaiCredits(baseUrl || "https://api.amanai.dev/v1", cleanKey, proxyOptions);
  }

  // 2. OpenRouter Strategy
  if (creditCheckType === "openrouter") {
    return await fetchOpenRouterCredits(cleanKey, proxyOptions);
  }

  // 3. SiliconFlow Strategy
  if (creditCheckType === "siliconflow") {
    return await fetchSiliconFlowCredits(cleanKey, proxyOptions);
  }

  // 4. NewAPI / OneAPI Strategy
  if (creditCheckType === "newapi" || creditCheckType === "oneapi") {
    return await fetchNewApiCredits(baseUrl, cleanKey, proxyOptions);
  }

  // 5. DeepSeek / User Balance Strategy
  if (creditCheckType === "deepseek" || creditCheckType === "user_balance") {
    return await fetchUserBalanceCredits(baseUrl, cleanKey, proxyOptions);
  }

  // 6. Custom URL Strategy
  if (creditCheckType === "custom" && providerSpecificData?.customCreditUrl) {
    return await fetchCustomUrlCredits(
      providerSpecificData.customCreditUrl,
      providerSpecificData?.customCreditPath || "credit_remaining",
      cleanKey,
      proxyOptions
    );
  }

  return {
    plan: "Custom",
    message: `Unknown credit check strategy: ${creditCheckType}`,
    quotas: {}
  };
}

async function fetchAmanaiCredits(baseUrl, apiKey, proxyOptions) {
  try {
    let url = baseUrl.replace(/\/+$/, "");
    if (!url.endsWith("/usage")) {
      url = url.endsWith("/v1") ? `${url}/usage` : `${url}/v1/usage`;
    }

    const res = await proxyAwareFetch(
      url,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
      },
      proxyOptions
    );

    if (res.status === 401 || res.status === 403) {
      return {
        plan: "Amanai",
        message: "Amanai authentication failed (Invalid API key).",
      };
    }

    if (!res.ok) {
      return {
        plan: "Amanai",
        message: `Amanai credit check returned status ${res.status}`,
      };
    }

    const data = await res.json().catch(() => null);
    if (!data || typeof data !== "object") {
      return { message: "Amanai credit response was not valid JSON." };
    }

    const remaining = toFiniteNumber(data.credit_remaining, 0);
    const quota = toFiniteNumber(data.credit_quota, 0);
    const used = toFiniteNumber(data.credit_used, 0);
    const isExpired = data.expired === true;
    const status = data.status || "active";

    const quotas = {};
    quotas["Credits Remaining"] = {
      used: used,
      total: quota > 0 ? quota : remaining,
      remainingPercentage: isExpired ? 0 : (quota > 0 ? Math.round((remaining / quota) * 100) : (remaining > 0 ? 100 : 0)),
      resetAt: data.expires_at || null,
      unlimited: quota === 0 && remaining > 0,
    };

    return {
      plan: isExpired ? "Amanai (Expired)" : `Amanai (${status}) - ${data.name || "Personal"}`,
      quotas,
      raw: {
        key_prefix: data.key_prefix,
        credit_remaining: remaining,
        status: data.status,
      }
    };
  } catch (err) {
    return {
      plan: "Amanai",
      message: `Amanai credit check error: ${err.message}`,
    };
  }
}

async function fetchOpenRouterCredits(apiKey, proxyOptions) {
  try {
    const res = await proxyAwareFetch(
      "https://openrouter.ai/api/v1/auth/key",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
      },
      proxyOptions
    );

    if (!res.ok) {
      return { plan: "OpenRouter", message: `OpenRouter key auth check error (${res.status})` };
    }

    const json = await res.json().catch(() => null);
    const data = json?.data || {};
    const usage = toFiniteNumber(data.usage, 0);
    const limit = data.limit !== null && data.limit !== undefined ? toFiniteNumber(data.limit, 0) : 0;
    const isFreeTier = data.is_free_tier === true;
    const label = data.label || "Key";

    const remaining = limit > 0 ? Math.max(0, limit - usage) : (isFreeTier ? 0 : 100);
    const quotas = {};
    quotas["Credits (USD)"] = {
      used: usage,
      total: limit > 0 ? limit : (limit === 0 ? usage : 0),
      remainingPercentage: limit > 0 ? Math.round((remaining / limit) * 100) : 100,
      resetAt: null,
      unlimited: limit === 0,
    };

    return {
      plan: `OpenRouter (${label})`,
      quotas,
    };
  } catch (err) {
    return { plan: "OpenRouter", message: `OpenRouter error: ${err.message}` };
  }
}

async function fetchSiliconFlowCredits(apiKey, proxyOptions) {
  try {
    const res = await proxyAwareFetch(
      "https://api.siliconflow.cn/v1/user/info",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
      },
      proxyOptions
    );

    if (!res.ok) {
      return { plan: "SiliconFlow", message: `SiliconFlow balance check error (${res.status})` };
    }

    const json = await res.json().catch(() => null);
    const data = json?.data || {};
    const total = toFiniteNumber(data.totalBalance ?? data.balance, 0);
    const charge = toFiniteNumber(data.chargeBalance, 0);

    const quotas = {};
    quotas["Balance (CNY)"] = {
      used: 0,
      total,
      remainingPercentage: total > 0 ? 100 : 0,
      resetAt: null,
      unlimited: total > 0,
    };

    return {
      plan: `SiliconFlow (${data.name || "User"})`,
      quotas,
    };
  } catch (err) {
    return { plan: "SiliconFlow", message: `SiliconFlow error: ${err.message}` };
  }
}

async function fetchNewApiCredits(baseUrl, apiKey, proxyOptions) {
  if (!baseUrl) return { message: "Base URL required for NewAPI credit check." };
  try {
    const rootUrl = baseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
    const url = `${rootUrl}/dashboard/billing/usage`;

    const res = await proxyAwareFetch(
      url,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
      },
      proxyOptions
    );

    if (!res.ok) {
      return { plan: "NewAPI / OneAPI", message: `NewAPI usage check error (${res.status})` };
    }

    const data = await res.json().catch(() => null);
    const totalGranted = toFiniteNumber(data?.total_granted, 0);
    const totalUsed = toFiniteNumber(data?.total_usage, 0);
    const totalAvailable = toFiniteNumber(data?.total_available, Math.max(0, totalGranted - totalUsed));

    const quotas = {};
    quotas["Balance (USD)"] = {
      used: totalUsed,
      total: totalGranted > 0 ? totalGranted : totalAvailable,
      remainingPercentage: totalGranted > 0 ? Math.round((totalAvailable / totalGranted) * 100) : 100,
      resetAt: null,
      unlimited: totalGranted === 0,
    };

    return {
      plan: "NewAPI / OneAPI",
      quotas,
    };
  } catch (err) {
    return { plan: "NewAPI / OneAPI", message: `NewAPI error: ${err.message}` };
  }
}

async function fetchUserBalanceCredits(baseUrl, apiKey, proxyOptions) {
  if (!baseUrl) return { message: "Base URL required for balance check." };
  try {
    const rootUrl = baseUrl.replace(/\/+$/, "");
    const url = rootUrl.endsWith("/v1") ? `${rootUrl}/user/balance` : `${rootUrl}/v1/user/balance`;

    const res = await proxyAwareFetch(
      url,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
      },
      proxyOptions
    );

    if (!res.ok) {
      return { plan: "User Balance", message: `User balance check error (${res.status})` };
    }

    const data = await res.json().catch(() => null);
    const total = toFiniteNumber(data?.total_balance ?? data?.balance ?? data?.credits, 0);
    const currency = data?.currency || "Credits";

    const quotas = {};
    quotas[`Balance (${currency})`] = {
      used: 0,
      total,
      remainingPercentage: total > 0 ? 100 : 0,
      resetAt: null,
      unlimited: total > 0,
    };

    return {
      plan: `Endpoint Balance`,
      quotas,
    };
  } catch (err) {
    return { plan: "Balance Check", message: `Error: ${err.message}` };
  }
}

async function fetchCustomUrlCredits(url, jsonPath, apiKey, proxyOptions) {
  try {
    const res = await proxyAwareFetch(
      url,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
      },
      proxyOptions
    );

    if (!res.ok) {
      return { plan: "Custom Check", message: `Custom URL returned HTTP ${res.status}` };
    }

    const data = await res.json().catch(() => null);
    let val = data;
    for (const part of jsonPath.split(".")) {
      if (val && typeof val === "object" && part in val) {
        val = val[part];
      } else {
        val = 0;
        break;
      }
    }

    const total = toFiniteNumber(val, 0);
    const quotas = {};
    quotas["Custom Quota"] = {
      used: 0,
      total,
      remainingPercentage: total > 0 ? 100 : 0,
      resetAt: null,
      unlimited: total > 0,
    };

    return {
      plan: "Custom Extractor",
      quotas,
    };
  } catch (err) {
    return { plan: "Custom Extractor", message: `Error: ${err.message}` };
  }
}
