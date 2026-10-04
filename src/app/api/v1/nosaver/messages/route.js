import { withRequestLog } from "@/lib/requestLog.js";
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

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

async function handlePost(request) {
  try {
    await ensureInitialized();

    const bodyText = await request.text();
    let body = {};
    try {
      body = JSON.parse(bodyText);
    } catch {
      return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
    }

    // Force turn off ALL token savers (headroom, caveman, ponytail, rtk, pxpipe)
    const headers = new Headers(request.headers);
    headers.set(TOKEN_SAVER_HEADER, "off");

    const reconstructedRequest = new Request(request.url, {
      method: request.method,
      headers,
      body: bodyText,
      redirect: request.redirect,
      signal: request.signal
    });

    const v1Headers = Object.fromEntries(reconstructedRequest.headers.entries());

    // Pass apiVersion: "v1" so response footer adheres to /v1 footer settings
    return await handleChat(reconstructedRequest, {
      endpoint: new URL(request.url).pathname,
      apiVersion: "v1",
      body,
      headers: v1Headers
    });
  } catch (e) {
    console.error("Error in v1/nosaver/messages:", e.message);
    return errorResponse(HTTP_STATUS.INTERNAL_SERVER_ERROR, e.message);
  }
}

export const POST = withRequestLog("chat", handlePost);
