import { getApiKeyByKey } from "@/lib/db/repos/apiKeysRepo.js";
import { getClientIp } from "@/lib/auth/loginLimiter";
import { requestLogStore, insertRequestLog } from "@/lib/db/repos/requestLogsRepo.js";
import { extractApiKey, maskKey } from "@/lib/requestLogUtils.js";

function clientIp(request) {
  return getClientIp(request);
}

async function peekModel(request) {
  if (request.method !== "POST") return null;
  const contentLength = request.headers.get("content-length");
  const size = Number(contentLength);
  if (contentLength == null || !Number.isFinite(size) || size > 1024 * 1024) return null;
  try {
    const body = await request.clone().json();
    return typeof body?.model === "string" ? body.model : null;
  } catch { return null; }
}

export function computeTps(completionTokens, durationMs, ttftMs, stream) {
  const generationMs = stream && durationMs > ttftMs ? durationMs - ttftMs : durationMs;
  return completionTokens && generationMs > 0 ? Math.round((completionTokens / (generationMs / 1000)) * 10) / 10 : 0;
}

export function withRequestLog(kind, handler) {
  return async (request, routeCtx) => {
    const started = Date.now();
    const rawKey = extractApiKey(request);
    const [key, model] = await Promise.all([getApiKeyByKey(rawKey).catch(() => null), peekModel(request)]);
    const context = {
      timestamp: new Date(started).toISOString(), apiKeyId: key?.id || null, apiKeyName: key?.name || null,
      apiKeyMasked: maskKey(rawKey), ip: clientIp(request), method: request.method,
      path: new URL(request.url).pathname.replace(/^\/api(?=\/v1)/, ""), endpointKind: kind, model,
      provider: null, resolvedModel: null, promptTokens: 0, completionTokens: 0, seen: new Set(), stream: false,
      userAgent: request.headers.get("user-agent")?.slice(0, 200) || null, error: null,
    };
    const finish = (status) => {
      const ended = Date.now();
      const durationMs = ended - started;
      const ttftMs = context.ttftAt ? context.ttftAt - started : durationMs;
      return insertRequestLog({ ...context, status, durationMs, ttftMs, tps: computeTps(context.completionTokens, durationMs, ttftMs, context.stream) });
    };
    let response;
    try { response = await requestLogStore.run(context, () => handler(request, routeCtx)); }
    catch (error) { context.error = "Request handler failed"; await finish(500); throw error; }
    const status = response?.status || 0;
    context.stream = (response?.headers?.get("content-type") || "").includes("text/event-stream");
    if (status >= 400) context.error = `HTTP ${status}`;
    if (!response?.body) { await finish(status); return response; }
    let done = false;
    const complete = (code) => { if (!done) { done = true; void finish(code); } };
    const reader = response.body.getReader();
    const tap = new ReadableStream({
      async pull(controller) {
        try {
          const result = await reader.read();
          if (result.done) {
            complete(status);
            reader.releaseLock();
            controller.close();
          } else {
            if (!context.ttftAt) context.ttftAt = Date.now();
            controller.enqueue(result.value);
          }
        } catch (error) {
          context.error ||= "Response stream failed";
          complete(status || 500);
          controller.error(error);
        }
      },
      async cancel(reason) {
        context.error ||= "Client disconnected";
        complete(status === 200 ? 499 : status);
        try { await reader.cancel(reason); } catch {}
      },
    });
    return new Response(tap, { status, statusText: response.statusText, headers: response.headers });
  };
}
