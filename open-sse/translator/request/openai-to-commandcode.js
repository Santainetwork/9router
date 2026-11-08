/**
 * OpenAI → CommandCode request translator
 *
 * Upstream `/alpha/generate` schema (verified live with curl 2026-05-07):
 *  - params.system: STRING at top level (Anthropic-style; system messages NOT allowed in messages[])
 *  - params.messages[*].role ∈ {"user","assistant","tool"}
 *  - params.messages[*].content: Array of content blocks (NEVER a string)
 *  - image_url / image source → {type:"image", image:"data:...;base64,...", mimeType}
 *  - tool_use blocks (assistant): {type:"tool-call", toolCallId, toolName, input}
 *  - tool_result blocks (role=user): {type:"tool-result", toolCallId, toolName, output}
 *  - tools[*]: Anthropic plain {name, description, input_schema}
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { ROLE, OPENAI_BLOCK, CLAUDE_BLOCK } from "../schema/index.js";
import { COMMAND_CODE_WORKING_DIR, toCommandCodeSessionUuid } from "../../shared/commandCodeHeaders.js";
import { DEFAULT_MAX_TOKENS } from "../../config/runtimeConfig.js";
import { parseDataUri, encodeDataUri } from "../concerns/image.js";
import { stripThinkingSuffix } from "../concerns/thinkingUnified.js";

function flattenText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const p of content) {
      if (typeof p === "string") parts.push(p);
      else if (p && typeof p === "object" && typeof p.text === "string") parts.push(p.text);
    }
    return parts.join("\n");
  }
  return String(content);
}

function toNativeImageBlock(part) {
  if (!part || typeof part !== "object") return null;

  if (part.type === OPENAI_BLOCK.IMAGE_URL) {
    const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
    const parsed = parseDataUri(url);
    if (!parsed) return null;
    return {
      type: OPENAI_BLOCK.IMAGE,
      image: encodeDataUri(parsed.mimeType, parsed.base64),
      mimeType: parsed.mimeType,
      mediaType: parsed.mimeType,
    };
  }

  if (part.type === OPENAI_BLOCK.IMAGE || part.type === CLAUDE_BLOCK.IMAGE) {
    if (typeof part.image === "string" && part.image.startsWith("data:")) {
      const parsed = parseDataUri(part.image);
      const mime = part.mimeType || parsed?.mimeType || "image/png";
      return {
        type: OPENAI_BLOCK.IMAGE,
        image: part.image,
        mimeType: mime,
        mediaType: mime,
      };
    }
    const source = part.source;
    if (source?.type === "base64" && typeof source.data === "string") {
      const mime = source.media_type || "image/png";
      return {
        type: OPENAI_BLOCK.IMAGE,
        image: encodeDataUri(mime, source.data),
        mimeType: mime,
        mediaType: mime,
      };
    }
  }

  return null;
}

function toContentBlocks(content) {
  if (content == null) return [{ type: OPENAI_BLOCK.TEXT, text: "" }];
  if (typeof content === "string") return [{ type: OPENAI_BLOCK.TEXT, text: content }];
  if (Array.isArray(content)) {
    const blocks = [];
    for (const part of content) {
      if (typeof part === "string") {
        blocks.push({ type: OPENAI_BLOCK.TEXT, text: part });
      } else if (part && typeof part === "object") {
        if (part.type === OPENAI_BLOCK.TEXT && typeof part.text === "string") {
          blocks.push({ type: OPENAI_BLOCK.TEXT, text: part.text });
        } else {
          const image = toNativeImageBlock(part);
          if (image) blocks.push(image);
          else if (typeof part.text === "string") {
            blocks.push({ type: OPENAI_BLOCK.TEXT, text: part.text });
          }
        }
      }
    }
    return blocks.length ? blocks : [{ type: OPENAI_BLOCK.TEXT, text: "" }];
  }
  return [{ type: OPENAI_BLOCK.TEXT, text: String(content) }];
}

function safeParseJson(s) {
  if (s == null) return {};
  if (typeof s !== "string") return s;
  try { return JSON.parse(s); } catch { return {}; }
}

function convertMessages(messages = []) {
  const out = [];
  const systemTexts = [];

  // OpenAI tool messages carry only tool_call_id; the function name lives on the
  // assistant tool_calls that produced them. CommandCode forwards toolName into
  // Gemini's functionResponse.name, and Gemini rejects the whole request when it
  // is missing ("contents[2].parts[0].function_response.name:
  // [REQUIRED_FIELD_MISSING]"), so resolve the name up front.
  const toolNameById = new Map();
  for (const m of messages) {
    if (!m || m.role !== ROLE.ASSISTANT || !Array.isArray(m.tool_calls)) continue;
    for (const tc of m.tool_calls) {
      const id = tc?.id;
      const name = tc?.function?.name;
      if (id && name) toolNameById.set(id, name);
    }
  }

  for (const m of messages) {
    if (!m) continue;
    const role = m.role;

    if (role === ROLE.SYSTEM) {
      const t = flattenText(m.content);
      if (t) systemTexts.push(t);
      continue;
    }

    if (role === ROLE.TOOL) {
      const value = typeof m.content === "string" ? m.content : flattenText(m.content);
      const callId = m.tool_call_id || "";
      // m.name is non-standard (most OpenAI clients omit it); fall back to the
      // name recorded on the matching assistant tool_call. Orphan results (their
      // tool_call was trimmed from history) still need a non-empty name: Gemini
      // rejects the whole request otherwise
      // ("function_response.name: [REQUIRED_FIELD_MISSING]").
      const toolName = m.name || toolNameById.get(callId) || "unknown_function";
      out.push({
        role: ROLE.TOOL,
        content: [{
          type: "tool-result",
          toolCallId: callId,
          toolName,
          output: { type: "text", value },
        }],
      });
      continue;
    }

    if (role === ROLE.ASSISTANT) {
      const blocks = [];
      const rc = m.reasoning_content || m.thought || m.reasoning;
      if (rc || (Array.isArray(m.tool_calls) && m.tool_calls.length > 0)) {
        blocks.push({ type: "reasoning", text: rc || " " });
      }
      const text = flattenText(m.content);
      if (text) blocks.push({ type: OPENAI_BLOCK.TEXT, text });
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const fn = tc.function || {};
          blocks.push({
            type: "tool-call",
            toolCallId: tc.id || "",
            toolName: fn.name || "",
            input: safeParseJson(fn.arguments),
          });
        }
      }
      out.push({ role: ROLE.ASSISTANT, content: blocks.length ? blocks : [{ type: OPENAI_BLOCK.TEXT, text: "" }] });
      continue;
    }

    out.push({ role: ROLE.USER, content: toContentBlocks(m.content) });
  }

  return { messages: out, system: systemTexts.join("\n\n") };
}

function convertTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const result = [];
  for (const t of tools) {
    if (!t) continue;
    if (t.type === OPENAI_BLOCK.FUNCTION && t.function) {
      result.push({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters || { type: "object" },
      });
    } else if (t.name && (t.input_schema || t.parameters)) {
      result.push({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema || t.parameters,
      });
    }
  }
  return result.length ? result : undefined;
}

export function openaiToCommandCodeRequest(model, body, stream, credentials) {
  const { messages, system } = convertMessages(body.messages);
  // The upstream catalog only knows bare model ids: a thinking suffix such as
  // "moonshotai/Kimi-K3.1-Pro(high)" is rejected with
  // "Model/provider not recognized: anthropic:...(high)". chatCore strips the
  // suffix from the top-level model, but this envelope carries it in params.model,
  // so strip here too — the requested level still reaches params.reasoning_effort
  // via applyThinking().
  const params = {
    model: stripThinkingSuffix(model),
    messages,
    stream: stream !== false,
    max_tokens: body.max_tokens ?? body.max_output_tokens ?? DEFAULT_MAX_TOKENS,
    temperature: body.temperature ?? 0.3,
  };

  if (system) params.system = system;

  const tools = convertTools(body.tools);
  if (tools) params.tools = tools;
  if (body.top_p != null) params.top_p = body.top_p;

  const today = new Date().toISOString().slice(0, 10);

  return {
    // Conversation-stable (session captured by translateRequest); the executor reuses it as x-session-id.
    threadId: toCommandCodeSessionUuid(credentials?._clientSessionId),
    memory: "",
    config: {
      workingDir: COMMAND_CODE_WORKING_DIR,
      date: today,
      environment: process.platform,
      structure: [],
      isGitRepo: false,
      currentBranch: "",
      mainBranch: "",
      gitStatus: "",
      recentCommits: [],
    },
    params,
  };
}

register(FORMATS.OPENAI, FORMATS.COMMANDCODE, openaiToCommandCodeRequest, null);
