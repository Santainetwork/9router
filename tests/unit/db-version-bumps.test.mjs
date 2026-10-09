// Task 6: every config mutator repo must bump dbVersion inside the same
// transaction as its correctness mutation. Focused in-memory sqlite test that
// verifies each listed mutator raises the monotonic dbVersion by exactly 1.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";

register(new URL("./helpers/alias-loader.mjs", import.meta.url));

if (!global._dbAdapter) global._dbAdapter = { instance: null, initPromise: null, logged: false };

const apiKeysRepo = await import("../../src/lib/db/repos/apiKeysRepo.js");
const settingsRepo = await import("../../src/lib/db/repos/settingsRepo.js");
const aliasRepo = await import("../../src/lib/db/repos/aliasRepo.js");
const combosRepo = await import("../../src/lib/db/repos/combosRepo.js");
const nodesRepo = await import("../../src/lib/db/repos/nodesRepo.js");
const proxyPoolsRepo = await import("../../src/lib/db/repos/proxyPoolsRepo.js");
const connectionsRepo = await import("../../src/lib/db/repos/connectionsRepo.js");
const disabledModelsRepo = await import("../../src/lib/db/repos/disabledModelsRepo.js");

const DDL = `
  CREATE TABLE apiKeys (
    id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, name TEXT, machineId TEXT,
    isActive INTEGER DEFAULT 1, createdAt TEXT NOT NULL, rpm INTEGER DEFAULT 0,
    concurrency INTEGER DEFAULT 0, queueTimeoutMs INTEGER DEFAULT 0,
    allowedModels TEXT, tokenQuota INTEGER DEFAULT 0,
    accessRestricted INTEGER DEFAULT 0, accessAllow TEXT
  );
  CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL);
  CREATE TABLE kv (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (scope, key));
  CREATE TABLE combos (
    id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, kind TEXT, models TEXT NOT NULL,
    contextWindow INTEGER, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
  );
  CREATE TABLE providerNodes (
    id TEXT PRIMARY KEY, type TEXT, name TEXT, data TEXT NOT NULL,
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
  );
  CREATE TABLE proxyPools (
    id TEXT PRIMARY KEY, isActive INTEGER DEFAULT 1, testStatus TEXT, data TEXT NOT NULL,
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
  );
  CREATE TABLE providerConnections (
    id TEXT PRIMARY KEY, provider TEXT NOT NULL, authType TEXT NOT NULL, name TEXT,
    email TEXT, priority INTEGER, isActive INTEGER DEFAULT 1, data TEXT NOT NULL,
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
  );
  CREATE TABLE dbVersion (
    id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL DEFAULT 0, updatedAt TEXT
  );
`;

function freshAdapter() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(DDL);
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
  global._dbAdapter.instance = adapter;
  global._dbAdapter.initPromise = null;
  return adapter;
}

function readVersion(adapter) {
  return Number(adapter.get("SELECT version FROM dbVersion WHERE id = 1")?.version ?? 0);
}

test("apiKeysRepo create/update/delete bump dbVersion", async () => {
  const db = freshAdapter();
  assert.equal(readVersion(db), 0);
  const key = await apiKeysRepo.createApiKey("k1", "machine-1");
  assert.equal(readVersion(db), 1);
  await apiKeysRepo.updateApiKey(key.id, { name: "k1b" });
  assert.equal(readVersion(db), 2);
  await apiKeysRepo.deleteApiKey(key.id);
  assert.equal(readVersion(db), 3);
});

test("settingsRepo.updateSettings bumps dbVersion", async () => {
  const db = freshAdapter();
  await settingsRepo.updateSettings({ appName: "X" });
  assert.equal(readVersion(db), 1);
});

test("aliasRepo mutators bump dbVersion", async () => {
  const db = freshAdapter();
  await aliasRepo.setModelAlias("a", "b");
  assert.equal(readVersion(db), 1);
  await aliasRepo.deleteModelAlias("a");
  assert.equal(readVersion(db), 2);
  await aliasRepo.addCustomModel({ providerAlias: "p", id: "m" });
  assert.equal(readVersion(db), 3);
  await aliasRepo.deleteCustomModel({ providerAlias: "p", id: "m" });
  assert.equal(readVersion(db), 4);
  await aliasRepo.setMitmAliasAll("t", { x: 1 });
  assert.equal(readVersion(db), 5);
});

test("alias mutation and dbVersion bump roll back together", async () => {
  const db = freshAdapter();
  const run = db.run.bind(db);
  db.run = (sql, params = []) => {
    if (sql.startsWith("INSERT INTO dbVersion")) throw new Error("version bump failed");
    return run(sql, params);
  };

  await assert.rejects(aliasRepo.setModelAlias("atomic", "model"), /version bump failed/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(db.get("SELECT value FROM kv WHERE scope = 'modelAliases' AND key = 'atomic'"), undefined);
});

test("combosRepo create/update/delete bump dbVersion", async () => {
  const db = freshAdapter();
  const combo = await combosRepo.createCombo({ name: "c1", models: ["m"] });
  assert.equal(readVersion(db), 1);
  await combosRepo.updateCombo(combo.id, { name: "c1b" });
  assert.equal(readVersion(db), 2);
  await combosRepo.deleteCombo(combo.id);
  assert.equal(readVersion(db), 3);
});

test("nodesRepo create/update/delete bump dbVersion", async () => {
  const db = freshAdapter();
  const node = await nodesRepo.createProviderNode({ type: "llm", name: "n1", prefix: "p" });
  assert.equal(readVersion(db), 1);
  await nodesRepo.updateProviderNode(node.id, { name: "n1b" });
  assert.equal(readVersion(db), 2);
  await nodesRepo.deleteProviderNode(node.id);
  assert.equal(readVersion(db), 3);
});

test("proxyPoolsRepo create/update/delete bump dbVersion", async () => {
  const db = freshAdapter();
  const pool = await proxyPoolsRepo.createProxyPool({ name: "pp", proxyUrl: "http://x" });
  assert.equal(readVersion(db), 1);
  await proxyPoolsRepo.updateProxyPool(pool.id, { name: "pp2" });
  assert.equal(readVersion(db), 2);
  await proxyPoolsRepo.deleteProxyPool(pool.id);
  assert.equal(readVersion(db), 3);
});

test("connectionsRepo create/update/delete/reorder/cleanup/byProvider bump dbVersion", async () => {
  const db = freshAdapter();
  const conn = await connectionsRepo.createProviderConnection({ provider: "p", authType: "apikey", name: "c1" });
  assert.equal(readVersion(db), 1);
  await connectionsRepo.updateProviderConnection(conn.id, { name: "c2" });
  assert.equal(readVersion(db), 2);
  await connectionsRepo.reorderProviderConnections("p");
  assert.equal(readVersion(db), 3);
  await connectionsRepo.cleanupProviderConnections();
  // apikey conn has a null email column → cleanup strips it, one bump.
  assert.equal(readVersion(db), 4);
  const dirty = await connectionsRepo.createProviderConnection({ provider: "p2", authType: "apikey", name: "d1", email: null });
  assert.equal(readVersion(db), 5);
  await connectionsRepo.cleanupProviderConnections();
  assert.equal(readVersion(db), 6);
  await connectionsRepo.deleteProviderConnectionsByProvider("p2");
  assert.equal(readVersion(db), 7);
  await connectionsRepo.deleteProviderConnection(dirty.id);
  // p2 row already deleted by provider; deleting by id is a no-op here.
  assert.equal(readVersion(db), 7);
  await connectionsRepo.deleteProviderConnection(conn.id);
  assert.equal(readVersion(db), 8);
});

test("disabledModelsRepo disable/enable bump dbVersion", async () => {
  const db = freshAdapter();
  await disabledModelsRepo.disableModels("prov", ["m1", "m2"]);
  assert.equal(readVersion(db), 1);
  await disabledModelsRepo.enableModels("prov", ["m1"]);
  assert.equal(readVersion(db), 2);
  await disabledModelsRepo.enableModels("prov", ["m2"]);
  assert.equal(readVersion(db), 3);
});
