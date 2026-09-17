import test from "node:test";
import assert from "node:assert/strict";
import {
  convertPlaceholders,
  normalizeSql,
  translateSql,
  createPostgresAdapter,
} from "../../src/lib/db/adapters/postgresAdapter.js";
import { buildCreateTableSql, TABLES } from "../../src/lib/db/schema.js";
import { getDatabaseType, getAdapter } from "../../src/lib/db/driver.js";

test("postgres adapter - convertPlaceholders translates ? to $1, $2, ... outside strings and comments", () => {
  // Basic translation
  assert.equal(
    convertPlaceholders("SELECT * FROM apiKeys WHERE id = ?"),
    "SELECT * FROM apiKeys WHERE id = $1"
  );
  assert.equal(
    convertPlaceholders("SELECT * FROM apiKeys WHERE id = ? AND key = ? AND isActive = ?"),
    "SELECT * FROM apiKeys WHERE id = $1 AND key = $2 AND isActive = $3"
  );

  // Preserve ? inside single quotes
  assert.equal(
    convertPlaceholders("SELECT * FROM t WHERE prompt = 'What is this?' AND id = ?"),
    "SELECT * FROM t WHERE prompt = 'What is this?' AND id = $1"
  );

  // Preserve ? inside escaped quotes in string
  assert.equal(
    convertPlaceholders("SELECT * FROM t WHERE note = 'It''s a test? Yes!' AND id = ?"),
    "SELECT * FROM t WHERE note = 'It''s a test? Yes!' AND id = $1"
  );

  // Preserve ? in line comments
  assert.equal(
    convertPlaceholders("SELECT * FROM t -- comment with ? question\n WHERE id = ?"),
    "SELECT * FROM t -- comment with ? question\n WHERE id = $1"
  );

  // Preserve ? in block comments
  assert.equal(
    convertPlaceholders("SELECT * FROM t /* block comment ? */ WHERE id = ? AND x = ?"),
    "SELECT * FROM t /* block comment ? */ WHERE id = $1 AND x = $2"
  );

  // Preserve ? in dollar quoted strings
  assert.equal(
    convertPlaceholders("SELECT * FROM t WHERE raw = $$dollar?value$$ AND id = ?"),
    "SELECT * FROM t WHERE raw = $$dollar?value$$ AND id = $1"
  );
});

test("postgres adapter - normalizeSql converts SQLite dialects to PostgreSQL", () => {
  // datetime('now') -> NOW()
  assert.equal(normalizeSql("SELECT datetime('now')"), "SELECT NOW()");

  // datetime with interval
  const normInterval = normalizeSql("SELECT * FROM usageHistory WHERE timestamp >= datetime('now', '-7 days')");
  assert.match(normInterval, /to_char\(NOW\(\)\s*-\s*INTERVAL\s*'7 days'/i);

  // datetime with start of day
  const normStartOfDay = normalizeSql("SELECT * FROM usageHistory WHERE timestamp >= datetime('now', 'start of day')");
  assert.match(normStartOfDay, /to_char\(date_trunc\('day',\s*NOW\(\)\)/i);

  // PRAGMA table_info
  assert.equal(
    normalizeSql("PRAGMA table_info(apiKeys)"),
    "SELECT column_name AS name FROM information_schema.columns WHERE lower(table_name) = 'apikeys'"
  );

  // Other PRAGMA
  assert.equal(normalizeSql("PRAGMA journal_mode = WAL;"), "SELECT 1 WHERE 1 = 0");

  // CREATE TABLE AUTOINCREMENT
  assert.equal(
    normalizeSql("CREATE TABLE test (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)"),
    "CREATE TABLE test (id SERIAL PRIMARY KEY, name TEXT)"
  );

  // INSERT OR REPLACE INTO single PK table
  const repApiKey = normalizeSql(
    "INSERT OR REPLACE INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES(?, ?, ?, ?, ?, ?)"
  );
  assert.match(repApiKey, /^INSERT INTO apiKeys/);
  assert.match(repApiKey, /ON CONFLICT \(id\) DO UPDATE SET/);
  assert.match(repApiKey, /key = EXCLUDED\.key/);

  // INSERT OR REPLACE INTO composite PK table (kv: scope, key)
  const repKv = normalizeSql(
    "INSERT OR REPLACE INTO kv(scope, key, value) VALUES('modelAliases', ?, ?)"
  );
  assert.match(repKv, /^INSERT INTO kv/);
  assert.match(repKv, /ON CONFLICT \(scope, key\) DO UPDATE SET value = EXCLUDED\.value/);
});

test("postgres adapter - translateSql chains normalization and placeholder replacement", () => {
  const translated = translateSql(
    "INSERT OR REPLACE INTO kv(scope, key, value) VALUES(?, ?, ?)"
  );
  assert.equal(
    translated,
    "INSERT INTO kv (scope, key, value) VALUES ($1, $2, $3) ON CONFLICT (scope, key) DO UPDATE SET value = EXCLUDED.value"
  );
});

test("schema - buildCreateTableSql supports postgres SERIAL PRIMARY KEY", () => {
  const sqliteSql = buildCreateTableSql("usageHistory", TABLES.usageHistory, "sqlite");
  assert.match(sqliteSql, /INTEGER PRIMARY KEY AUTOINCREMENT/);

  const pgSql = buildCreateTableSql("usageHistory", TABLES.usageHistory, "postgres");
  assert.match(pgSql, /SERIAL PRIMARY KEY/);
  assert.doesNotMatch(pgSql, /AUTOINCREMENT/);
});

test("postgres adapter - executes queries and transactions with mock client contract", async () => {
  const queryLog = [];
  const mockClient = {
    query(sql, params) {
      queryLog.push({ sql, params });
      if (/information_schema\.columns/i.test(sql)) {
        return { rowCount: 2, rows: [{ name: "id" }, { name: "key" }] };
      }
      if (/SELECT \* FROM apiKeys WHERE id = \$1/i.test(sql)) {
        if (params && params[0] === "key-1") {
          return { rowCount: 1, rows: [{ id: "key-1", key: "sk-real", name: "Alpha" }] };
        }
        return { rowCount: 0, rows: [] };
      }
      if (/SELECT \* FROM apiKeys/i.test(sql)) {
        return { rowCount: 1, rows: [{ id: "key-1", key: "sk-real", name: "Alpha" }] };
      }
      if (/INSERT INTO apiKeys/i.test(sql)) {
        return { rowCount: 1, rows: [{ id: "key-new" }] };
      }
      return { rowCount: 0, rows: [] };
    },
    end() {},
  };

  const adapter = await createPostgresAdapter(null, { mockClient });

  assert.equal(adapter.driver, "postgres");
  assert.equal(adapter.raw, mockClient);
  assert.equal(typeof adapter.run, "function");
  assert.equal(typeof adapter.get, "function");
  assert.equal(typeof adapter.all, "function");
  assert.equal(typeof adapter.exec, "function");
  assert.equal(typeof adapter.transaction, "function");
  assert.equal(typeof adapter.checkpoint, "function");
  assert.equal(typeof adapter.close, "function");

  // Test get with parameter
  const key = adapter.get("SELECT * FROM apiKeys WHERE id = ?", ["key-1"]);
  assert.deepEqual(key, { id: "key-1", key: "sk-real", name: "Alpha" });
  assert.equal(queryLog[0].sql, "SELECT * FROM apiKeys WHERE id = $1");
  assert.deepEqual(queryLog[0].params, ["key-1"]);

  // Test get not found
  const notFound = adapter.get("SELECT * FROM apiKeys WHERE id = ?", ["non-existent"]);
  assert.equal(notFound, undefined);

  // Test all
  const allRows = adapter.all("SELECT * FROM apiKeys");
  assert.equal(allRows.length, 1);
  assert.equal(allRows[0].id, "key-1");

  // Test run
  const runRes = adapter.run("INSERT INTO apiKeys (id, key) VALUES (?, ?)", ["key-new", "sk-new"]);
  assert.equal(runRes.changes, 1);
  assert.equal(runRes.lastInsertRowid, "key-new");

  // Test transaction success
  const txResult = adapter.transaction(() => {
    adapter.run("INSERT INTO apiKeys (id, key) VALUES (?, ?)", ["k1", "sk1"]);
    return "done";
  });
  assert.equal(txResult, "done");
  const txSqls = queryLog.map((q) => q.sql);
  assert.ok(txSqls.includes("BEGIN"));
  assert.ok(txSqls.includes("COMMIT"));

  // Test transaction rollback on throw
  assert.throws(() => {
    adapter.transaction(() => {
      adapter.run("INSERT INTO apiKeys (id, key) VALUES (?, ?)", ["fail", "fail"]);
      throw new Error("test rollback");
    });
  }, /test rollback/);
  const rollbackSqls = queryLog.map((q) => q.sql);
  assert.ok(rollbackSqls.includes("ROLLBACK"));

  // Test checkpoint (no-op)
  assert.doesNotThrow(() => adapter.checkpoint());

  // Test close
  adapter.close();
});

test("postgres adapter - restores camelCase schema columns from PostgreSQL rows", async () => {
  const mockClient = {
    query(sql) {
      if (/SELECT \* FROM providerConnections/i.test(sql)) {
        return { rowCount: 1, rows: [{ id: "pc-1", isactive: 1, authtype: "oauth", createdat: "now" }] };
      }
      return { rowCount: 0, rows: [] };
    },
    end() {},
  };
  const adapter = await createPostgresAdapter(null, { mockClient });
  assert.deepEqual(adapter.get("SELECT * FROM providerConnections"), {
    id: "pc-1", isActive: 1, authType: "oauth", createdAt: "now",
  });
  adapter.close();
});

test("driver - getDatabaseType reflects DATABASE_URL and DB_TYPE settings", () => {
  const origUrl = process.env.DATABASE_URL;
  const origType = process.env.DB_TYPE;

  try {
    delete process.env.DATABASE_URL;
    delete process.env.DB_TYPE;
    assert.equal(getDatabaseType(), "sqlite");

    process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/9router";
    assert.equal(getDatabaseType(), "postgres");

    delete process.env.DATABASE_URL;
    process.env.DB_TYPE = "postgres";
    assert.equal(getDatabaseType(), "postgres");

    process.env.DB_TYPE = "sqlite";
    assert.equal(getDatabaseType(), "sqlite");
  } finally {
    if (origUrl !== undefined) process.env.DATABASE_URL = origUrl;
    else delete process.env.DATABASE_URL;
    if (origType !== undefined) process.env.DB_TYPE = origType;
    else delete process.env.DB_TYPE;
  }
});

test("driver - falls back to SQLite when DATABASE_URL is unset", async () => {
  const origUrl = process.env.DATABASE_URL;
  const origType = process.env.DB_TYPE;

  try {
    delete process.env.DATABASE_URL;
    delete process.env.DB_TYPE;

    assert.equal(getDatabaseType(), "sqlite");
    const adapter = await getAdapter();
    assert.ok(
      adapter.driver === "better-sqlite3" ||
      adapter.driver === "node:sqlite" ||
      adapter.driver === "sql.js",
      `Expected SQLite driver, got ${adapter.driver}`
    );
  } finally {
    if (origUrl !== undefined) process.env.DATABASE_URL = origUrl;
    else delete process.env.DATABASE_URL;
    if (origType !== undefined) process.env.DB_TYPE = origType;
    else delete process.env.DB_TYPE;
  }
});
