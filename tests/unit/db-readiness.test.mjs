// Task 1 of docs/superpowers/plans/2026-09-22-db-readiness-barrier.md
//
//   * sqlite single-process: the real adapter (control role, migrated) reports
//     ready at the current SCHEMA_VERSION.
//   * postgres-neutral: the probe is driver-agnostic; every branch is driven
//     through injected adapters, so no PostgreSQL server is required.
//   * the payload never carries the connection string or raw driver error text.
//   * a rejected adapter initialization clears initPromise so a later probe can
//     recover without restarting the process.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-ready-"));
const envBefore = {
  DATA_DIR: process.env.DATA_DIR,
  DB_TYPE: process.env.DB_TYPE,
  DATABASE_URL: process.env.DATABASE_URL,
  WORKER_ROLE: process.env.WORKER_ROLE,
  NINEROUTER_WORKER_ROLE: process.env.NINEROUTER_WORKER_ROLE,
};

// Isolated data dir + sqlite control role, decided before the driver module
// reads DATA_DIR at import time.
process.env.DATA_DIR = tmpDir;
delete process.env.DB_TYPE;
delete process.env.DATABASE_URL;
delete process.env.WORKER_ROLE;
delete process.env.NINEROUTER_WORKER_ROLE;

register(new URL("./helpers/alias-loader.mjs", import.meta.url));

const { SCHEMA_VERSION } = await import("../../src/lib/db/schema.js");
const { checkDatabaseReady } = await import("../../src/lib/db/readiness.js");
const { getAdapter } = await import("../../src/lib/db/driver.js");
const { GET } = await import("../../src/app/api/ready/route.js");

const SECRET_URL = "postgres://ninerouter:sup3rsecret@db.internal:5432/ninerouter";

function makeAdapter({ value, driver = "postgres", throwOnGet = null, seen } = {}) {
  return {
    driver,
    get(sql, params) {
      if (seen) seen.push({ sql, params });
      if (throwOnGet) throw throwOnGet;
      return value === undefined ? undefined : { value };
    },
    close() {},
  };
}

// driver.js binds `state` to global._dbAdapter at import time, so tests mutate
// fields instead of deleting the global.
function resetAdapterState() {
  global._dbAdapter.instance = null;
  global._dbAdapter.initPromise = null;
}

function restoreEnv(name) {
  if (envBefore[name] === undefined) delete process.env[name];
  else process.env[name] = envBefore[name];
}

after(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  for (const name of Object.keys(envBefore)) restoreEnv(name);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── SQLite single-process ───────────────────────────────────────────────

test("sqlite single-process: real migrated adapter is ready at the current schema", async () => {
  resetAdapterState();
  const adapter = await getAdapter();
  assert.match(adapter.driver, /sqlite/);

  const result = await checkDatabaseReady();
  assert.equal(result.ready, true);
  assert.equal(result.schemaVersion, SCHEMA_VERSION);
  assert.match(result.database, /sqlite/);
  assert.ok(Number.isFinite(result.latencyMs) && result.latencyMs >= 0);
});

test("sqlite single-process: a legacy DB whose cursor lived in schemaVersion still migrates", async () => {
  const { latestVersion } = await import("../../src/lib/db/migrations/index.js");
  const db = await getAdapter();
  assert.equal(db.get(`SELECT value FROM _meta WHERE key = 'migrationVersion'`).value, String(latestVersion()));
  assert.equal(db.get(`SELECT value FROM _meta WHERE key = 'schemaVersion'`).value, String(SCHEMA_VERSION));

  // Legacy shape: no migrationVersion, cursor parked in schemaVersion.
  db.run(`DELETE FROM _meta WHERE key = 'migrationVersion'`);
  db.run(`UPDATE _meta SET value = '0' WHERE key = 'schemaVersion'`);
  db.close?.();

  resetAdapterState();
  const reborn = await getAdapter();
  assert.equal(
    reborn.get(`SELECT value FROM _meta WHERE key = 'migrationVersion'`).value,
    String(latestVersion()),
    "legacy cursor must still drive the migration chain",
  );
  assert.equal(
    reborn.get(`SELECT value FROM _meta WHERE key = 'schemaVersion'`).value,
    String(SCHEMA_VERSION),
    "schema marker must be (re)published by the control process",
  );
});

test("sqlite single-process: legacy cursor already at the target is converted, not re-read from the marker", async () => {
  const { latestVersion } = await import("../../src/lib/db/migrations/index.js");
  const db = await getAdapter();
  // Legacy shape at the newest migration: pre-cursor builds parked the migration
  // number in schemaVersion, so the chain has nothing left to apply.
  db.run(`DELETE FROM _meta WHERE key = 'migrationVersion'`);
  db.run(`UPDATE _meta SET value = ? WHERE key = 'schemaVersion'`, [String(latestVersion())]);
  db.close?.();

  resetAdapterState();
  const reborn = await getAdapter();

  assert.equal(
    reborn.get(`SELECT value FROM _meta WHERE key = 'migrationVersion'`).value,
    String(latestVersion()),
    "the legacy value must be stamped into the cursor key before the marker overwrites schemaVersion",
  );
  assert.equal(
    reborn.get(`SELECT value FROM _meta WHERE key = 'schemaVersion'`).value,
    String(SCHEMA_VERSION),
  );
  const result = await checkDatabaseReady();
  assert.equal(result.ready, true, "a converted legacy DB must still report ready");
});

test("sqlite single-process: a readiness marker above the cursor never hides a pending migration", async () => {
  const { latestVersion } = await import("../../src/lib/db/migrations/index.js");
  // The guard is only meaningful while the two lineages differ: the marker is a
  // schema number, the cursor is a migration number.
  assert.ok(
    SCHEMA_VERSION > latestVersion(),
    "test premise: SCHEMA_VERSION must exceed latestVersion() for this collision to be reachable",
  );

  const db = await getAdapter();
  // Legacy shape: the cursor key is gone and the marker sits above the newest
  // migration. A runner that adopts the marker verbatim stamps a cursor past the
  // end of the chain and silently skips the pending migration.
  db.run(`DELETE FROM _meta WHERE key = 'migrationVersion'`);
  db.run(`UPDATE _meta SET value = ? WHERE key = 'schemaVersion'`, [String(SCHEMA_VERSION)]);
  db.close?.();

  resetAdapterState();
  const reborn = await getAdapter();

  assert.equal(
    reborn.get(`SELECT value FROM _meta WHERE key = 'migrationVersion'`).value,
    String(latestVersion()),
    "the pending migration must run and restamp the cursor, not be skipped by the higher marker",
  );
  assert.equal(
    reborn.get(`SELECT value FROM _meta WHERE key = 'schemaVersion'`).value,
    String(SCHEMA_VERSION),
  );
});

// ─── PostgreSQL-neutral branches (injected adapter, no server) ───────────

test("postgres-neutral: matching _meta.schemaVersion is ready", async () => {
  const seen = [];
  const adapter = makeAdapter({ value: String(SCHEMA_VERSION), seen });

  const result = await checkDatabaseReady({ getAdapter: async () => adapter });

  assert.equal(result.ready, true);
  assert.equal(result.database, "postgres");
  assert.equal(result.schemaVersion, SCHEMA_VERSION);
  assert.ok(Number.isFinite(result.latencyMs));
  assert.equal(result.reason, undefined);
  assert.equal(result.error, undefined);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].sql, "SELECT value FROM _meta WHERE key = ?");
  assert.deepEqual(seen[0].params, ["schemaVersion"]);
});

test("postgres-neutral: expected schema version is injectable", async () => {
  const adapter = makeAdapter({ value: "7" });
  const result = await checkDatabaseReady({ getAdapter: async () => adapter, schemaVersion: 7 });
  assert.equal(result.ready, true);
  assert.equal(result.schemaVersion, 7);
});

test("postgres-neutral: missing schema marker is not ready", async () => {
  const result = await checkDatabaseReady({ getAdapter: async () => makeAdapter({}) });
  assert.equal(result.ready, false);
  assert.equal(result.reason, "schema_missing");
  assert.equal(result.schemaVersion, undefined);
});

test("postgres-neutral: blank schema markers are treated as missing", async () => {
  for (const value of ["", "   "]) {
    const result = await checkDatabaseReady({ getAdapter: async () => makeAdapter({ value }) });
    assert.equal(result.ready, false);
    assert.equal(result.reason, "schema_missing", `value ${JSON.stringify(value)}`);
  }
});

test("postgres-neutral: non-integer schema markers are not ready", async () => {
  for (const value of ["abc", "3.5", "3abc", "NaN", "1e400"]) {
    const result = await checkDatabaseReady({ getAdapter: async () => makeAdapter({ value }) });
    assert.equal(result.ready, false, `value ${JSON.stringify(value)} must not be ready`);
    assert.equal(result.reason, "schema_invalid", `value ${JSON.stringify(value)}`);
  }
});

test("postgres-neutral: stale or future schema version is not ready", async () => {
  for (const value of [String(SCHEMA_VERSION - 1), String(SCHEMA_VERSION + 1), "0"]) {
    const result = await checkDatabaseReady({ getAdapter: async () => makeAdapter({ value }) });
    assert.equal(result.ready, false);
    assert.equal(result.reason, "schema_mismatch");
    assert.equal(result.schemaVersion, undefined);
  }
});

test("postgres-neutral: adapter initialization failure is a safe not-ready result", async () => {
  const result = await checkDatabaseReady({
    getAdapter: async () => {
      throw new Error(`connect ECONNREFUSED ${SECRET_URL}`);
    },
  });

  assert.equal(result.ready, false);
  assert.equal(result.reason, "adapter_error");
  assert.ok(Number.isFinite(result.latencyMs));
  assert.ok(["postgres", "sqlite"].includes(result.database), "database stays a driver type");
  const json = JSON.stringify(result);
  for (const leak of ["sup3rsecret", "postgres://", "ECONNREFUSED", "db.internal"]) {
    assert.ok(!json.includes(leak), `payload leaked ${leak}`);
  }
  assert.equal(result.error, undefined);
  assert.equal(result.message, undefined);
  assert.equal(result.schemaVersion, undefined);
});

test("postgres-neutral: schema read failure is a safe not-ready result", async () => {
  const result = await checkDatabaseReady({
    getAdapter: async () => makeAdapter({
      throwOnGet: new Error(`relation "_meta" does not exist — ${SECRET_URL}`),
    }),
  });

  assert.equal(result.ready, false);
  assert.equal(result.reason, "schema_read_failed");
  const json = JSON.stringify(result);
  for (const leak of ["sup3rsecret", "postgres://", "does not exist"]) {
    assert.ok(!json.includes(leak), `payload leaked ${leak}`);
  }
});

test("postgres-neutral: adapter initialization timeout is not ready", async () => {
  const started = Date.now();
  const result = await checkDatabaseReady({
    getAdapter: () => new Promise(() => {}),
    timeoutMs: 25,
  });

  assert.equal(result.ready, false);
  assert.equal(result.reason, "timeout");
  assert.ok(Date.now() - started < 5000, "probe must not hang");
  assert.ok(Number.isFinite(result.latencyMs));
});

// ─── Driver retry ────────────────────────────────────────────────────────

test("driver: rejected initialization clears initPromise so a retry recovers", async () => {
  resetAdapterState();
  process.env.DB_TYPE = "postgres";
  const loadMigration = async () => ({ runMigrationOnce: async () => {} });
  const recoveredAdapter = makeAdapter({ value: String(SCHEMA_VERSION) });

  try {
    const first = getAdapter({
      createPostgresAdapter: async () => { throw new Error(`pg unavailable ${SECRET_URL}`); },
      loadMigration,
    });
    await assert.rejects(first, /pg unavailable/);
    assert.equal(global._dbAdapter.initPromise, null, "rejected initPromise must be cleared");
    assert.equal(global._dbAdapter.instance, null);

    const recovered = await getAdapter({
      createPostgresAdapter: async () => recoveredAdapter,
      loadMigration,
    });
    assert.equal(recovered, recoveredAdapter);
    assert.equal(global._dbAdapter.instance, recoveredAdapter);

    const result = await checkDatabaseReady();
    assert.equal(result.ready, true, "probe must recover after a transient init failure");
  } finally {
    restoreEnv("DB_TYPE");
    resetAdapterState();
  }
});

test("driver: retried initialization does not leak adapter handles", async (t) => {
  if (process.platform !== "linux") return t.skip("fd accounting needs /proc");
  resetAdapterState();
  process.env.DB_TYPE = "sqlite";
  const openFds = () => fs.readdirSync("/proc/self/fd").length;
  // Both failure points: the migration module itself failing to load, and the
  // migration running but throwing. The first throws before runMigrationOnce
  // exists, so it only closes if the whole migrate step is guarded.
  const failingLoads = [
    { name: "migration import throws", loadMigration: async () => { throw new Error("migration failed"); } },
    { name: "migration run throws", loadMigration: async () => ({ runMigrationOnce: async () => { throw new Error("migration failed"); } }) },
  ];

  try {
    for (const { name, loadMigration } of failingLoads) {
      await assert.rejects(getAdapter({ loadMigration }), /migration failed/, name);
      const before = openFds();
      for (let i = 0; i < 25; i++) {
        await assert.rejects(getAdapter({ loadMigration }), /migration failed/, name);
      }
      assert.equal(openFds(), before, `${name}: each failed retry must close its adapter, not leak the sqlite handle`);
      assert.equal(global._dbAdapter.instance, null, "a failed init must not publish an instance");
    }
  } finally {
    restoreEnv("DB_TYPE");
    resetAdapterState();
  }
});

// ─── GET /api/ready ──────────────────────────────────────────────────────

test("GET /api/ready: 200 + no-store when the database is ready", async () => {
  resetAdapterState();
  await getAdapter();

  const res = await GET();

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();
  assert.equal(body.ready, true);
  assert.equal(body.schemaVersion, SCHEMA_VERSION);
  assert.match(body.database, /sqlite/);
});

test("GET /api/ready: 503 + no-store without leaking details when unavailable", async () => {
  resetAdapterState();
  const rejected = Promise.reject(new Error(`connect ECONNREFUSED ${SECRET_URL}`));
  rejected.catch(() => {});
  global._dbAdapter.initPromise = rejected;

  const res = await GET();

  assert.equal(res.status, 503);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const text = await res.text();
  for (const leak of ["sup3rsecret", "postgres://", "ECONNREFUSED", "db.internal"]) {
    assert.ok(!text.includes(leak), `response leaked ${leak}`);
  }
  const body = JSON.parse(text);
  assert.equal(body.ready, false);
  assert.equal(typeof body.reason, "string");
  assert.equal(body.error, undefined);
});

// ─── Legacy import abort ─────────────────────────────────────────────────

// Runs last: it wipes the sqlite file to get a fresh DB again, then leaves the
// DB half-imported on purpose.
test("sqlite single-process: an aborted legacy import never publishes the readiness marker", async () => {
  const { DB_DIR, DATA_FILE, LEGACY_FILES } = await import("../../src/lib/db/paths.js");
  const importMarker = path.join(DB_DIR, ".migrated-from-json");

  global._dbAdapter?.instance?.close?.();
  resetAdapterState();
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(DATA_FILE + suffix, { force: true });
  fs.rmSync(importMarker, { force: true });

  // Two apiKeys sharing an id → the import's row-count assertion fails → the
  // transaction aborts (MigrationAborted) and runMigrationOnce returns early.
  fs.writeFileSync(LEGACY_FILES.main, JSON.stringify({
    apiKeys: [
      { id: "dup", key: "a", name: "a" },
      { id: "dup", key: "b", name: "b" },
    ],
  }));

  try {
    const adapter = await getAdapter();
    assert.equal(
      adapter.get(`SELECT value FROM _meta WHERE key = 'schemaVersion'`),
      undefined,
      "no readiness marker may be published for a half-imported DB",
    );

    const result = await checkDatabaseReady();
    assert.equal(result.ready, false);
    assert.equal(result.reason, "schema_missing");

    const res = await GET();
    assert.equal(res.status, 503);
    assert.equal(fs.existsSync(importMarker), false, "the migrated-from-json marker must not be written");
  } finally {
    fs.rmSync(LEGACY_FILES.main, { force: true });
  }
});
