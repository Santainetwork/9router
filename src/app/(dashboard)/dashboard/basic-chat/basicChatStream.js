/**
 * SSE transport helper for Basic Chat Compare mode.
 * Sends a completion request and streams response chunks independently.
 */

function readAssistantText(chunk) {
  if (!chunk || typeof chunk !== "object") return "";
  const choice = chunk.choices?.[0];
  const delta = choice?.delta || {};
  const pieces = [delta.content, choice?.message?.content, chunk.output_text, chunk.text]
    .map((value) => {
      if (typeof value === "string") return value;
      if (value == null) return "";
      if (Array.isArray(value)) return value.map(readAssistantText).filter(Boolean).join(" ");
      if (typeof value === "object") {
        if (typeof value.message === "string") return value.message;
        if (typeof value.error === "string") return value.error;
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      }
      return String(value);
    })
    .filter(Boolean);
  return pieces[0] || "";
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
  const completionTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
  const totalTokens = Number(usage.total_tokens ?? (promptTokens + completionTokens)) || 0;
  return promptTokens || completionTokens || totalTokens ? { promptTokens, completionTokens, totalTokens } : null;
}

export async function streamChatCompletion({ model, messages, apiKey = "", signal, fetchImpl = globalThis.fetch, onText = () => {} }) {
  const startedAt = Date.now();
  
  const headers = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  
  if ((apiKey || "").trim()) {
    headers.Authorization = `Bearer ${(apiKey || "").trim()}`;
  }
  
  const response = await fetchImpl("/api/dashboard/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: model.requestModel || model.id,
      messages,
      stream: true,
    }),
    signal,
  });
  
  if (!response.ok) {
    let errorData = {};
    try {
      errorData = await response.json().catch(() => ({}));
    } catch {
      // Ignore parse errors
    }
    
    const errorMessage = (errorData.error?.message || errorData.error || errorData.message || `Request failed (${response.status})`).toString();
    const err = new Error(errorMessage);
    err.statusCode = response.status;
    err.responseData = errorData;
    throw err;
  }
  
  const responseMeta = {
    provider: response.headers.get("x-9router-provider") || "",
    providerName: response.headers.get("x-9router-provider-name") || "",
    model: response.headers.get("x-9router-requested-model") || model.requestModel || model.id,
    apiKeyQueueMs: Number(response.headers.get("x-9router-queue-apikey-ms") || 0),
    providerQueueMs: Number(response.headers.get("x-9router-queue-provider-ms") || 0),
  };
  
  const reader = response.body?.getReader();
  if (!reader) {
    const data = await response.json().catch(() => ({}));
    responseMeta.usage = normalizeUsage(data?.usage);
    responseMeta.durationMs = Date.now() - startedAt;
    return {
      text: readAssistantText(data) || "",
      responseMeta,
    };
  }
  
  const decoder = new TextDecoder();
  let buffer = "";
  let accumulatedText = "";
  let usage = null;
  
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      
      try {
        const chunk = JSON.parse(payload);
        usage = normalizeUsage(chunk?.usage) || usage;
        
        const text = readAssistantText(chunk);
        if (text) {
          accumulatedText += text;
          onText(text);
        }
      } catch {
        // Ignore malformed chunks
      }
    }
  }
  
  return {
    text: accumulatedText,
    responseMeta: {
      ...responseMeta,
      usage,
      durationMs: Date.now() - startedAt,
    },
  };
}
