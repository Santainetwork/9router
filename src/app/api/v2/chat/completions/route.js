import { handleChat } from "@/sse/handlers/chat.js";
import { HTTP_STATUS, TOKEN_SAVER_HEADER } from "open-sse/config/runtimeConfig.js";
import { errorResponse } from "open-sse/utils/error.js";
import { initTranslators } from "open-sse/translator/index.js";

let initialized = false;

async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
  }
}

/**
 * Parse and validate token_saver_config from request body
 * Returns object with boolean values for each feature
 */
function parseTokenSaverConfig(body) {
  const config = body?.token_saver_config;
  
  if (!config || typeof config !== "object") {
    return null;
  }
  
  const parsed = {
    // Global toggle - when false or not set, disables ALL savers
    allEnabled: false
  };
  
  // Handle global enabled flag first - only enable if explicitly true
  if (config.enabled === true) {
    parsed.allEnabled = true;
  }
  // Note: enabled: false or undefined means disabled (default)
  
  // Per-feature overrides (only applied when allEnabled is true)
  const features = [
    { name: "rtk", default: false },
    { name: "headroom", default: false },
    { name: "caveman", default: false },
    { name: "ponytail", default: false },
    { name: "pxpipe", default: false }
  ];
  
  for (const feature of features) {
    if (config[feature.name] !== undefined) {
      // Accept boolean or string level
      const value = config[feature.name];
      if (typeof value === "boolean") {
        parsed[feature.name] = value;
      } else if (typeof value === "string" && ["full", "minimal"].includes(value)) {
        parsed[feature.name] = value;
      } else if (value === false) {
        parsed[feature.name] = false;
      } else if (value === true) {
        parsed[feature.name] = true;
      }
    }
  }
  
  return parsed;
}

/**
 * Build header override based on parsed config
 * Returns "off" when savers should be disabled, null when using global settings
 */
function buildDisabledFeaturesHeader(config) {
  // Default behavior: NO SAVERS unless explicitly enabled
  if (!config || !config.allEnabled) {
    return "off"; // Disable ALL token savers
  }
  
  // Find explicitly disabled features (when enabled:true but some features disabled)
  const features = ["rtk", "headroom", "caveman", "ponytail", "pxpipe"];
  const disabled = [];
  
  for (const feature of features) {
    if (config[feature] === false || config[feature] === "off") {
      disabled.push(feature);
    }
  }
  
  // If any features are explicitly disabled, we need custom header handling
  // But engine only understands "off" for total disable, so we use "off" for now
  // TODO: Extend chatCore to support per-feature disabling in future
  return disabled.length > 0 ? "off" : null; // Use "off" when partial disables requested
}

/**
 * Create modified request with proper headers for token savers
 */
async function createTokenSaverRequest(request, config) {
  const body = await request.json();
  
  // Check if we need header override
  const disabledFeatures = buildDisabledFeaturesHeader(config);
  
  let modifiedRequest = request;
  
  if (disabledFeatures) {
    console.log("V2 API:", JSON.stringify({
      action: "applying_token_saver_disables",
      disabled_features: disabledFeatures,
      model: body?.model
    }));
    
    const headers = new Headers(request.headers);
    
    // Use existing header mechanism
    headers.set(TOKEN_SAVER_HEADER, disabledFeatures);
    
    // Reconstruct request with consumed body
    modifiedRequest = new Request(request.url, {
      method: request.method,
      headers,
      body: JSON.stringify(body),
      redirect: request.redirect,
      signal: request.signal
    });
  }
  
  return modifiedRequest;
}

/**
 * POST /v2/chat/completions - Chat completions WITHOUT token savers by default
 * 
 * Accepts standard chat completion request body plus optional 'token_saver_config' field.
 * By DEFAULT (when no config provided): ALL token savers are DISABLED for clean baseline responses.
 * 
 * Example 1 - Default behavior (NO SAVERS):
 * {
 *   "model": "anthropic/claude-sonnet-4",
 *   "messages": [{"role": "user", "content": "Hello"}]
 * }
 * // Result: NO token savers applied - completely raw response
 * 
 * Example 2 - Opt-in to token savers (enabled: true):
 * {
 *   "model": "anthropic/claude-sonnet-4",
 *   "messages": [{"role": "user", "content": "Hello"}],
 *   "token_saver_config": {
 *     "enabled": true  // Enable global dashboard token saver settings
 *   }
 * }
 * // Result: Token savers follow dashboard global settings
 * 
 * Example 3 - Selective enable with specific features:
 * {
 *   "model": "anthropic/claude-sonnet-4",
 *   "messages": [{"role": "user", "content": "What is AI?"}],
 *   "token_saver_config": {
 *     "enabled": true,
 *     "rtk": true,              // ✅ Use RTK compression
 *     "headroom": false,        // ❌ No Headroom proxy  
 *     "caveman": "minimal"      // 💬 Minimal brevity injection
 *   }
 * }
 * // Note: When enabled:true, per-feature flags honor dashboard settings.
 * // Partial disables still use "off" header until engine supports per-feature control.
 * 
 * IMPORTANT: The default behavior (no config) is to disable all savers for clean baseline output.
 */
export async function POST(request) {
  await ensureInitialized();

  try {
    // First pass: check for custom config
    const bodyText = await request.text();
    const body = JSON.parse(bodyText);
    
    // Log usage pattern - now defaults to NO SAVERS unless enabled:true
    console.log("V2 API:", JSON.stringify({
      action: body?.token_saver_config ? "using_custom_token_saver_config" : "default_no_savers",
      has_custom_config: body?.token_saver_config !== undefined,
      model: body?.model
    }));
    
    // Parse and apply custom token saver config
    if (body?.token_saver_config) {
      const config = parseTokenSaverConfig(body);
      
      if (config) {
        const modifiedRequest = await createTokenSaverRequest(
          new Request(request.url, {
            method: request.method,
            headers: request.headers,
            body: bodyText,
            redirect: request.redirect,
            signal: request.signal
          }),
          config
        );
        
        return await handleChat(modifiedRequest);
      }
    }
    
    // No custom config - disable ALL token savers for clean baseline output.
    // V2 default: "bener-bener tanpa saver" unless explicitly opted in.
    const headers = new Headers(request.headers);
    headers.set(TOKEN_SAVER_HEADER, "off");
    const reconstructedRequest = new Request(request.url, {
      method: request.method,
      headers,
      body: bodyText,
      redirect: request.redirect,
      signal: request.signal
    });

    return await handleChat(reconstructedRequest);
    
  } catch (e) {
    console.error("Error in v2/chat/completions:", e.message);
    return errorResponse(HTTP_STATUS.INTERNAL_SERVER_ERROR, e.message);
  }
}

export async function GET(request) {
  const { GET: modelsGet } = await import("@/app/api/v1/models/route");
  return await modelsGet(request);
}
