// Server-side response footer: appends a short footer to the assistant's reply
// TEXT so it shows up for every API client (Jcode, SDKs, curl…), not just the
// dashboard. Gated by settings.responseFooterEnabled (default off).
//
// Supported template tokens in responseFooterText:
//   {provider} {model} {requestedModel}
//   {promptTokens} {completionTokens} {totalTokens} {durationMs} {durationS}

export function renderFooterText(template, ctx = {}) {
  if (!template) return "";
  const usage = ctx.usage || {};
  const prompt = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
  const completion = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
  const total = Number(usage.total_tokens ?? (prompt + completion)) || 0;
  const durationMs = Number(ctx.durationMs || 0) || 0;
  const map = {
    provider: ctx.provider || "",
    model: ctx.requestedModel || ctx.model || "",
    requestedModel: ctx.requestedModel || ctx.model || "",
    promptTokens: String(prompt),
    completionTokens: String(completion),
    totalTokens: String(total),
    durationMs: String(durationMs),
    durationS: (durationMs / 1000).toFixed(1) + "s",
  };
  return String(template).replace(/\{(\w+)\}/g, (m, k) => (k in map ? map[k] : m));
}

export function hasFooterSignature(text) {
  if (!text || typeof text !== "string") return false;
  return /(?:---\s*\r?\n\s*(?:by SantaiNetwork|via 9Router|_via 9Router_)|by SantaiNetwork\s*·|\bvia 9Router\b)/i.test(text);
}

export function stripFooterFromText(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(/(?:\r?\n)+---\s*(?:\r?\n)+\s*(?:by SantaiNetwork|via 9Router|_via 9Router_)[^\r\n]*/gi, "")
    .replace(/(?:\r?\n)+by SantaiNetwork\s*·[^\r\n]*/gi, "")
    .trimEnd();
}

export function stripFootersFromMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((m) => {
    if (m && m.role === "assistant" && typeof m.content === "string") {
      return { ...m, content: stripFooterFromText(m.content) };
    }
    return m;
  });
}

// Append footer text to an OpenAI-format chat.completion body's assistant text.
// Only touches string content on a normal stop; leaves tool_calls untouched.
export function appendFooterToOpenAIBody(body, footer) {
  if (!footer || !body?.choices?.length) return body;
  for (const choice of body.choices) {
    const msg = choice?.message;
    if (!msg) continue;
    // Don't corrupt tool-call turns — only append to plain text replies.
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) continue;
    if (typeof msg.content === "string") {
      if (!hasFooterSignature(msg.content) && !msg.content.endsWith(footer)) {
        msg.content = (msg.content || "") + footer;
      }
    }
  }
  return body;
}

// Append footer to a Claude-format message body (content is an array of blocks).
export function appendFooterToClaudeBody(body, footer) {
  if (!footer || !Array.isArray(body?.content)) return body;
  const hasToolUse = body.content.some((b) => b?.type === "tool_use");
  if (hasToolUse) return body;
  // Append to the last text block, or add one.
  for (let i = body.content.length - 1; i >= 0; i--) {
    if (body.content[i]?.type === "text") {
      if (typeof body.content[i].text === "string") {
        if (!hasFooterSignature(body.content[i].text) && !body.content[i].text.endsWith(footer)) {
          body.content[i].text = (body.content[i].text || "") + footer;
        }
      }
      return body;
    }
  }
  body.content.push({ type: "text", text: footer });
  return body;
}

// Wrap an OpenAI-format SSE ReadableStream so a single content-delta chunk
// carrying the footer text is emitted just before the stream's terminal event.
// The footer TEXT is rendered lazily at inject time so it can include usage
// (token counts) which only arrive in the final chunk. Pass a template string +
// base ctx (provider/model/…); usage is captured from the stream.
// Terminal = finish_reason chunk and/or `data: [DONE]` (some upstreams omit
// [DONE]); injected before whichever comes first, or at flush() as a last resort.
// Tool-call turns are suppressed. Fail-open: malformed bytes pass through.
export function wrapOpenAIStreamWithFooter(readable, template, baseCtx = {}) {
  if (!template) return readable;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawToolCalls = false;
  let injected = false;
  let capturedUsage = null;
  let terminated = false;
  let streamedContent = "";

  const footerChunk = () => {
    const text = renderFooterText(template, { ...baseCtx, usage: capturedUsage || baseCtx.usage });
    if (!text) return "";
    return "data: " + JSON.stringify({
      id: "chatcmpl-footer-" + Date.now(),
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    }) + "\n\n";
  };

  // Pull usage out of a data payload if present (finish chunk or usage-only chunk).
  const captureUsage = (payload) => {
    if (capturedUsage || !payload.includes('"usage"')) return;
    try {
      const obj = JSON.parse(payload);
      if (obj && obj.usage && typeof obj.usage === "object") capturedUsage = obj.usage;
    } catch { /* ignore */ }
  };

  const captureContent = (payload) => {
    if (!payload || payload[0] !== "{") return;
    try {
      const obj = JSON.parse(payload);
      for (const choice of obj?.choices || []) {
        const content = choice?.delta?.content;
        if (typeof content === "string") streamedContent += content;
      }
    } catch { /* ignore */ }
  };

  // Does this SSE data line carry a terminal signal (finish_reason set, or [DONE])?
  const isTerminalLine = (line) => {
    const t = line.trim();
    if (!t.startsWith("data:")) return false;
    const payload = t.slice(5).trim();
    if (payload === "[DONE]") return true;
    if (payload.includes('"tool_calls"') || /"finish_reason"\s*:\s*"tool_calls"/.test(payload)) {
      sawToolCalls = true;
      return false;
    }
    captureUsage(payload);
    // finish_reason present and non-null (excluding tool_calls) → last content-bearing chunk.
    return /"finish_reason"\s*:\s*"(stop|length|content_filter)"/.test(payload);
  };

  const emitFooter = (controller) => {
    if (injected) return;
    injected = true;
    if (sawToolCalls) return;
    // If the stream already emitted a SantaiNetwork/9Router footer, do not inject duplicate!
    if (hasFooterSignature(streamedContent)) return;
    const chunk = footerChunk();
    const text = renderFooterText(template, { ...baseCtx, usage: capturedUsage || baseCtx.usage });
    if (chunk && !streamedContent.endsWith(text)) controller.enqueue(encoder.encode(chunk));
  };

  const transform = new TransformStream({
    transform(chunk, controller) {
      try {
        if (terminated) return; // drop anything after the first [DONE]
        buffer += decoder.decode(chunk, { stream: true });
        if (!sawToolCalls && buffer.includes('"tool_calls"')) sawToolCalls = true;

        let idx;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx + 1);
          buffer = buffer.slice(idx + 1);
          if (line.trimStart().startsWith("data:")) captureContent(line.trim().slice(5).trim());
          const isDone = line.trim() === "data: [DONE]";
          if (isDone) {
            // Ensure the footer lands before the terminal, then emit exactly one
            // [DONE] and stop — some paths (combo/fallback) emit several, which
            // makes clients treat the reply as multiple segments (and appear to
            // repeat the footer). Collapse them here.
            if (!injected) emitFooter(controller);
            controller.enqueue(encoder.encode(line));
            terminated = true;
            buffer = "";
            return;
          }
          if (!injected && isTerminalLine(line)) emitFooter(controller);
          controller.enqueue(encoder.encode(line));
        }
      } catch {
        controller.enqueue(chunk);
      }
    },
    flush(controller) {
      if (terminated) return;
      if (buffer) {
        if (!injected && isTerminalLine(buffer)) emitFooter(controller);
        controller.enqueue(encoder.encode(buffer));
      }
      // Last resort: stream ended with no recognizable terminal line.
      emitFooter(controller);
    },
    cancel(reason) {
      try { readable.cancel(reason); } catch {}
    },
  });

  return readable.pipeThrough(transform);
}

// Rewrite the `model` field in each OpenAI SSE chunk to the requested model id
// (what the client addressed), instead of the upstream provider-side id. Applied
// independently of the footer so the reported model is consistent everywhere.
// Fail-open: malformed lines pass through untouched.
export function rewriteStreamModel(readable, requestedModel) {
  if (!requestedModel) return readable;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";

  const rewriteLine = (line) => {
    const t = line.trimStart();
    if (!t.startsWith("data:")) return line;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]" || payload[0] !== "{") return line;
    try {
      const obj = JSON.parse(payload);
      if (obj && typeof obj === "object" && "model" in obj) {
        obj.model = requestedModel;
        const nl = line.endsWith("\n") ? "\n" : "";
        return "data: " + JSON.stringify(obj) + nl;
      }
    } catch { /* pass through */ }
    return line;
  };

  const transform = new TransformStream({
    transform(chunk, controller) {
      try {
        buffer += decoder.decode(chunk, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx + 1);
          buffer = buffer.slice(idx + 1);
          controller.enqueue(encoder.encode(rewriteLine(line)));
        }
      } catch {
        controller.enqueue(chunk);
      }
    },
    flush(controller) {
      if (buffer) controller.enqueue(encoder.encode(rewriteLine(buffer)));
    },
    cancel(reason) {
      try { readable.cancel(reason); } catch {}
    },
  });

  return readable.pipeThrough(transform);
}


import { redactProviderFooterText, detectProviderFooter as detectGenericFooter } from "../../../src/shared/utils/providerFooter.js";

// Provider self-branding / referral lines some upstreams inject into replies.
// Return the matched provider-footer snippet from a reply text, or null.
export function detectProviderFooter(text) {
  return detectGenericFooter(text);
}

// Scan a reply and log (once) if the provider embedded its own footer/referral.
// Non-fatal, fail-open. `emit` is a (tag, icon, msg) logger like log.line.
// Also persists logs to database for dashboard monitoring.
export function logProviderFooter({ text, provider, model, reqTag, emit }) {
  try {
    const hit = detectProviderFooter(text);
    if (hit && typeof emit === "function") {
      emit(reqTag, "🏷️", `[provider-footer] ${provider}/${model} embedded: ${JSON.stringify(hit)}`);
    }
    
    // Persist to database if footer detected
    if (hit) {
      // Use dynamic import to avoid circular dependencies
      import("../../../src/lib/db/repos/providerFooterLogsRepo.js")
        .then(({ addProviderFooterLog }) => {
          return addProviderFooterLog(provider, model, redactProviderFooterText(hit), new Date().toISOString());
        })
        .catch((dbError) => {
          // Don't fail the request if DB logging fails
          console.warn("[ProviderFooterLog] Failed to persist log:", dbError.message);
        });
    }
    
    return hit;
  } catch {
    return null;
  }
}
