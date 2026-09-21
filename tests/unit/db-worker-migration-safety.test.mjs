// P1 worker-safety: DB_TYPE casing + API workers must not run DB migrations.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// DATA_DIR is resolved when src/lib/db/paths.js is first imported, so set it
// before any dynamic import below.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-worker-mig-"));
process.env.DATA_DIR = tempDir;

const KEYS = ["DATABASE_URL", "DB_TYPE", "WORKER_ROLE", "NINEROUTER_WORKER_ROLE"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

function restoreEnv() {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

function clearDbEnv() {
  delete process.env.DATABASE_URL;
  delete process.env.DB_TYPE;
  delete process.env.WORKER_ROLE;
  delete process.env.NINEROUTER_WORKER_ROLE;
}

// Counting migration loader: never touches a real DB, only records calls.
function countingMigrations() {
  const calls = [];
  return {
    calls,
    loadMigration: async () => ({ runMigrationOnce: async (adapter) => { calls.push(adapter); } }),
  };
}

const fakePostgresAdapter = {
  driver: "postgres",
  get: () => ({ ok: 1 }),
  all: () => [],
  run: () => {},
  exec: () => {},
  transaction: (fn) => fn(),
  close: () => {},
};

test("getDatabaseType normalizes DB_TYPE casing to postgres", async () => {
  clearDbEnv();
  const { getDatabaseType } = await import("../../src/lib/db/driver.js");
  try {
    assert.equal(getDatabaseType(), "sqlite");
    assert.equal(getDatabaseType({ DB_TYPE: "POSTGRES" }), "postgres");
    assert.equal(getDatabaseType({ DB_TYPE: "Postgres" }), "postgres");
    assert.equal(getDatabaseType({ DB_TYPE: "postgres" }), "postgres");
    assert.equal(getDatabaseType({ DB_TYPE: "sqlite" }), "sqlite");
    // DATABASE_URL behavior stays backward compatible: any non-empty value -> postgres.
    assert.equal(getDatabaseType({ DATABASE_URL: "postgres://u:p@h/db" }), "postgres");
  } finally {
    restoreEnv();
  }
});

test("isApiWorker true for api role via either env var, false for control", async () => {
  clearDbEnv();
  const { isApiWorker } = await import("../../src/lib/db/driver.js");
  try {
    assert.equal(isApiWorker({}), false);
    assert.equal(isApiWorker({ WORKER_ROLE: "control" }), false);
    assert.equal(isApiWorker({ WORKER_ROLE: "api" }), true);
    assert.equal(isApiWorker({ WORKER_ROLE: "API" }), true);
    assert.equal(isApiWorker({ NINEROUTER_WORKER_ROLE: "api" }), true);
  } finally {
    restoreEnv();
  }
});

test("postgres init path: API worker skips migration, control role runs it", async () => {
  clearDbEnv();
  process.env.DB_TYPE = "POSTGRES";
  process.env.DATABASE_URL = "postgres://u:p@localhost:5432/x";
  const { initAdapter } = await import("../../src/lib/db/driver.js");

  try {
    process.env.NINEROUTER_WORKER_ROLE = "api";
    const api = countingMigrations();
    const apiAdapter = await initAdapter({
      createPostgresAdapter: async () => fakePostgresAdapter,
      loadMigration: api.loadMigration,
    });
    assert.equal(api.calls.length, 0, "API worker must not run migrations");
    // Adapter still initialized and usable to serve API traffic.
    assert.equal(apiAdapter.driver, "postgres");
    assert.deepEqual(apiAdapter.get("SELECT 1"), { ok: 1 });

    delete process.env.NINEROUTER_WORKER_ROLE;
    process.env.WORKER_ROLE = "control";
    const ctrl = countingMigrations();
    const ctrlAdapter = await initAdapter({
      createPostgresAdapter: async () => fakePostgresAdapter,
      loadMigration: ctrl.loadMigration,
    });
    assert.equal(ctrl.calls.length, 1, "control role must run migrations once");
    assert.equal(ctrlAdapter.driver, "postgres");
  } finally {
    restoreEnv();
  }
});

test("sqlite init path: API worker skips migration, control role runs it", async () => {
  clearDbEnv();
  const { initAdapter } = await import("../../src/lib/db/driver.js");

  try {
    process.env.NINEROUTER_WORKER_ROLE = "api";
    const api = countingMigrations();
    const apiAdapter = await initAdapter({ loadMigration: api.loadMigration });
    assert.equal(api.calls.length, 0, "API worker must not run migrations on SQLite path");
    // SQLite adapter still initializes and is usable (no shared-file multiprocess migration).
    assert.ok(["better-sqlite3", "node:sqlite", "sql.js"].includes(apiAdapter.driver), apiAdapter.driver);
    try { apiAdapter.close?.(); } catch {}

    delete process.env.NINEROUTER_WORKER_ROLE;
    process.env.WORKER_ROLE = "control";
    const ctrl = countingMigrations();
    const ctrlAdapter = await initAdapter({ loadMigration: ctrl.loadMigration });
    assert.equal(ctrl.calls.length, 1, "control role must run migrations once on SQLite path");
    try { ctrlAdapter.close?.(); } catch {}
  } finally {
    restoreEnv();
  }
});