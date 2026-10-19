import { DefaultExecutor } from "./default.js";
import { randomUUID, createHash } from "node:crypto";

/**
 * CodeBuddyIntlExecutor — talks to https://www.codebuddy.ai/v2/chat/completions
 *
 * Same OpenAI-compatible-but-stream-only gateway behavior as codebuddy-cn:
 * non-stream requests are rejected, and reasoning is surfaced only when the
 * request carries the IDE's OpenAI-style reasoning params. Force stream and
 * mirror reasoning_summary exactly like CodeBuddyExecutor.
 *
 * Since 2026-10-15 the intl gateway enforces channel verification: any chat
 * request missing the X-Conversation-* header family is refused with 400 / code
 * 11128 regardless of credentials. All three headers are required; two of them
 * still fail. See decolua/9router#5005. The CN gateway has no such gate.
 */
export class CodeBuddyIntlExecutor extends DefaultExecutor {
  constructor() {
    super("codebuddy-intl");
  }

  // Stable per-conversation id, derived deterministically so retries of the same
  // turn (and account failovers) reuse one id, as the official client does.
  _conversationId(credentials, body) {
    const seed = body?.session_id || body?.prompt_cache_key || body?.conversation_id
      || (Array.isArray(body?.messages)
        ? JSON.stringify(body.messages.find((m) => m && m.role === "user") || body.messages[0] || "")
        : "");
    const key = `${credentials?.connectionId || credentials?.apiKey || ""}|${seed}`;
    return createHash("sha256").update(key).digest("hex").slice(0, 32);
  }

  buildHeaders(credentials, stream = true, url = null, model = null, body = null) {
    const headers = super.buildHeaders(credentials, stream, url, model, body);
    if (!headers || typeof headers !== "object") {
      throw new Error("codebuddy-intl: buildHeaders returned no header bag; X-Conversation-* gate would refuse the request");
    }

    // Case-insensitive lookup: a caller (or provider override) that already set
    // one of these must be honoured, not duplicated (undici comma-joins dups).
    const has = (name) => {
      const lower = name.toLowerCase();
      return Object.keys(headers).some((k) => k.toLowerCase() === lower);
    };

    if (!has("X-Conversation-ID")) headers["X-Conversation-ID"] = this._conversationId(credentials, body);
    // Per-request ids; X-Request-ID mirrors the message id, as the official client sends it.
    const messageId = randomUUID();
    if (!has("X-Conversation-Request-ID")) headers["X-Conversation-Request-ID"] = randomUUID();
    if (!has("X-Conversation-Message-ID")) headers["X-Conversation-Message-ID"] = messageId;
    if (!has("X-Request-ID")) headers["X-Request-ID"] = messageId;

    return headers;
  }

  transformRequest(model, body, stream, credentials) {
    const transformed = super.transformRequest(model, body, stream, credentials);
    transformed.stream = true;

    const eff = transformed.reasoning_effort;
    if (eff === "none" || eff === "off") {
      delete transformed.reasoning_effort;
    } else if (eff) {
      transformed.reasoning_summary = "auto";
    }

    // CodeBuddy rejects plain OpenAI shape (11101 invalid request): needs a
    // leading system prompt + user content as typed blocks, not a bare string.
    const source = Array.isArray(transformed.messages) ? transformed.messages : [];
    transformed.messages = [{ role: "system", content: "You are CodeBuddy Code." }];
    for (const message of source) {
      if (!message || typeof message !== "object" || ["system", "developer"].includes(message.role)) continue;
      if (message.role === "user" && typeof message.content === "string") {
        transformed.messages.push({ ...message, content: [{ type: "text", text: message.content }] });
      } else {
        transformed.messages.push({ ...message });
      }
    }

    return transformed;
  }
  parseError(response, bodyText) {
    if (bodyText) {
      try {
        const data = JSON.parse(bodyText);
        const msg = data?.msg || data?.message || data?.error?.message || "";
        if (data?.code === 6004 || /超出频率限制|frequency limit|限额/i.test(msg)) {
          let resetsAtMs = null;
          const match = msg.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})(?:\s*UTC\+?([0-9:]+))?/i);
          if (match) {
            const dp = match[1];
            const tp = match[2];
            const tz = match[3]
              ? (match[3].includes(":") ? (match[3].startsWith("+") ? match[3] : `+${match[3]}`) : `+${match[3].padStart(2, "0")}:00`)
              : "+08:00";
            const dt = new Date(`${dp}T${tp}${tz}`);
            if (!isNaN(dt.getTime())) resetsAtMs = dt.getTime();
          }
          return {
            status: 429,
            message: msg || "CodeBuddy frequency limit (6004)",
            resetsAtMs,
          };
        }
      } catch {}
    }
    return super.parseError(response, bodyText);
  }
}

export default CodeBuddyIntlExecutor;
