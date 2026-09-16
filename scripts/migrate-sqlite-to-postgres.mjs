#!/usr/bin/env node
/**
 * scripts/migrate-sqlite-to-postgres.mjs
 *
 * Automated data migration utility to copy all tables and rows from an existing
 * 9Router SQLite database to a PostgreSQL instance.
 *
 * Usage:
 *   # Direct execution:
 *   DATABASE_URL="postgres://user:pass@localhost:5432/9router" node scripts/migrate-sqlite-to-postgres.mjs
 *
 *   # With custom SQLite path:
 *   SQLITE_FILE="/var/lib/9router/.9router/db/data.sqlite" DATABASE_URL="postgres://..." node scripts/migrate-sqlite-to-postgres.mjs
 *
 *   # Dry-run mode (read and report without writing to PostgreSQL):
 *   DATABASE_URL="postgres://..." node scripts/migrate-sqlite-to-postgres.mjs --dry-run
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import pg from "pg";
import { TABLES } from "../src/lib/db/schema.js";
import { DATA_FILE } from "../src/lib/db/paths.js";
import { TABLE_PKS } from "../src/lib/db/adapters/postgresAdapter.js";

const { Pool } = pg;

export async function migrateSqliteToPostgres(options = {}) {
  const sqlitePath = options.sqlitePath || process.env.SQLITE_FILE || DATA_FILE;
  const postgresUrl = options.postgresUrl || process.env.DATABASE_URL;
  const dryRun = options.dryRun || process.argv.includes("--dry-run");
  const batchSize = options.batchSize || 200;

  if (!fs.existsSync(sqlitePath)) {
    throw new Error(`SQLite database file not found at: ${sqlitePath}`);
  }

  if (!postgresUrl && !dryRun) {
    throw new Error("DATABASE_URL environment variable is required to migrate to PostgreSQL.");
  }

  const sqlite = new Database(sqlitePath, { readonly: true });
  const pool = postgresUrl ? new Pool({ connectionString: postgresUrl }) : null;

  const results = {
    source: sqlitePath,
    target: postgresUrl ? postgresUrl.replace(/:[^:@]+@/, ":***@") : "none (dry-run)",
    dryRun,
    tables: {},
    totalRows: 0,
    errors: [],
  };

  try {
    // 1. Fetch available tables in SQLite
    const sqliteTables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => r.name);

    for (const tableName of Object.keys(TABLES)) {
      if (!sqliteTables.includes(tableName)) {
        continue;
      }

      // Count source rows
      const countRow = sqlite.prepare(`SELECT COUNT(*) as c FROM ${tableName}`).get();
      const count = countRow?.c || 0;
      results.tables[tableName] = { sourceRows: count, migratedRows: 0 };
      results.totalRows += count;

      if (count === 0) continue;
      if (dryRun) continue;

      // 2. Read rows from SQLite and upsert into PostgreSQL
      const rows = sqlite.prepare(`SELECT * FROM ${tableName}`).all();
      const pks = TABLE_PKS[tableName.toLowerCase()] || ["id"];
      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        for (let i = 0; i < rows.length; i += batchSize) {
          const chunk = rows.slice(i, i + batchSize);
          for (const row of chunk) {
            const cols = Object.keys(row);
            const vals = Object.values(row);
            const placeholders = cols.map((_, idx) => `$${idx + 1}`).join(", ");
            // Identifiers stay unquoted: the app creates tables/columns with
            // unquoted camelCase names (migrate.js syncSchemaFromTables), so
            // PostgreSQL folds them to lowercase. Quoting here would target a
            // different, non-existent table (e.g. "providerConnections").
            const quotedCols = cols.join(", ");

            // Conflict update clause
            const updateCols = cols
              .filter((c) => !pks.map((p) => p.toLowerCase()).includes(c.toLowerCase()))
              .map((c) => `${c} = EXCLUDED.${c}`)
              .join(", ");

            const conflictClause = updateCols.length > 0
              ? `ON CONFLICT (${pks.join(", ")}) DO UPDATE SET ${updateCols}`
              : `ON CONFLICT (${pks.join(", ")}) DO NOTHING`;

            const query = `INSERT INTO ${tableName} (${quotedCols}) VALUES (${placeholders}) ${conflictClause}`;
            await client.query(query, vals);
            results.tables[tableName].migratedRows++;
          }
        }

        // Adjust sequence for auto-increment tables if id column exists
        if (colsHaveAutoIncrement(tableName)) {
          const maxSeqRes = await client.query(`SELECT COALESCE(MAX(id), 0) as max_id FROM ${tableName}`);
          const maxId = maxSeqRes.rows[0]?.max_id || 0;
          if (maxId > 0) {
            const seqNameRes = await client.query(
              `SELECT pg_get_serial_sequence($1, 'id') as seq_name`,
              [tableName]
            );
            const seqName = seqNameRes.rows[0]?.seq_name;
            if (seqName) {
              await client.query(`SELECT setval($1, $2, true)`, [seqName, maxId]);
            }
          }
        }

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        results.errors.push({ table: tableName, error: err.message });
        throw err;
      } finally {
        client.release();
      }
    }

    return results;
  } finally {
    try { sqlite.close(); } catch {}
    if (pool) {
      try { await pool.end(); } catch {}
    }
  }
}

function colsHaveAutoIncrement(tableName) {
  const def = TABLES[tableName];
  if (!def?.columns) return false;
  return Object.values(def.columns).some((col) => /AUTOINCREMENT/i.test(col));
}

// CLI runner
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log("=== 9Router SQLite to PostgreSQL Migration ===");
  migrateSqliteToPostgres()
    .then((res) => {
      console.log("\nMigration Summary:");
      console.log(`- Source: ${res.source}`);
      console.log(`- Target: ${res.target}`);
      console.log(`- Dry run: ${res.dryRun ? "YES" : "NO"}`);
      console.log(`- Total source rows: ${res.totalRows}`);
      console.log("\nTables status:");
      for (const [t, info] of Object.entries(res.tables)) {
        console.log(`  ${t.padEnd(25)} : ${info.sourceRows} rows -> ${info.migratedRows} migrated`);
      }
      if (res.errors.length > 0) {
        console.error("\nErrors encountered:", res.errors);
        process.exit(1);
      }
      console.log("\n✅ Migration completed successfully!");
      process.exit(0);
    })
    .catch((err) => {
      console.error("\n❌ Migration failed:", err.message);
      process.exit(1);
    });
}
