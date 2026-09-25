import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

const { applyMutation } = await import("../../src/lib/db/sqliteMutationHandlers.js");

// Real in-memory SQLite so the handler SQL is exercised against the actual
// schema shapes, not a fake adapter. Mirrors the column sets in schema.js.
function createDb() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`
    CREATE TABLE apiKeys (
      id TEXT PRIMARY KEY,
      key TEXT UNIQUE NOT NULL,
      name TEXT
    );
    CREATE TABLE usageHistory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      connectionId TEXT,
      apiKey TEXT,
      endpoint TEXT,
      promptTokens INTEGER DEFAULT 0,
      completionTokens INTEGER DEFAULT 0,
      cost REAL DEFAULT 0,
      status TEXT,
      tokens TEXT,
      meta TEXT
    );
    CREATE TABLE usageDaily (dateKey TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE requestDetails (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      connectionId TEXT,
      status TEXT,
      data TEXT NOT NULL
    );
    CREATE TABLE provider_footer_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      referral_text TEXT NOT NULL
    );
  `);

  // Raw handle for test assertions (prepare/get/all/run).
  const db = {
    run(sql, params = []) {
      const r = raw.prepare(sql).run(...params);
      return { changes: Number(r.changes ?? 0), lastInsertRowid: Number(r.lastInsertRowid ?? 0) };
    },
    get(sql, params = []) { return raw.prepare(sql).get(...params); },
    all(sql, params = []) { return raw.prepare(sql).all(...params); },
  };

  // Adapter-shaped API (run/get/all/transaction) the control writer passes to
  // applyMutation.
  const adapter = {
    run(sql, params = []) {
      const r = raw.prepare(sql).run(...params);
      return { changes: Number(r.changes ?? 0), lastInsertRowid: Number(r.lastInsertRowid ?? 0) };
    },
    get(sql, params = []) { return raw.prepare(sql).get(...params); },
    all(sql, params = []) { return raw.prepare(sql).all(...params); },
    transaction(fn) {
      const sp = `sp_${Math.random().toString(36).slice(2)}`;
      raw.exec(`SAVEPOINT ${sp}`);
      try {
        const r = fn();
        raw.exec(`RELEASE ${sp}`);
        return r;
      } catch (e) {
        try { raw.exec(`ROLLBACK TO ${sp}`); raw.exec(`RELEASE ${sp}`); } catch {}
        throw e;
      }
    },
  };

  return { db, adapter };
}

function usageCommand(payload, overrides = {}) {
  return {
    schemaVersion: 1,
    type: "usage.save",
    receiptId: `m-${Math.random().toString(36).slice(2)}1234567890abcdef`,
    workerId: "worker-1",
    createdAt: "2026-09-25T00:00:00.000Z",
    payload,
    consistency: "async",
    ...overrides,
  };
}

const baseUsage = {
  timestamp: "2026-09-25T08:00:00.000Z",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  connectionId: "conn-1",
  apiKeyId: "key-1",
  endpoint: "/v1/chat/completions",
  tokens: { prompt_tokens: 100, completion_tokens: 50, cached_tokens: 10 },
  cost: 0.001,
  status: "ok",
  requestedModel: "claude-sonnet-4-6",
  upstreamModel: "claude-sonnet-4-6",
};

test("usage.save resolves raw key via apiKeyId and writes history row", () => {
  const { db, adapter } = createDb();
  db.run("INSERT INTO apiKeys(id, key, name) VALUES(?, ?, ?)", ["key-1", "sk-raw-secret-key-1", "prod"]);
  db.run("INSERT INTO apiKeys(id, key, name) VALUES(?, ?, ?)", ["key-2", "sk-raw-secret-key-2", "dev"]);

  applyMutation(adapter, usageCommand(baseUsage));

  const row = db.get("SELECT * FROM usageHistory");
  assert.equal(row.provider, "anthropic");
  assert.equal(row.apiKey, "sk-raw-secret-key-1");
  assert.equal(row.promptTokens, 100);
  assert.equal(row.completionTokens, 50);
  assert.equal(row.cost, 0.001);
  assert.equal(row.endpoint, "/v1/chat/completions");
  // The raw key is never echoed in the payload; only the resolved value is stored.
  assert.equal(JSON.stringify(baseUsage).includes("sk-raw"), false);
});

test("usage.save with unknown apiKeyId resolves to null raw key", () => {
  const { db, adapter } = createDb();
  db.run("INSERT INTO apiKeys(id, key, name) VALUES(?, ?, ?)", ["key-2", "sk-raw-secret-key-2", "dev"]);

  applyMutation(adapter, usageCommand({ ...baseUsage, apiKeyId: "missing-key" }));
  const row = db.get("SELECT * FROM usageHistory");
  assert.equal(row.apiKey, null);
});

test("usage.save dedupes identical history rows and updates endpoint when empty", () => {
  const { db, adapter } = createDb();
  db.run("INSERT INTO apiKeys(id, key) VALUES(?, ?)", ["key-1", "sk-raw"]);

  applyMutation(adapter, usageCommand({ ...baseUsage, endpoint: null }));
  applyMutation(adapter, usageCommand({ ...baseUsage, endpoint: "/v1/messages" }));

  const rows = db.all("SELECT * FROM usageHistory");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].endpoint, "/v1/messages");
});

test("usage.save aggregates daily shapes and increments lifetime count", () => {
  const { db, adapter } = createDb();
  db.run("INSERT INTO apiKeys(id, key) VALUES(?, ?)", ["key-1", "sk-raw"]);

  applyMutation(adapter, usageCommand(baseUsage));
  applyMutation(adapter, usageCommand({ ...baseUsage, timestamp: "2026-09-25T09:00:00.000Z" }));

  const day = db.get("SELECT data FROM usageDaily WHERE dateKey = ?", ["2026-09-25"]);
  const parsed = JSON.parse(day.data);
  assert.equal(parsed.requests, 2);
  assert.equal(parsed.promptTokens, 200);
  assert.equal(parsed.completionTokens, 100);
  assert.equal(parsed.cachedTokens, 20);
  assert.equal(parsed.byProvider.anthropic.requests, 2);
  assert.equal(parsed.byEndpoint["/v1/chat/completions|claude-sonnet-4-6|anthropic"].requests, 2);

  const lifetime = db.get("SELECT value FROM _meta WHERE key = 'totalRequestsLifetime'");
  assert.equal(lifetime.value, "2");
});

test("requestDetail.save is metadata-only, upserts, and retains max 200", () => {
  const { db, adapter } = createDb();
  const cmd = {
    schemaVersion: 1,
    type: "requestDetail.save",
    receiptId: "m-1234567890abcdef",
    workerId: "worker-1",
    createdAt: "2026-09-25T00:00:00.000Z",
    payload: {
      id: "detail-1",
      timestamp: "2026-09-25T08:00:00.000Z",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      connectionId: "conn-1",
      status: "success",
      latency: { total: 500 },
      tokens: { prompt_tokens: 100 },
      upstreamModel: "claude-sonnet-4-6",
      requestedModel: "claude-sonnet-4-6",
    },
    consistency: "async",
  };

  applyMutation(adapter, cmd);
  applyMutation(adapter, { ...cmd, payload: { ...cmd.payload, status: "error" } });

  const rows = db.all("SELECT * FROM requestDetails");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "error");
  const data = JSON.parse(rows[0].data);
  // No raw bodies ever stored.
  assert.equal(data.request, null);
  assert.equal(data.providerRequest, null);
  assert.equal(data.providerResponse, null);
  assert.equal(data.response, null);
  assert.equal(data.upstreamModel, "claude-sonnet-4-6");

  // 200-cap retention: oldest rows evicted.
  for (let i = 0; i < 210; i++) {
    applyMutation(adapter, { ...cmd, payload: { ...cmd.payload, id: `detail-${i}`, timestamp: `2026-09-25T0${i % 10}:00:00.000Z` } });
  }
  const count = db.get("SELECT COUNT(*) AS c FROM requestDetails").c;
  assert.equal(count, 200);
});

test("footerLog.add redacts secrets in depth and retains max 200", () => {
  const { db, adapter } = createDb();
  const cmd = {
    schemaVersion: 1,
    type: "footerLog.add",
    receiptId: "m-1234567890abcdef",
    workerId: "worker-1",
    createdAt: "2026-09-25T00:00:00.000Z",
    payload: {
      timestamp: "2026-09-25T08:00:00.000Z",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      referralText: "delivered by token9a9b9c9d9e9f9g9h9i9j9k9l9m9n9o9p and a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
    },
    consistency: "async",
  };

  applyMutation(adapter, cmd);
  const row = db.get("SELECT referral_text FROM provider_footer_logs");
  assert.equal(row.referral_text.includes("token9a9b9c9d9e9f9g9h9i9j9k9l9m9n9o9p"), false);
  assert.match(row.referral_text, /\[REDACTED\]/);

  for (let i = 0; i < 210; i++) {
    applyMutation(adapter, { ...cmd, payload: { ...cmd.payload, timestamp: `2026-09-25T0${i % 10}:00:00.000Z` } });
  }
  const count = db.get("SELECT COUNT(*) AS c FROM provider_footer_logs").c;
  assert.equal(count, 200);
});

test("unknown mutation type is rejected", () => {
  const { adapter } = createDb();
  assert.throws(() => applyMutation(adapter, { ...usageCommand(baseUsage), type: "settings.save" }), /unknown mutation type/);
});
