import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  appendFooterToOpenAIBody,
  appendFooterToClaudeBody,
  wrapOpenAIStreamWithFooter,
} from "open-sse/handlers/chatCore/responseFooter.js";

const previousDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-reliability-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
});

describe("response footer reliability", () => {
  it("does not append the same footer twice to JSON bodies", () => {
    const openai = { choices: [{ message: { content: "answer" } }] };
    appendFooterToOpenAIBody(openai, "\n\nvia 9Router");
    appendFooterToOpenAIBody(openai, "\n\nvia 9Router");
    expect(openai.choices[0].message.content).toBe("answer\n\nvia 9Router");

    const claude = { content: [{ type: "text", text: "answer" }] };
    appendFooterToClaudeBody(claude, "\n\nvia 9Router");
    appendFooterToClaudeBody(claude, "\n\nvia 9Router");
    expect(claude.content[0].text).toBe("answer\n\nvia 9Router");
  });

  it("does not inject a footer already present in the streamed answer", async () => {
    const input = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"choices":[{"delta":{"content":"answer\\n\\nvia 9Router"},"finish_reason":null}]}\n\n'
          + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
          + "data: [DONE]\n\n"
          + "data: [DONE]\n\n",
        ));
        controller.close();
      },
    });
    const output = await new Response(
      wrapOpenAIStreamWithFooter(input, "\n\nvia 9Router"),
    ).text();

    expect((output.match(/via 9Router/g) || []).length).toBe(1);
    expect((output.match(/data: \[DONE\]/g) || []).length).toBe(1);
  });
});

describe("Recent Requests model attribution", () => {
  it("uses the requested model instead of the resolved provider model", async () => {
    await db.saveRequestUsage({
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4",
      requestedModel: "claude-sonnet-4",
      tokens: { prompt_tokens: 10, completion_tokens: 2 },
    });

    const stats = await db.getUsageStats("24h");
    expect(stats.recentRequests[0].model).toBe("claude-sonnet-4");

    const live = await db.getActiveRequests();
    expect(live.recentRequests[0].model).toBe("claude-sonnet-4");
    expect((await db.getRecentLogs(1))[0]).toContain("| claude-sonnet-4 |");
  });
});

describe("usage cache headers", () => {
  it("marks usage stats as non-cacheable", async () => {
    const { GET } = await import("@/app/api/usage/stats/route.js");
    const response = await GET(new Request("http://localhost/api/usage/stats?period=24h"));
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
