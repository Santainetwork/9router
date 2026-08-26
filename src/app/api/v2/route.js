/**
 * V2 API Gateway Router
 * Accepts v2-format requests and routes them to appropriate v1 handlers
 */

import { handleChat } from "@/sse/handlers/chat.js";

// Handle CORS preflight
export async function OPTIONS(request) {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

// GET /v2 - returns v2 API information
export async function GET() {
  return Response.json({
    version: "v2",
    description: "9Router V2 API - Configurable Token Saver Support",
    endpoints: {
      "POST /v2/chat/completions": "Chat completions with customizable token saver settings",
      "GET /v2/models": "Get available models"
    },
    token_saver_config: {
      description: "Use 'token_saver_config' field in request body to control token savers",
      fields: {
        enabled: "boolean - disable ALL token savers if false",
        rtk: "boolean - RTK compression",
        headroom: "boolean - Headroom proxy compression",
        caveman: "boolean/intensity level - Inject terse system prompts",
        ponytail: "boolean/intensity level - Inject lazy-dev system prompts",
        pxpipe: "boolean - PXPIPE image context compression"
      }
    }
  }, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json"
    }
  });
}
