import { withRequestLog } from "@/lib/requestLog.js";
import { handleSystemone } from "@/sse/handlers/systemone.js";

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

/**
 * POST /v1/systemone - System One (Jev) decision endpoint
 */
async function handlePost(request) {
  return await handleSystemone(request);
}

export const POST = withRequestLog("systemone", handlePost);
