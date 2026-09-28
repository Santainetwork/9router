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

test("connection.update merges state and bumps dbVersion in one transaction", () => {
  const { db, adapter } = createDb();
  db.run("CREATE TABLE IF NOT EXISTS providerConnections (id TEXT PRIMARY KEY, provider TEXT, authType TEXT, name TEXT, email TEXT, priority INTEGER, isActive INTEGER, data TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)");
  db.run("CREATE TABLE IF NOT EXISTS dbVersion (id INTEGER PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0, updatedAt TEXT)");
  db.run("INSERT INTO providerConnections(id, provider, authType, data, createdAt, updatedAt) VALUES(?, 'anthropic', 'oauth', ?, ?, ?)", ["conn-1", JSON.stringify({ accessToken: "at", testStatus: "active" }), "t0", "t0"]);
  db.run("INSERT INTO dbVersion(id, version) VALUES(1, 0)");

  const result = applyMutation(adapter, {
    schemaVersion: 1,
    type: "connection.update",
    receiptId: "m-1234567890abcdef",
    workerId: "worker-1",
    createdAt: "2026-09-25T00:00:00.000Z",
    payload: { connectionId: "conn-1", updates: { testStatus: "unavailable", modelLock_claude: "2026-09-25T01:00:00.000Z" } },
    consistency: "sync",
  });

  assert.equal(result.updated, true);
  assert.equal(result.version, 1);
  const row = db.get("SELECT data FROM providerConnections WHERE id = 'conn-1'");
  const data = JSON.parse(row.data);
  assert.equal(data.testStatus, "unavailable");
  assert.equal(data.accessToken, "at", "existing credentials preserved");
  const ver = db.get("SELECT version FROM dbVersion WHERE id = 1");
  assert.equal(ver.version, 1);
});

test("connection.update for a missing connection returns updated:false without bumping version", () => {
  const { db, adapter } = createDb();
  db.run("CREATE TABLE IF NOT EXISTS providerConnections (id TEXT PRIMARY KEY, provider TEXT, authType TEXT, name TEXT, email TEXT, priority INTEGER, isActive INTEGER, data TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)");
  db.run("CREATE TABLE IF NOT EXISTS dbVersion (id INTEGER PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0, updatedAt TEXT)");
  db.run("INSERT INTO dbVersion(id, version) VALUES(1, 0)");

  const result = applyMutation(adapter, {
    schemaVersion: 1,
    type: "connection.update",
    receiptId: "m-1234567890abcdef",
    workerId: "worker-1",
    createdAt: "2026-09-25T00:00:00.000Z",
    payload: { connectionId: "missing", updates: { testStatus: "unavailable" } },
    consistency: "sync",
  });

  assert.equal(result.updated, false);
  assert.equal(db.get("SELECT version FROM dbVersion WHERE id = 1").version, 0);
});

test("connection.update writes top-level columns, resets health on activation, reorders, excludes top-level from data, bumps once", () => {
  const { db, adapter } = createDb();
  db.run("CREATE TABLE IF NOT EXISTS providerConnections (id TEXT PRIMARY KEY, provider TEXT, authType TEXT, name TEXT, email TEXT, priority INTEGER, isActive INTEGER, data TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)");
  db.run("CREATE TABLE IF NOT EXISTS dbVersion (id INTEGER PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0, updatedAt TEXT)");
  const stale = {
    accessToken: "at-keep",
    lastError: "429 rate limited",
    lastErrorAt: "2026-09-25T00:00:00.000Z",
    errorCode: "rate_limit",
    rateLimitedUntil: "2026-09-25T02:00:00.000Z",
    backoffLevel: 4,
    modelLock_claude: "2026-09-25T03:00:00.000Z",
    modelLock_gpt: "2026-09-25T04:00:00.000Z",
    testStatus: "unavailable",
  };
  db.run("INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES(?, 'anthropic', 'oauth', ?, ?, ?, ?, ?, ?, ?)",
    ["conn-1", "old-name", "old@example.com", 3, 1, JSON.stringify(stale), "t0", "2026-09-25T00:00:00.000Z"]);
  db.run("INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES(?, 'anthropic', 'oauth', ?, ?, ?, ?, ?, ?, ?)",
    ["conn-2", "second", "two@example.com", 1, 1, JSON.stringify({}), "t0", "2026-09-25T00:00:01.000Z"]);
  db.run("INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES(?, 'anthropic', 'oauth', ?, ?, ?, ?, ?, ?, ?)",
    ["conn-3", "third", "three@example.com", 2, 1, JSON.stringify({}), "t0", "2026-09-25T00:00:02.000Z"]);
  db.run("INSERT INTO dbVersion(id, version) VALUES(1, 7)");

  const result = applyMutation(adapter, {
    schemaVersion: 1,
    type: "connection.update",
    receiptId: "m-1234567890abcdef",
    workerId: "worker-1",
    createdAt: "2026-09-25T00:00:00.000Z",
    payload: {
      connectionId: "conn-1",
      updates: {
        name: "new-name",
        email: "new@example.com",
        priority: 1,
        isActive: false,
        testStatus: "active",
      },
    },
    consistency: "sync",
  });

  assert.equal(result.updated, true);
  assert.equal(result.version, 8, "exactly +1 bump");
  assert.equal(db.get("SELECT version FROM dbVersion WHERE id = 1").version, 8);

  const row = db.get("SELECT * FROM providerConnections WHERE id = 'conn-1'");
  assert.equal(row.name, "new-name");
  assert.equal(row.email, "new@example.com");
  assert.equal(row.priority, 1);
  assert.equal(row.isActive, 0);
  assert.equal(row.provider, "anthropic");
  assert.equal(row.authType, "oauth");

  const data = JSON.parse(row.data);
  assert.equal(data.testStatus, "active");
  assert.equal(data.accessToken, "at-keep", "credentials preserved");
  // Activation clears stale health/cooldown state and every model lock.
  assert.equal(data.lastError, null);
  assert.equal(data.lastErrorAt, null);
  assert.equal(data.errorCode, null);
  assert.equal(data.rateLimitedUntil, null);
  assert.equal(data.backoffLevel, 0);
  assert.equal(data.modelLock_claude, null);
  assert.equal(data.modelLock_gpt, null);
  // Top-level columns live in columns, never duplicated inside data JSON.
  for (const key of ["id", "provider", "authType", "name", "email", "priority", "isActive", "createdAt", "updatedAt"]) {
    assert.equal(Object.hasOwn(data, key), false, `data must not carry ${key}`);
  }

  // Reorder ran because priority changed: conn-1 (freshly bumped to priority 1)
  // sorts ahead of conn-2 on the updatedAt tie-break, then conn-3.
  const order = db.all("SELECT id, priority FROM providerConnections WHERE provider = 'anthropic' ORDER BY priority ASC");
  assert.deepEqual(order.map((r) => r.id), ["conn-1", "conn-2", "conn-3"]);
  assert.deepEqual(order.map((r) => r.priority), [1, 2, 3]);
});

test("connection.update without priority leaves row order untouched", () => {
  const { db, adapter } = createDb();
  db.run("CREATE TABLE IF NOT EXISTS providerConnections (id TEXT PRIMARY KEY, provider TEXT, authType TEXT, name TEXT, email TEXT, priority INTEGER, isActive INTEGER, data TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)");
  db.run("CREATE TABLE IF NOT EXISTS dbVersion (id INTEGER PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0, updatedAt TEXT)");
  db.run("INSERT INTO providerConnections(id, provider, authType, priority, data, createdAt, updatedAt) VALUES(?, 'anthropic', 'oauth', ?, ?, ?, ?)", ["conn-1", 5, JSON.stringify({}), "t0", "t0"]);
  db.run("INSERT INTO providerConnections(id, provider, authType, priority, data, createdAt, updatedAt) VALUES(?, 'anthropic', 'oauth', ?, ?, ?, ?)", ["conn-2", 9, JSON.stringify({}), "t0", "t0"]);
  db.run("INSERT INTO dbVersion(id, version) VALUES(1, 0)");

  applyMutation(adapter, {
    schemaVersion: 1,
    type: "connection.update",
    receiptId: "m-1234567890abcdef",
    workerId: "worker-1",
    createdAt: "2026-09-25T00:00:00.000Z",
    payload: { connectionId: "conn-1", updates: { testStatus: "unavailable" } },
    consistency: "sync",
  });

  assert.equal(db.get("SELECT priority FROM providerConnections WHERE id = 'conn-1'").priority, 5);
  assert.equal(db.get("SELECT priority FROM providerConnections WHERE id = 'conn-2'").priority, 9);
});
