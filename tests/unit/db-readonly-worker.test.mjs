// Task 2 of docs/superpowers/plans/2026-09-24-sqlite-redis-multicore.md
//
//   * native SQLite worker connections open READ-ONLY: they can query, and every
//     mutation entry point fails closed instead of silently dropping a write the
//     single control writer never sees;
//   * a read-only worker runs no write PRAGMAs, no migration and no checkpoint;
//   * sql.js is rejected for the worker role (stale private DB image);
//   * the receipt/version tables exist and the schema version was bumped once.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-readonly-"));
const ENV_KEYS = ["DATA_DIR", "DATABASE_URL", "DB_TYPE", "WORKER_ROLE", "NINEROUTER_WORKER_ROLE", "SQLITE_MULTICORE"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
process.env.DATA_DIR = tempDir;
delete process.env.DATABASE_URL;
delete process.env.DB_TYPE;
delete process.env.WORKER_ROLE;
delete process.env.NINEROUTER_WORKER_ROLE;
delete process.env.SQLITE_MULTICORE;

after(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const { READONLY_PRAGMA_SQL, SCHEMA_VERSION, TABLES, ReadOnlyAdapterError } = await import("../../src/lib/db/schema.js");
const { isSqliteMulticoreWorker, initAdapter } = await import("../../src/lib/db/driver.js");
const { createNodeSqliteAdapter } = await import("../../src/lib/db/adapters/nodeSqliteAdapter.js");
const { runMigrationOnce } = await import("../../src/lib/db/migrate.js");

let fileSeq = 0;
const dbFile = (tag) => path.join(tempDir, `${tag}-${fileSeq++}.sqlite`);

// Native drivers this host can actually open. better-sqlite3 has no built
// binding in every checkout, and bun:sqlite only exists under Bun, so the same
// assertions run against whichever native adapter is available.
async function nativeDrivers() {
  const drivers = [];
  const probe = dbFile("probe");
  if (process.versions.bun) {
    const { createBunSqliteAdapter } = await import("../../src/lib/db/adapters/bunSqliteAdapter.js");
    try { (await createBunSqliteAdapter(probe)).close(); drivers.push({ name: "bun:sqlite", open: createBunSqliteAdapter }); } catch {}
  } else {
    try {
      const { createBetterSqliteAdapter } = await import("../../src/lib/db/adapters/betterSqliteAdapter.js");
      createBetterSqliteAdapter(probe).close();
      drivers.push({ name: "better-sqlite3", open: createBetterSqliteAdapter });
    } catch {}
    const [maj, min] = process.versions.node.split(".").map(Number);
    if (maj > 22 || (maj === 22 && min >= 5)) {
      try { (await createNodeSqliteAdapter(probe)).close(); drivers.push({ name: "node:sqlite", open: createNodeSqliteAdapter }); } catch {}
    }
  }
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(probe + suffix, { force: true });
  return drivers;
}

const drivers = await nativeDrivers();
assert.ok(drivers.length > 0, "at least one native SQLite driver must be available");

// Creates a WAL database with one row using a real (read-write) adapter.
async function seededDb(open, tag) {
  const file = dbFile(tag);
  const rw = await open(file);
  rw.exec("CREATE TABLE t(a)");
  rw.run("INSERT INTO t VALUES(1)");
  rw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  return { file, rw };
}

// ─── Read-only worker connection ─────────────────────────────────────────

for (const { name, open } of drivers) {
  test(`${name}: read-only open queries but every write entry point fails closed`, async () => {
    const { file, rw } = await seededDb(open, "ro");
    const ro = await open(file, { readOnly: true });
    try {
      assert.equal(ro.readOnly, true);
      assert.equal(ro.get("SELECT COUNT(*) AS c FROM t").c, 1);
      // node:sqlite returns null-prototype rows, so compare structurally.
      assert.deepEqual({ ...ro.all("SELECT a FROM t")[0] }, { a: 1 });

      for (const op of ["run", "exec", "transaction", "checkpoint"]) {
        assert.throws(() => ro[op]("INSERT INTO t VALUES(2)"), (e) => e instanceof ReadOnlyAdapterError && e.code === "DB_READONLY_WORKER", `${op} must be denied`);
      }

      // Denied at the adapter layer, and the row count never moved.
      assert.equal(ro.get("SELECT COUNT(*) AS c FROM t").c, 1);
      assert.equal(rw.get("SELECT COUNT(*) AS c FROM t").c, 1);
    } finally {
      ro.close();
      rw.close();
    }
  });

  test(`${name}: read-only worker applies no write PRAGMAs and does not checkpoint`, async () => {
    const { file, rw } = await seededDb(open, "pragma");
    const ro = await open(file, { readOnly: true });
    try {
      // Reader PRAGMAs are connection-local; the write set is absent by design.
      assert.equal(Number(ro.get("PRAGMA query_only").query_only), 1);
      assert.equal(Number(ro.get("PRAGMA foreign_keys").foreign_keys), 1);
      assert.equal(Number(ro.get("PRAGMA busy_timeout").timeout), 5000);
      for (const forbidden of ["journal_mode", "synchronous", "mmap_size", "cache_size", "temp_store"]) {
        assert.ok(!READONLY_PRAGMA_SQL.includes(forbidden), `read-only PRAGMA set must not touch ${forbidden}`);
      }
      assert.ok(READONLY_PRAGMA_SQL.includes("query_only"), "query_only is the worker-side write guard");

      // A checkpoint would truncate -wal; the writer's WAL must survive a reader.
      rw.run("INSERT INTO t VALUES(2)");
      const walBefore = fs.statSync(`${file}-wal`).size;
      assert.equal(ro.get("SELECT COUNT(*) AS c FROM t").c, 2, "worker must see committed writer rows");
      ro.close();
      assert.equal(fs.statSync(`${file}-wal`).size, walBefore, "a read-only close must not checkpoint");
      assert.equal(rw.get("SELECT COUNT(*) AS c FROM t").c, 2);
    } finally {
      rw.close();
    }
  });

  test(`${name}: read-only open fails on a missing database instead of creating one`, async () => {
    const missing = dbFile("missing");
    await assert.rejects(async () => { (await open(missing, { readOnly: true })).close(); });
    assert.equal(fs.existsSync(missing), false, "a worker must never create the database file");
  });

  test(`${name}: control (default) open stays read-write and checkpoints`, async () => {
    const { file, rw } = await seededDb(open, "rw");
    try {
      assert.notEqual(rw.readOnly, true);
      rw.run("INSERT INTO t VALUES(2)");
      assert.equal(rw.get("SELECT COUNT(*) AS c FROM t").c, 2);
      rw.checkpoint();
    } finally {
      rw.close();
    }
  });
}

// ─── Driver routing: worker read-only, control read-write ────────────────

test("isSqliteMulticoreWorker requires both the api role and SQLITE_MULTICORE=redis", () => {
  assert.equal(isSqliteMulticoreWorker({}), false);
  assert.equal(isSqliteMulticoreWorker({ WORKER_ROLE: "api" }), false);
  assert.equal(isSqliteMulticoreWorker({ WORKER_ROLE: "control", SQLITE_MULTICORE: "redis" }), false);
  assert.equal(isSqliteMulticoreWorker({ WORKER_ROLE: "api", SQLITE_MULTICORE: "redis" }), true);
  assert.equal(isSqliteMulticoreWorker({ WORKER_ROLE: "api", SQLITE_MULTICORE: "REDIS" }), true);
  assert.equal(isSqliteMulticoreWorker({ NINEROUTER_WORKER_ROLE: "api", SQLITE_MULTICORE: "redis" }), true);
});

test("driver: multicore api worker opens read-only and never migrates", async () => {
  const seen = [];
  const opened = [];
  const openers = [
    { name: "fake-native", workerSafe: true, open: (opts) => { seen.push(opts); const a = { driver: "fake", readOnly: true, get: () => ({ value: String(SCHEMA_VERSION) }) }; opened.push(a); return a; } },
    { name: "sql.js", workerSafe: false, open: () => { throw new Error("sql.js must not be tried for a multicore worker"); } },
  ];
  const migrations = [];

  try {
    process.env.WORKER_ROLE = "api";
    process.env.SQLITE_MULTICORE = "redis";
    const adapter = await initAdapter({
      sqliteOpeners: openers,
      loadMigration: async () => ({ runMigrationOnce: async () => { migrations.push(1); } }),
    });

    assert.deepEqual(seen, [{ readOnly: true }], "worker must request a read-only open");
    assert.equal(adapter.readOnly, true);
    assert.equal(migrations.length, 0, "api worker must not run migrations");

    delete process.env.WORKER_ROLE;
    delete process.env.SQLITE_MULTICORE;
    const controlSeen = [];
    await initAdapter({
      sqliteOpeners: [{ name: "fake-native", workerSafe: true, open: (opts) => { controlSeen.push(opts); return { driver: "fake", get: () => ({ value: String(SCHEMA_VERSION) }) }; } }],
      loadMigration: async () => ({ runMigrationOnce: async () => { migrations.push(1); } }),
    });
    assert.deepEqual(controlSeen, [undefined], "control must keep the read-write open");
    assert.equal(migrations.length, 1, "control runs migrations");
  } finally {
    delete process.env.WORKER_ROLE;
    delete process.env.SQLITE_MULTICORE;
  }
});

test("driver: multicore api worker rejects sql.js when no native adapter opens", async () => {
  const tried = [];
  const openers = [
    { name: "fake-native", workerSafe: true, open: () => { tried.push("native"); return null; } },
    { name: "sql.js", workerSafe: false, open: () => { tried.push("sql.js"); return { driver: "sql.js" }; } },
  ];

  try {
    process.env.WORKER_ROLE = "api";
    process.env.SQLITE_MULTICORE = "redis";
    await assert.rejects(
      initAdapter({ sqliteOpeners: openers, loadMigration: async () => ({ runMigrationOnce: async () => {} }) }),
      /sql\.js is not supported in multicore mode/,
    );
    assert.deepEqual(tried, ["native"], "sql.js must not even be attempted for a multicore worker");

    // Same chain without the multicore opt-in still falls back to sql.js.
    delete process.env.SQLITE_MULTICORE;
    const adapter = await initAdapter({ sqliteOpeners: openers, loadMigration: async () => ({ runMigrationOnce: async () => {} }) });
    assert.equal(adapter.driver, "sql.js");
  } finally {
    delete process.env.WORKER_ROLE;
    delete process.env.SQLITE_MULTICORE;
  }
});

// ─── Schema: receipt ledger, monotonic version, single bump ──────────────

test("schema: receipt ledger and dbVersion tables are declared at one bumped version", () => {
  // v0.5.99 merge: upstream's per-key access columns joined TABLES, so the
  // "schema changed" backup must fire once for them too (6).
  assert.equal(SCHEMA_VERSION, 6, "requestLogs table bumps schema version once");
  assert.deepEqual(Object.keys(TABLES.sqliteMutationReceipts.columns), ["receiptId", "type", "workerId", "appliedAt", "result"]);
  assert.match(TABLES.sqliteMutationReceipts.columns.receiptId, /PRIMARY KEY/);
  assert.deepEqual(Object.keys(TABLES.dbVersion.columns), ["id", "version", "updatedAt"]);
  assert.match(TABLES.dbVersion.columns.version, /NOT NULL/);
});

test("schema: migrated database carries the receipt ledger and a duplicate receipt is a no-op", async () => {
  const file = dbFile("schema");
  const adapter = await createNodeSqliteAdapter(file);
  try {
    await runMigrationOnce(adapter);

    const tableNames = new Set(adapter.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name));
    assert.ok(tableNames.has("sqliteMutationReceipts"));
    assert.ok(tableNames.has("dbVersion"));
    assert.ok(tableNames.has("requestLogs"));
    assert.equal(adapter.get("SELECT value FROM _meta WHERE key = 'schemaVersion'").value, String(SCHEMA_VERSION));

    const insert = "INSERT INTO sqliteMutationReceipts(receiptId, type, workerId, appliedAt, result) VALUES(?, ?, ?, ?, ?)";
    adapter.run(insert, ["r-1", "usage.save", "w-1", new Date().toISOString(), null]);
    assert.throws(() => adapter.run(insert, ["r-1", "usage.save", "w-1", new Date().toISOString(), null]), /UNIQUE|PRIMARY KEY/i);
    assert.equal(adapter.get("SELECT COUNT(*) AS c FROM sqliteMutationReceipts").c, 1);

    adapter.run("INSERT INTO dbVersion(id, version, updatedAt) VALUES(1, 1, ?)", [new Date().toISOString()]);
    assert.equal(adapter.get("SELECT version FROM dbVersion WHERE id = 1").version, 1);
  } finally {
    adapter.close();
  }
});
