import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ensurePostgresSchema, migrateSqliteToPostgres } from "../../scripts/migrate-sqlite-to-postgres.mjs";

test("migrate-sqlite-to-postgres - bootstraps an empty PostgreSQL schema", async () => {
  const queries = [];
  await ensurePostgresSchema({ query: async (sql) => { queries.push(sql); } });

  assert.match(queries[0], /CREATE TABLE IF NOT EXISTS _meta/);
  assert.ok(queries.some((sql) => /CREATE TABLE IF NOT EXISTS apiKeys/.test(sql)));
  assert.ok(queries.some((sql) => /CREATE INDEX IF NOT EXISTS idx_ak_key/.test(sql)));
});

test("migrate-sqlite-to-postgres - dry run reports all tables and row counts without postgres connection", async () => {
  const tempDbPath = path.join("/tmp", `test-migrate-source-${Date.now()}.sqlite`);
  const db = new Database(tempDbPath);

  try {
    db.exec(`
      CREATE TABLE settings (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
      INSERT INTO settings (id, data) VALUES (1, '{"appName":"SantaiNetwork"}');

      CREATE TABLE apiKeys (id TEXT PRIMARY KEY, key TEXT NOT NULL, name TEXT);
      INSERT INTO apiKeys (id, key, name) VALUES ('k1', 'sk-test1', 'Key 1');
      INSERT INTO apiKeys (id, key, name) VALUES ('k2', 'sk-test2', 'Key 2');
    `);

    const result = await migrateSqliteToPostgres({
      sqlitePath: tempDbPath,
      dryRun: true,
    });

    assert.equal(result.dryRun, true);
    assert.equal(result.tables.settings.sourceRows, 1);
    assert.equal(result.tables.settings.migratedRows, 0);
    assert.equal(result.tables.apiKeys.sourceRows, 2);
    assert.equal(result.tables.apiKeys.migratedRows, 0);
    assert.equal(result.totalRows, 3);
    assert.equal(result.errors.length, 0);
  } finally {
    db.close();
    try { fs.unlinkSync(tempDbPath); } catch {}
  }
});

test("migrate-sqlite-to-postgres - throws when sqlite file does not exist", async () => {
  await assert.rejects(
    async () => {
      await migrateSqliteToPostgres({
        sqlitePath: "/tmp/nonexistent-file-" + Date.now() + ".sqlite",
        dryRun: true,
      });
    },
    /SQLite database file not found/
  );
});

test("migrate-sqlite-to-postgres - throws when DATABASE_URL is missing and dryRun is false", async () => {
  const tempDbPath = path.join("/tmp", `test-migrate-missing-url-${Date.now()}.sqlite`);
  const db = new Database(tempDbPath);
  db.exec("CREATE TABLE settings (id INTEGER PRIMARY KEY, data TEXT);");
  db.close();

  try {
    await assert.rejects(
      async () => {
        await migrateSqliteToPostgres({
          sqlitePath: tempDbPath,
          postgresUrl: "",
          dryRun: false,
        });
      },
      /DATABASE_URL environment variable is required/
    );
  } finally {
    try { fs.unlinkSync(tempDbPath); } catch {}
  }
});
