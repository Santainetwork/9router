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
    // Global toggle - when false, disables ALL savers
    allEnabled: true
  };
  
  // Handle global enabled flag first
  if (config.enabled !== undefined && typeof config.enabled === "boolean") {
    parsed.allEnabled = config.enabled;
  }
  
  // Per-feature overrides
  const features = [
    { name: "rtk", default: true },
    { name: "headroom", default: true },
    { name: "caveman", default: true },
    { name: "ponytail", default: true },
    { name: "pxpipe", default: true }
  ];
  
  for (const feature of features) {
    if (config[feature.name] !== undefined) {
      // Accept boolean or string level
      const value = config[feature.name];
      if (typeof value === "boolean") {
        parsed[feature.name] = value;
      } else if (typeof value === "string" && ["full", "minimal", "off"].includes(value)) {
        parsed[feature.name] = value;
      } else {
        parsed[feature.name] = true; // Default if invalid
      }
    }
  }
  
  return parsed;
}

/**
 * Build header override string based on parsed config
 * Returns comma-separated list of disabled features or 'all'
 */
function buildDisabledFeaturesHeader(config) {
  if (!config || !config.allEnabled) {
    return "all";
  }
  
  // Find explicitly disabled features
  const features = ["rtk", "headroom", "caveman", "ponytail", "pxpipe"];
  const disabled = [];
  
  for (const feature of features) {
    if (config[feature] === false || config[feature] === "off") {
      disabled.push(feature);
    }
  }
  
  return disabled.length > 0 ? disabled.join(",") : null;
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
 * POST /v2/chat/completions - Chat completions with customizable token saver settings
 * 
 * Accepts standard chat completion request body plus optional 'token_saver_config' field.
 * 
 * Example 1 - Disable all savers:
 * {
 *   "model": "anthropic/claude-sonnet-4",
 *   "messages": [{"role": "user", "content": "Hello"}],
 *   "token_saver_config": {
 *     "enabled": false
 *   }
 * }
 * 
 * Example 2 - Selective disable (disable specific features):
 * {
 *   "model": "anthropic/claude-sonnet-4",
 *   "messages": [{"role": "user", "content": "Hello"}],
 *   "token_saver_config": {
 *     "enabled": true,          // Keep global enabled
 *     "caveman": false,         // Disable only Caveman
 *     "ponytail": false         // Disable only Ponytail
 *   }
 * }
 * 
 * Example 3 - Full configuration control:
 * {
 *   "model": "anthropic/claude-sonnet-4",
 *   "messages": [{"role": "user", "content": "Hello"}],
 *   "token_saver_config": {
 *     "enabled": true,
 *     "rtk": true,              // RTK compression
 *     "headroom": false,        // No Headroom proxy
 *     "caveman": "minimal",     // Minimal cavity injection
 *     "ponytail": true,         // Enable Ponytail
 *     "pxpipe": false           // No image compression
 *   }
 * }
 * 
 * When token_saver_config is NOT provided, behavior follows global dashboard settings.
 */
export async function POST(request) {
  await ensureInitialized();

  try {
    // First pass: check for custom config
    const bodyText = await request.text();
    const body = JSON.parse(bodyText);
    
    // Log usage pattern
    console.log("V2 API:", JSON.stringify({
      action: body?.token_saver_config ? "using_custom_token_saver_config" : "using_global_settings",
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
    
    // No custom config - reconstruct and pass through normally
    const reconstructedRequest = new Request(request.url, {
      method: request.method,
      headers: request.headers,
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
