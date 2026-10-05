import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-schema-sync-"));
const originalDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = tempDir;

const { TABLES, SCHEMA_VERSION } = await import("../../src/lib/db/schema.js");
const { runMigrationOnce } = await import("../../src/lib/db/migrate.js");

after(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("postgres schema sync treats lowercase information_schema column names as existing", async () => {
  const alters = [];
  const adapter = {
    driver: "postgres",
    exec(sql) {
      if (/^ALTER TABLE/i.test(sql)) alters.push(sql);
    },
    all(_sql, [tableName]) {
      return Object.keys(TABLES[tableName].columns).map((name) => ({ name: name.toLowerCase() }));
    },
    get(sql, params = []) {
      if (/SELECT COUNT\(\*\)/i.test(sql)) return { c: 1 };
      if (params[0] === "migrationVersion") return { value: "1" };
      if (params[0] === "backupSchemaVersion") return { value: String(SCHEMA_VERSION) };
      return undefined;
    },
    run() {},
    transaction(fn) { return fn(); },
  };

  await runMigrationOnce(adapter);

  assert.deepEqual(alters, []);
});

test("postgres schema sync makes missing-column ALTER idempotent", async () => {
  const alters = [];
  const adapter = {
    driver: "postgres",
    exec(sql) {
      if (/^ALTER TABLE/i.test(sql)) alters.push(sql);
    },
    all() {
      return [];
    },
    get(sql, params = []) {
      if (/SELECT COUNT\(\*\)/i.test(sql)) return { c: 1 };
      if (params[0] === "migrationVersion") return { value: "1" };
      if (params[0] === "backupSchemaVersion") return { value: String(SCHEMA_VERSION) };
      return undefined;
    },
    run() {},
    transaction(fn) { return fn(); },
  };

  await runMigrationOnce(adapter);

  assert.ok(alters.some((sql) => /ALTER TABLE requestLogs ADD COLUMN IF NOT EXISTS id INTEGER/i.test(sql)));
});

test("postgres schema sync fails closed when a missing column cannot be added", async () => {
  const meta = new Map([
    ["migrationVersion", "1"],
    ["backupSchemaVersion", String(SCHEMA_VERSION)],
    ["schemaVersion", String(SCHEMA_VERSION)],
  ]);
  let firstTable = true;
  const adapter = {
    driver: "postgres",
    exec(sql) {
      if (/^ALTER TABLE/i.test(sql)) throw new Error("permission denied");
    },
    all(_sql, [tableName]) {
      const names = Object.keys(TABLES[tableName].columns).map((name) => name.toLowerCase());
      if (firstTable) {
        firstTable = false;
        names.pop();
      }
      return names.map((name) => ({ name }));
    },
    get(_sql, [key] = []) {
      return meta.has(key) ? { value: meta.get(key) } : undefined;
    },
    run(sql, [key, value] = []) {
      if (/^DELETE FROM _meta/i.test(sql)) meta.delete(key);
      else if (/^INSERT INTO _meta/i.test(sql)) meta.set(key, String(value));
    },
    transaction(fn) { return fn(); },
  };

  await assert.rejects(runMigrationOnce(adapter), /permission denied/);
  assert.equal(meta.has("schemaVersion"), false, "failed sync must not republish readiness");
});
