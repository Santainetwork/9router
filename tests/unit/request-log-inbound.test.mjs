import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const source = (path) => readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");

test("request log utility masks API keys", async () => {
  const { maskKey } = await import("../../src/lib/requestLogUtils.js");
  assert.equal(maskKey("sk-test-1234567890"), "sk-tes…7890");
  assert.equal(maskKey("short"), "sh…");
  assert.equal(maskKey(null), null);
});

test("request log schema stores bounded inbound audit fields without raw key", () => {
  const schema = source("lib/db/schema.js");
  assert.match(schema, /requestLogs:\s*\{/);
  assert.match(schema, /apiKeyMasked:\s*"TEXT"/);
  assert.match(schema, /endpointKind:\s*"TEXT"/);
  assert.match(schema, /status:\s*"INTEGER"/);
  const table = schema.slice(schema.indexOf("requestLogs:"), schema.indexOf("// Single-writer bridge"));
  assert.doesNotMatch(table, /apiKey:\s*"TEXT"/);
  assert.doesNotMatch(schema, /allowedEndpoints/);
});

test("request log route uses paginated request log repository", () => {
  const route = source("app/api/usage/request-log-entries/route.js");
  assert.match(route, /getRequestLogs/);
  assert.match(route, /pageSize/);
  assert.match(route, /isAuthenticated/);
  assert.doesNotMatch(route, /clearRequestLogs|DELETE/);
});

test("all API-producing v1 route handlers use request logging", () => {
  const routes = [
    "app/api/v1/chat/completions/route.js", "app/api/v1/messages/route.js", "app/api/v1/embeddings/route.js",
    "app/api/v1/images/generations/route.js", "app/api/v1/responses/route.js", "app/api/v1/responses/compact/route.js",
    "app/api/v1/audio/speech/route.js", "app/api/v1/audio/transcriptions/route.js", "app/api/v1/search/route.js",
    "app/api/v1/systemone/route.js", "app/api/v1/web/fetch/route.js", "app/api/v1/videos/generations/route.js",
    "app/api/v1/videos/edits/route.js", "app/api/v1/videos/extensions/route.js", "app/api/v1/nosaver/chat/completions/route.js",
    "app/api/v1/nosaver/messages/route.js", "app/api/v1/api/chat/route.js", "app/api/v1/messages/count_tokens/route.js",
  ];
  for (const path of routes) assert.match(source(path), /withRequestLog/, `${path} must log inbound request`);
});

test("request log write uses multicore mutation bridge", () => {
  const repo = source("lib/db/repos/requestLogsRepo.js");
  assert.match(repo, /isSqliteMulticoreWorker/);
  assert.match(repo, /requestLog\.save/);
});

test("request logs UI supports filtering and auto refresh", () => {
  assert.ok(existsSync(new URL("../../src/app/(dashboard)/dashboard/request-logs/RequestLogsClient.js", import.meta.url)));
  const ui = source("app/(dashboard)/dashboard/request-logs/RequestLogsClient.js");
  assert.match(ui, /autoRefresh/);
  assert.match(ui, /status/);
  assert.match(ui, /endpointKind/);
  assert.match(ui, /Search model/);
  assert.doesNotMatch(ui, /clearRequestLogs|DELETE/);
});

test("request log wrapper preserves thrown errors and records canceled streams", async () => {
  const source = readFileSync(new URL("../../src/lib/requestLog.js", import.meta.url), "utf8");
  assert.match(source, /catch \(error\).*throw error/s);
  assert.match(source, /async cancel\(reason\)/);
  assert.match(source, /await reader\.cancel\(reason\)/);
  assert.match(source, /complete\(status === 200 \? 499 : status\)/);
});
