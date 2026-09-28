// Task 5 regression: applyConnectionUpdate (SQLite single-writer handler) must
// be row-semantics parity with updateProviderConnection direct (connectionsRepo).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

const { applyMutation } = await import("../../src/lib/db/sqliteMutationHandlers.js");

function createDb() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`
    CREATE TABLE providerConnections (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      authType TEXT NOT NULL,
      name TEXT,
      email TEXT,
      priority INTEGER,
      isActive INTEGER DEFAULT 1,
      data TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE TABLE dbVersion (id INTEGER PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0, updatedAt TEXT);
  `);

  const db = {
    run(sql, params = []) {
      const r = raw.prepare(sql).run(...params);
      return { changes: Number(r.changes ?? 0), lastInsertRowid: Number(r.lastInsertRowid ?? 0) };
    },
    get(sql, params = []) { return raw.prepare(sql).get(...params); },
    all(sql, params = []) { return raw.prepare(sql).all(...params); },
  };

  const adapter = {
    run: db.run,
    get: db.get,
    all: db.all,
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

function insertConn(db, conn) {
  const data = { ...conn };
  const id = data.id;
  delete data.id; delete data.provider; delete data.authType;
  delete data.name; delete data.email; delete data.priority; delete data.isActive;
  delete data.createdAt; delete data.updatedAt;
  db.run(
    `INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, conn.provider, conn.authType, conn.name ?? null, conn.email ?? null, conn.priority ?? null, conn.isActive === false ? 0 : 1, JSON.stringify(data), conn.createdAt, conn.updatedAt],
  );
}

function connCommand(payload) {
  return {
    schemaVersion: 1,
    type: "connection.update",
    receiptId: `m-${Math.random().toString(36).slice(2)}1234567890abcdef`,
    workerId: "worker-1",
    createdAt: "2026-09-25T00:00:00.000Z",
    payload,
    consistency: "sync",
  };
}

test("maps top-level name/email/priority/isActive to columns and stores only rest in data", () => {
  const { db, adapter } = createDb();
  db.run("INSERT INTO dbVersion(id, version) VALUES(1, 0)");
  insertConn(db, {
    id: "conn-1", provider: "anthropic", authType: "oauth", name: "old",
    email: "old@x.com", priority: 1, isActive: true,
    createdAt: "t0", updatedAt: "t0",
    accessToken: "at", refreshToken: "rt", testStatus: "active", modelLock_claude: "t1", lastError: "err", lastErrorAt: "t2",
  });

  applyMutation(adapter, connCommand({
    connectionId: "conn-1",
    updates: { name: "new", email: "new@x.com", isActive: false, foo: "bar" },
  }));

  const row = db.get("SELECT * FROM providerConnections WHERE id = 'conn-1'");
  assert.equal(row.name, "new");
  assert.equal(row.email, "new@x.com");
  assert.equal(row.isActive, 0);
  const data = JSON.parse(row.data);
  assert.equal(data.foo, "bar", "non-column field lands in data");
  assert.equal("name" in data, false, "top-level columns must not leak into data");
  assert.equal("email" in data, false);
  assert.equal("priority" in data, false);
  assert.equal("isActive" in data, false);
  assert.equal(data.accessToken, "at", "existing credentials preserved");
});

test("resetHealthStateOnActivation clears modelLock_* and errors when testStatus becomes active", () => {
  const { db, adapter } = createDb();
  db.run("INSERT INTO dbVersion(id, version) VALUES(1, 0)");
  insertConn(db, {
    id: "conn-1", provider: "anthropic", authType: "oauth", name: "n",
    email: "e@x.com", priority: 1, isActive: true,
    createdAt: "t0", updatedAt: "t0",
    testStatus: "unavailable", lastError: "429", lastErrorAt: "t2", errorCode: "E429",
    rateLimitedUntil: "t3", backoffLevel: 2, modelLock_claude: "t1", modelLock_gpt: "t4",
  });

  applyMutation(adapter, connCommand({
    connectionId: "conn-1",
    updates: { testStatus: "active" },
  }));

  const data = JSON.parse(db.get("SELECT data FROM providerConnections WHERE id = 'conn-1'").data);
  assert.equal(data.testStatus, "active");
  assert.equal(data.lastError, null);
  assert.equal(data.lastErrorAt, null);
  assert.equal(data.errorCode, null);
  assert.equal(data.rateLimitedUntil, null);
  assert.equal(data.backoffLevel, 0);
  assert.equal(data.modelLock_claude, null);
  assert.equal(data.modelLock_gpt, null);
});

test("reorders provider priority when priority changes", () => {
  const { db, adapter } = createDb();
  db.run("INSERT INTO dbVersion(id, version) VALUES(1, 0)");
  insertConn(db, { id: "c1", provider: "anthropic", authType: "oauth", name: "a", email: null, priority: 1, isActive: true, createdAt: "2026-09-25T00:00:00.000Z", updatedAt: "2026-09-25T00:00:00.000Z" });
  insertConn(db, { id: "c2", provider: "anthropic", authType: "oauth", name: "b", email: null, priority: 2, isActive: true, createdAt: "2026-09-25T00:00:00.000Z", updatedAt: "2026-09-25T00:00:01.000Z" });
  insertConn(db, { id: "c3", provider: "anthropic", authType: "oauth", name: "c", email: null, priority: 3, isActive: true, createdAt: "2026-09-25T00:00:00.000Z", updatedAt: "2026-09-25T00:00:02.000Z" });
  insertConn(db, { id: "other", provider: "openai", authType: "apikey", name: "z", email: null, priority: 1, isActive: true, createdAt: "2026-09-25T00:00:00.000Z", updatedAt: "2026-09-25T00:00:00.000Z" });

  applyMutation(adapter, connCommand({ connectionId: "c3", updates: { priority: 1 } }));

  const rows = db.all("SELECT id, priority FROM providerConnections WHERE provider = 'anthropic' ORDER BY priority ASC");
  assert.deepEqual(rows.map((r) => r.id), ["c3", "c1", "c2"]);
  assert.deepEqual(rows.map((r) => r.priority), [1, 2, 3]);
  // other provider untouched
  const other = db.get("SELECT priority FROM providerConnections WHERE id = 'other'");
  assert.equal(other.priority, 1);
});

test("bumps dbVersion exactly once per connection.update", () => {
  const { db, adapter } = createDb();
  db.run("INSERT INTO dbVersion(id, version) VALUES(1, 0)");
  insertConn(db, { id: "conn-1", provider: "anthropic", authType: "oauth", name: "n", email: null, priority: 1, isActive: true, createdAt: "t0", updatedAt: "t0" });

  applyMutation(adapter, connCommand({ connectionId: "conn-1", updates: { name: "x" } }));
  assert.equal(db.get("SELECT version FROM dbVersion WHERE id = 1").version, 1);

  applyMutation(adapter, connCommand({ connectionId: "conn-1", updates: { name: "y" } }));
  assert.equal(db.get("SELECT version FROM dbVersion WHERE id = 1").version, 2);
});

test("non-active testStatus patch does not clear health state", () => {
  const { db, adapter } = createDb();
  db.run("INSERT INTO dbVersion(id, version) VALUES(1, 0)");
  insertConn(db, {
    id: "conn-1", provider: "anthropic", authType: "oauth", name: "n",
    email: null, priority: 1, isActive: true,
    createdAt: "t0", updatedAt: "t0",
    testStatus: "active", lastError: null, lastErrorAt: null, modelLock_claude: null,
  });

  applyMutation(adapter, connCommand({ connectionId: "conn-1", updates: { lastError: "down", modelLock_claude: "t9" } }));

  const data = JSON.parse(db.get("SELECT data FROM providerConnections WHERE id = 'conn-1'").data);
  assert.equal(data.lastError, "down");
  assert.equal(data.modelLock_claude, "t9");
});
