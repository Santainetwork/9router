// Recent Requests must reflect every request, including ones written by API
// worker processes. Only the control process runs the SSE stream, and
// saveRequestUsage() runs inside whichever process served the request, so the
// control process's in-memory ring cannot be the source of truth in multicore
// mode. The stream polls getActiveRequests() once per second; if that reads
// only the local ring it overwrites the correct DB-backed list sent by
// getUsageStats() with stale rows.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-recent-fresh-"));
const envBefore = {
  DATA_DIR: process.env.DATA_DIR,
  DB_TYPE: process.env.DB_TYPE,
  DATABASE_URL: process.env.DATABASE_URL,
  WORKER_ROLE: process.env.WORKER_ROLE,
  NINEROUTER_WORKER_ROLE: process.env.NINEROUTER_WORKER_ROLE,
};

process.env.DATA_DIR = tmpDir;
delete process.env.DB_TYPE;
delete process.env.DATABASE_URL;
delete process.env.WORKER_ROLE;
delete process.env.NINEROUTER_WORKER_ROLE;

register(new URL("./helpers/alias-loader.mjs", import.meta.url));

const { getAdapter } = await import("../../src/lib/db/driver.js");
const { initDb } = await import("../../src/lib/db/index.js");
const { saveRequestUsage, getActiveRequests, getUsageStats } = await import("../../src/lib/db/repos/usageRepo.js");

await initDb();
const adapter = await getAdapter();

function insertWorkerRow({ model, timestamp, promptTokens = 10, completionTokens = 5 }) {
  // Mirrors what an API worker writes: DB + daily counters, but never this
  // process's ring.
  adapter.run(
    `INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [timestamp, "openrouter", model, null, null, null, promptTokens, completionTokens, 0, "ok",
      JSON.stringify({ prompt_tokens: promptTokens, completion_tokens: completionTokens }),
      JSON.stringify({ requestedModel: model })],
  );
}

function insertWorkerRowWithId({ id, model, timestamp }) {
  adapter.run(
    `INSERT INTO usageHistory(id, timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, timestamp, "openrouter", model, null, null, null, 10, 5, 0, "ok",
      JSON.stringify({ prompt_tokens: 10, completion_tokens: 5 }), JSON.stringify({ requestedModel: model })],
  );
}

test("Recent Requests include a row written by another process", async () => {
  // Control process handles one request locally and initializes its ring.
  await saveRequestUsage({
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4",
    requestedModel: "claude-sonnet-4",
    tokens: { prompt_tokens: 11, completion_tokens: 3 },
    timestamp: "2026-09-23T18:20:00.000Z",
  });
  const localView = await getActiveRequests();
  assert.equal(localView.recentRequests[0].model, "anthropic/claude-sonnet-4");

  // An API worker completes a newer request; the control ring never sees it.
  insertWorkerRow({ model: "ama/amanai/deepseek-v4-flash-0731", timestamp: "2026-09-23T22:53:53.024Z" });

  const stats = await getUsageStats("today");
  assert.equal(stats.recentRequests[0].model, "ama/amanai/deepseek-v4-flash-0731");

  const live = await getActiveRequests();
  assert.equal(
    live.recentRequests[0].model,
    "ama/amanai/deepseek-v4-flash-0731",
    "polling path must not serve a stale ring row after a worker request",
  );
});

test("Recent Requests stay newest-first across processes", async () => {
  insertWorkerRow({ model: "oni/kimi-k3", timestamp: "2026-09-23T22:55:00.000Z" });
  const live = await getActiveRequests();
  const timestamps = live.recentRequests.map((r) => r.timestamp);
  assert.deepEqual(timestamps, [...timestamps].sort().reverse());
  assert.equal(live.recentRequests[0].model, "oni/kimi-k3");
});

test("Recent Requests order by completion timestamp rather than insertion id", async () => {
  insertWorkerRowWithId({ id: 9001, model: "newer-id-older-time", timestamp: "2026-09-23T22:56:00.000Z" });
  insertWorkerRowWithId({ id: 9000, model: "older-id-newer-time", timestamp: "2026-09-23T22:57:00.000Z" });

  const live = await getActiveRequests();
  assert.equal(live.recentRequests[0].model, "openrouter/older-id-newer-time");
});

test.after(() => {
  try { adapter.close?.(); } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(envBefore)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
