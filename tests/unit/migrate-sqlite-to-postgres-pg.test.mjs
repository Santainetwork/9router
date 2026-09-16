import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import pg from "pg";
import { TABLES, buildCreateTableSql } from "../../src/lib/db/schema.js";
import { migrateSqliteToPostgres } from "../../scripts/migrate-sqlite-to-postgres.mjs";

// Requires a live, empty PostgreSQL reachable via MIGRATE_TEST_PG_URL.
// Run standalone with: bash scripts/test-migration-postgres.sh
const PG_URL = process.env.MIGRATE_TEST_PG_URL;

// Rows we plant in the SQLite source. Kept small but covering every table,
// both PK shapes (text/serial/composite), nulls, unicode, floats and JSON text.
const SEED = {
  _meta: [
    { key: "schemaVersion", value: "3" },
    { key: "appVersion", value: "0.5.75-custom" },
  ],
  settings: [{ id: 1, data: JSON.stringify({ appName: "SantaiNetwork" }) }],
  providerConnections: [
    { id: "pc-1", provider: "anthropic", authType: "oauth", name: "Primary", email: null, priority: 1, isActive: 1, data: '{"a":1}', createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" },
    { id: "pc-2", provider: "openai", authType: "apikey", name: "Secondary", email: "x@example.com", priority: 2, isActive: 0, data: '{"b":2}', createdAt: "2026-01-03T00:00:00.000Z", updatedAt: "2026-01-04T00:00:00.000Z" },
  ],
  providerNodes: [
    { id: "pn-1", type: "custom", name: "Node 1", data: '{"c":3}', createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
  ],
  proxyPools: [
    { id: "pp-1", isActive: 1, testStatus: "ok", data: '{"host":"10.0.0.1"}', createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
  ],
  apiKeys: [
    // allowedModels is stored as a JSON array of model ids (see apiKeysRepo.parseAllowedModels)
    { id: "ak-1", key: "sk-" + "a".repeat(40), name: "Key One", machineId: "m1", isActive: 1, createdAt: "2026-01-01T00:00:00.000Z", rpm: 120, concurrency: 4, queueTimeoutMs: 30000, allowedModels: '["hx/*","ag/*"]', tokenQuota: 1000000 },
    { id: "ak-2", key: "sk-" + "b".repeat(40), name: "Key Two", machineId: null, isActive: 0, createdAt: "2026-01-02T00:00:00.000Z", rpm: 0, concurrency: 0, queueTimeoutMs: 0, allowedModels: null, tokenQuota: 0 },
  ],
  combos: [
    { id: "cb-1", name: "combo-one", kind: "fallback", models: '["ag/claude-sonnet-4-6","bai/deepseek-v4-flash"]', createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
  ],
  kv: [
    { scope: "modelAliases", key: "fast", value: '{"target":"ag/claude-haiku"}' },
    { scope: "modelAliases", key: "smart", value: '{"target":"ag/claude-sonnet-4-6"}' },
    { scope: "ui", key: "theme", value: '"dark"' },
  ],
  usageHistory: [
    { id: 1, timestamp: "2026-02-01T10:00:00.000Z", provider: "anthropic", model: "ag/claude-sonnet-4-6", connectionId: "pc-1", apiKey: "ak-1", endpoint: "/v1/messages", promptTokens: 1200, completionTokens: 3400, cost: 0.05125, status: "success", tokens: '{"cached":800}', meta: '{"requestedModel":"claude-sonnet-4-6","upstreamModel":"ag/claude-sonnet-4-6"}' },
    { id: 2, timestamp: "2026-02-01T11:00:00.000Z", provider: "openai", model: "bai/deepseek-v4-flash", connectionId: "pc-2", apiKey: null, endpoint: "/v1/chat/completions", promptTokens: 0, completionTokens: 0, cost: 0, status: "error", tokens: null, meta: null },
  ],
  usageDaily: [
    { dateKey: "2026-02-01", data: '{"requests":2,"cost":0.05125}' },
    { dateKey: "2026-02-02", data: '{"requests":0,"cost":0}' },
  ],
  requestDetails: [
    { id: "rd-1", timestamp: "2026-02-01T10:00:00.000Z", provider: "anthropic", model: "ag/claude-sonnet-4-6", connectionId: "pc-1", status: "success", data: "<truncated>" },
  ],
  provider_footer_logs: [
    { id: 1, timestamp: "2026-02-01T10:00:00.000Z", provider: "anthropic", model: "ag/claude-sonnet-4-6", referral_text: "santai.network" },
    { id: 2, timestamp: "2026-02-01T11:00:00.000Z", provider: "openai", model: "bai/deepseek-v4-flash", referral_text: "santai.network" },
  ],
};

// Tables the migrator copies (must exist in both schemas).
const MIGRATED_TABLES = Object.keys(TABLES);

function seedSqlite(file) {
  const db = new Database(file);
  for (const table of MIGRATED_TABLES) {
    db.exec(buildCreateTableSql(table, TABLES[table], "sqlite"));
    const rows = SEED[table] || [];
    for (const row of rows) {
      const cols = Object.keys(row);
      db.prepare(
        `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`
      ).run(...Object.values(row));
    }
  }
  db.close();
}

// Postgres schema = same DDL + indexes the app applies on boot (migrate.js
// syncSchemaFromTables), replayed against a raw client. Identifiers stay
// unquoted so PostgreSQL folds camelCase to lowercase, matching what the app
// itself creates and what the migrator's quoted inserts expect.
async function createPostgresSchema(client) {
  for (const table of MIGRATED_TABLES) {
    await client.query(buildCreateTableSql(table, TABLES[table], "postgres"));
    for (const idx of TABLES[table].indexes || []) {
      await client.query(idx);
    }
  }
}

function serialize(v) {
  if (v === null || v === undefined) return v;
  if (typeof v === "number" || typeof v === "boolean") return Number(v);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

const suites = PG_URL ? [suite] : [];
if (!PG_URL) {
  test("migrate-sqlite-to-postgres - live postgres migration (skipped: MIGRATE_TEST_PG_URL unset)", { skip: true }, () => {});
}
for (const s of suites) s();

function suite() {
  test("migrate-sqlite-to-postgres - migrates every table into real postgres with row counts and values intact", async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-migrate-pg-"));
    const sqlitePath = path.join(dir, "seed.sqlite");
    seedSqlite(sqlitePath);

    const { Pool } = pg;
    const pool = new Pool({ connectionString: PG_URL });
    const client = await pool.connect();

    try {
      await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
      await createPostgresSchema(client);

      await t.test("dry-run reports source counts without writing", async () => {
        const res = await migrateSqliteToPostgres({ sqlitePath, postgresUrl: PG_URL, dryRun: true });
        const expectedTotal = Object.values(SEED).reduce((n, rows) => n + rows.length, 0);
        assert.equal(res.dryRun, true);
        assert.equal(res.errors.length, 0);
        assert.equal(res.totalRows, expectedTotal);
        for (const [table, rows] of Object.entries(SEED)) {
          assert.equal(res.tables[table].sourceRows, rows.length, `${table} source count`);
          assert.equal(res.tables[table].migratedRows, 0, `${table} dry-run must not migrate`);
        }
        for (const table of MIGRATED_TABLES) {
          const { rows } = await client.query(`SELECT COUNT(*)::int AS c FROM ${table}`);
          assert.equal(rows[0].c, 0, `${table} must stay empty after dry-run`);
        }
      });

      await t.test("real migration copies rows and preserves values", async () => {
        const res = await migrateSqliteToPostgres({ sqlitePath, postgresUrl: PG_URL });
        assert.equal(res.dryRun, false);
        assert.equal(res.errors.length, 0);

        for (const [table, rows] of Object.entries(SEED)) {
          assert.equal(res.tables[table].migratedRows, rows.length, `${table} migrated count`);
        }
        for (const table of MIGRATED_TABLES) {
          const expected = (SEED[table] || []).length;
          const { rows } = await client.query(`SELECT COUNT(*)::int AS c FROM ${table}`);
          assert.equal(rows[0].c, expected, `${table} row count in postgres`);
        }
      });

      await t.test("spot-check row values across PK shapes", async () => {
        const settings = await client.query("SELECT * FROM settings WHERE id = 1");
        assert.equal(settings.rows.length, 1);
        assert.equal(JSON.parse(settings.rows[0].data).appName, "SantaiNetwork");

        const meta = await client.query('SELECT * FROM _meta WHERE "key" = $1', ["appVersion"]);
        assert.equal(meta.rows[0].value, "0.5.75-custom");

        const apiKey = await client.query("SELECT * FROM apiKeys WHERE id = $1", ["ak-1"]);
        assert.equal(apiKey.rows[0].name, "Key One");
        assert.deepEqual(JSON.parse(apiKey.rows[0].allowedmodels), ["hx/*", "ag/*"]);
        assert.equal(Number(apiKey.rows[0].tokenquota), 1000000);
        assert.equal(Number(apiKey.rows[0].isactive), 1);

        // NULL preservation
        const apiKey2 = await client.query("SELECT * FROM apiKeys WHERE id = $1", ["ak-2"]);
        assert.equal(apiKey2.rows[0].machineid, null);
        const usage2 = await client.query("SELECT * FROM usagehistory WHERE id = 2");
        assert.equal(usage2.rows[0].apikey, null);
        assert.equal(usage2.rows[0].tokens, null);
        assert.equal(usage2.rows[0].meta, null);

        // REAL / float fidelity
        const usage1 = await client.query("SELECT * FROM usagehistory WHERE id = 1");
        assert.equal(Number(usage1.rows[0].cost), 0.05125);
        assert.equal(Number(usage1.rows[0].prompttokens), 1200);
        assert.equal(JSON.parse(usage1.rows[0].meta).upstreamModel, "ag/claude-sonnet-4-6");

        // Composite PK table round-trip
        const kv = await client.query('SELECT * FROM kv WHERE scope = $1 ORDER BY "key"', ["modelAliases"]);
        assert.equal(kv.rows.length, 2);
        assert.equal(kv.rows[0].key, "fast");
        assert.equal(JSON.parse(kv.rows[0].value).target, "ag/claude-haiku");
        const kvOther = await client.query("SELECT * FROM kv WHERE scope = $1", ["ui"]);
        assert.equal(kvOther.rows[0].value, '"dark"');

        const combo = await client.query("SELECT * FROM combos WHERE id = $1", ["cb-1"]);
        assert.deepEqual(JSON.parse(combo.rows[0].models), ["ag/claude-sonnet-4-6", "bai/deepseek-v4-flash"]);

        const footer = await client.query("SELECT * FROM provider_footer_logs ORDER BY id");
        assert.equal(footer.rows.length, 2);
        assert.equal(footer.rows[1].referral_text, "santai.network");
      });

      await t.test("re-running migration is idempotent (no duplicates)", async () => {
        const res = await migrateSqliteToPostgres({ sqlitePath, postgresUrl: PG_URL });
        assert.equal(res.errors.length, 0);
        for (const table of MIGRATED_TABLES) {
          const expected = (SEED[table] || []).length;
          const { rows } = await client.query(`SELECT COUNT(*)::int AS c FROM ${table}`);
          assert.equal(rows[0].c, expected, `${table} duplicated on re-run`);
        }
      });

      await t.test("auto-increment sequences realign so new inserts do not collide", async () => {
        const usage = await client.query(
          "INSERT INTO usagehistory (timestamp, provider, model) VALUES ($1, $2, $3) RETURNING id",
          ["2026-02-03T00:00:00.000Z", "anthropic", "ag/claude-sonnet-4-6"]
        );
        assert.equal(usage.rows[0].id, 3, "usageHistory sequence should continue past migrated max id");

        const footer = await client.query(
          "INSERT INTO provider_footer_logs (timestamp, provider, model, referral_text) VALUES ($1, $2, $3, $4) RETURNING id",
          ["2026-02-03T00:00:00.000Z", "anthropic", "ag/claude-sonnet-4-6", "santai.network"]
        );
        assert.equal(footer.rows[0].id, 3, "provider_footer_logs sequence should continue past migrated max id");
      });

      await t.test("secondary unique constraint survives (combos.name, apiKeys.key)", async () => {
        await assert.rejects(
          () => client.query("INSERT INTO combos (id, name, models, createdAt, updatedAt) VALUES ($1,$2,$3,$4,$5)",
            ["cb-2", "combo-one", "[]", "x", "x"]),
          /duplicate key|unique/i
        );
        await assert.rejects(
          () => client.query('INSERT INTO apiKeys (id, "key", createdAt) VALUES ($1,$2,$3)',
            ["ak-3", "sk-" + "a".repeat(40), "x"]),
          /duplicate key|unique/i
        );
      });

      // End-to-end: the real app adapter reads the migrated data back through
      // the same code path the running server uses (placeholder translation,
      // dialect normalization), proving rows land where the app looks for them.
      await t.test("app postgres adapter reads migrated rows back", async () => {
        const { createPostgresAdapter } = await import("../../src/lib/db/adapters/postgresAdapter.js");
        const adapter = await createPostgresAdapter(PG_URL);
        try {
          const keys = adapter.all("SELECT * FROM apiKeys ORDER BY id");
          assert.equal(keys.length, 2);
          assert.equal(keys[0].name, "Key One");
          assert.equal(Number(keys[0].tokenquota), 1000000);
          assert.equal(keys[1].machineid, null);

          const one = adapter.get("SELECT * FROM apiKeys WHERE id = ?", ["ak-1"]);
          assert.equal(one.key, "sk-" + "a".repeat(40));

          // 2 migrated rows + 1 inserted by the sequence-realignment subtest above
          const count = adapter.get("SELECT COUNT(*) as c FROM usageHistory");
          assert.equal(Number(count.c), 3);

          adapter.run("INSERT INTO kv (scope, key, value) VALUES (?, ?, ?)", ["test", "appWrite", '{"ok":true}']);
          const written = adapter.get("SELECT value FROM kv WHERE scope = ? AND key = ?", ["test", "appWrite"]);
          assert.equal(JSON.parse(written.value).ok, true);
        } finally {
          adapter.close();
        }
      });
    } finally {
      client.release();
      await pool.end();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
