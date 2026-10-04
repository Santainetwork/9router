import { withRequestLog } from "@/lib/requestLog.js";
import { handleTts } from "@/sse/handlers/tts.js";

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/** POST /v1/audio/speech - OpenAI-compatible TTS endpoint */
async function handlePost(request) {
  return await handleTts(request);
}

export const POST = withRequestLog("tts", handlePost);
