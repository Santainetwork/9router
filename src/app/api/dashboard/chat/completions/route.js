import { handleChat } from "@/sse/handlers/chat.js";
import { initTranslators } from "open-sse/translator/index.js";
import { getApiKeys } from "@/lib/db/repos/apiKeysRepo.js";
import { TOKEN_SAVER_HEADER } from "open-sse/config/runtimeConfig.js";

// Dashboard Basic Chat proxy. The dashboard page is already authenticated by the
// dashboard session cookie (enforced in dashboardGuard), so this reuses the same
// handleChat pipeline as /v1/chat/completions — including the RPM rate-limit gate.
//
// Basic Chat runs in the browser and has no 9router API key to send. When the
// request lacks an Authorization key we inject an active issued key server-side
// so the dashboard tool works even with requireApiKey=true, while usage and
// rate-limit still attribute to a real key.

let initialized = false;
async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
  }
}

function hasKey(request) {
  const auth = request.headers.get("authorization");
  if (auth && auth.startsWith("Bearer ") && auth.slice(7).trim()) return true;
  return !!(request.headers.get("x-api-key") || request.headers.get("x-goog-api-key"));
}

async function pickActiveApiKey() {
  try {
    const keys = await getApiKeys();
    const active = keys.find((k) => k.isActive && k.key) || keys.find((k) => k.key);
    return active?.key || null;
  } catch {
    return null;
  }
}

export async function POST(request) {
  await ensureInitialized();

  // Basic Chat is an interactive dashboard tool. Keep its prompts untouched by
  // RTK/headroom/caveman/ponytail/pxpipe while normal API traffic remains
  // governed by the global Token Saver settings.
  const headers = new Headers(request.headers);
  headers.set(TOKEN_SAVER_HEADER, "off");
  headers.set("x-9router-basic-chat", "1");
  if (!hasKey(request)) {
    const key = await pickActiveApiKey();
    if (key) headers.set("Authorization", `Bearer ${key}`);
  }

  const body = await request.arrayBuffer();
  const parsedBody = JSON.parse(new TextDecoder().decode(body));
  if (parsedBody.stream === true) {
    parsedBody.stream_options = { ...(parsedBody.stream_options || {}), include_usage: true };
  }
  const encodedBody = JSON.stringify(parsedBody);
  const req = new Request(request.url, { method: "POST", headers, body: encodedBody });
  return await handleChat(req, {
    endpoint: new URL(request.url).pathname,
    body: parsedBody,
    headers: Object.fromEntries(headers.entries()),
    responseMetadata: {},
  });
}
