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

  // Stable per-conversation id. Only an explicit client session may join turns:
  // hashing the message text would collide two different conversations that
  // happen to share a prompt, and would join them upstream. Without an explicit
  // session, generate a fresh id per request instead of guessing.
  // See decolua/9router#5086 for the same reasoning.
  _conversationId(credentials, body) {
    const sessionSeed = body?.session_id || body?.prompt_cache_key || body?.conversation_id || "";
    if (!sessionSeed) return randomUUID();
    const key = `${credentials?.connectionId || credentials?.apiKey || ""}|${sessionSeed}`;
    return createHash("sha256").update(key).digest("hex").slice(0, 32);
  }

  buildHeaders(credentials, stream = true, url = null, model = null, body = null) {
    const headers = super.buildHeaders(credentials, stream, url, model, body);
    if (!headers || typeof headers !== "object") {
      throw new Error("codebuddy-intl: buildHeaders returned no header bag; X-Conversation-* gate would refuse the request");
    }

    // Case-insensitive helpers. The registry hook (codebuddyHeaders) has
    // already seeded random ids by the time this runs, so "is it present" is
    // never the question: every value below is decided here, with the caller's
    // provider override winning when it supplied one.
    const raw = credentials?.rawHeaders || {};
    const callerValue = (name) => {
      const value = typeof raw.get === "function"
        ? raw.get(name)
        : raw[Object.keys(raw).find((k) => k.toLowerCase() === name.toLowerCase()) || ""];
      return typeof value === "string" && value.trim() ? value.trim() : null;
    };
    const set = (name, value) => {
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
      }
      headers[name] = value;
    };

    // A stable conversation id per client session is the fork contract: without
    // it multi-turn requests look like separate conversations upstream, and
    // hashing message text would join unrelated ones (decolua/9router#5086).
    set("X-Conversation-ID", callerValue("X-Conversation-ID") || this._conversationId(credentials, body));
    // Per-request ids; X-Request-ID mirrors the message id, as the official client sends it.
    const messageId = randomUUID();
    set("X-Conversation-Request-ID", callerValue("X-Conversation-Request-ID") || randomUUID());
    set("X-Conversation-Message-ID", callerValue("X-Conversation-Message-ID") || messageId);
    set("X-Request-ID", callerValue("X-Request-ID") || messageId);

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

    // Tencent WAF flags third-party CLI agent identity strings (Claude Code, Cursor, etc.)
    // as unauthorized tooling / prompt injection and rejects/bans the account.
    // Neutralize only matching agent markers while preserving user system prompts.
    const NEUTRAL_PROMPT = "You are a helpful AI assistant that helps with software engineering tasks.";
    const AGENT_PATTERN = /you are claude code|claude.?code.+official.+cli|anthropic.+official.+cli|anxthxropic.+official.+cli|you are (?:cursor|windsurf|cline|aider|continue|copilot|cody)|you are an? (?:ai )?(?:coding |code )?agent|cc_entrypoint\s*=\s*(?:cli|vscode|jetbrains|gui)|claude.?code.+issues|give feedback.+claude.?code|you are .{0,30}(?:powerful )?ai agent|orchestration capabilities|OhMyOpenCode|<agent-identity>|<Role>|<Behavior_Instructions>/i;

    // CodeBuddy rejects plain OpenAI shape (11101 invalid request): needs a
    // leading system prompt + user content as typed blocks, not a bare string.
    const source = Array.isArray(transformed.messages) ? transformed.messages : [];
    const clientSystemPrompts = source
      .filter((m) => m && ["system", "developer"].includes(m.role))
      .map((m) => {
        const text =
          typeof m.content === "string"
            ? m.content
            : Array.isArray(m.content)
              ? m.content.map((c) => c?.text || "").join("\n")
              : "";
        if (text && AGENT_PATTERN.test(text)) {
          return NEUTRAL_PROMPT;
        }
        return text;
      })
      .filter(Boolean);

    const systemPromptText =
      clientSystemPrompts.length > 0
        ? clientSystemPrompts.join("\n\n")
        : "You are CodeBuddy Code.";

    transformed.messages = [{ role: "system", content: systemPromptText }];
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
