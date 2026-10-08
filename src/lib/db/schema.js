// ⚠️ AGENT/DEV: Bump this by +1 EVERY TIME you change the schema below
// (add/remove/alter a table, column, or index in TABLES). It drives the
// pre-change safety backup in migrate.js: when the stored version is lower,
// one lightweight DB backup is taken before applying schema changes. Forgetting
// to bump only skips that backup — it does NOT break the additive auto-sync.
// Upstream v0.5.99 is at 2; this fork stays ahead (6) because it added the
// per-key access columns below, and the number only drives the pre-change
// backup — syncSchemaFromTables() still adds the columns itself.
export const SCHEMA_VERSION = 6;

export const PRAGMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 30000000;
PRAGMA cache_size = -64000;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
`;

// Read-only worker connections (SQLITE_MULTICORE=redis API workers) run only
// connection-local PRAGMAs: journal_mode/synchronous/temp_store/mmap_size/
// cache_size either need a writable handle or a -shm/-wal sidecar a reader must
// not touch. query_only is belt-and-braces on top of the read-only file flag.
export const READONLY_PRAGMA_SQL = `
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
PRAGMA query_only = ON;
`;

export class ReadOnlyAdapterError extends Error {
  constructor(operation) {
    super(`[DB] read-only SQLite worker connection cannot ${operation}`);
    this.name = "ReadOnlyAdapterError";
    this.code = "DB_READONLY_WORKER";
  }
}

// Replaces a write entry point so a worker fails loudly instead of dropping a
// mutation the single control writer never sees.
export function denyWrite(operation) {
  return () => { throw new ReadOnlyAdapterError(operation); };
}

// Declarative current schema. Used by syncSchemaFromTables() to
// auto-add missing tables/columns/indexes after versioned migrations.
// For destructive changes (drop/rename/type-change), write a migration file.
export const TABLES = {
  _meta: {
    columns: {
      key: "TEXT PRIMARY KEY",
      value: "TEXT NOT NULL",
    },
  },
  settings: {
    columns: {
      id: "INTEGER PRIMARY KEY CHECK (id = 1)",
      data: "TEXT NOT NULL",
    },
  },
  providerConnections: {
    columns: {
      id: "TEXT PRIMARY KEY",
      provider: "TEXT NOT NULL",
      authType: "TEXT NOT NULL",
      name: "TEXT",
      email: "TEXT",
      priority: "INTEGER",
      isActive: "INTEGER DEFAULT 1",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pc_provider ON providerConnections(provider)",
      "CREATE INDEX IF NOT EXISTS idx_pc_provider_active ON providerConnections(provider, isActive)",
      "CREATE INDEX IF NOT EXISTS idx_pc_priority ON providerConnections(provider, priority)",
    ],
  },
  providerNodes: {
    columns: {
      id: "TEXT PRIMARY KEY",
      type: "TEXT",
      name: "TEXT",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_pn_type ON providerNodes(type)"],
  },
  proxyPools: {
    columns: {
      id: "TEXT PRIMARY KEY",
      isActive: "INTEGER DEFAULT 1",
      testStatus: "TEXT",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pp_active ON proxyPools(isActive)",
      "CREATE INDEX IF NOT EXISTS idx_pp_status ON proxyPools(testStatus)",
    ],
  },
  apiKeys: {
    columns: {
      id: "TEXT PRIMARY KEY",
      key: "TEXT UNIQUE NOT NULL",
      name: "TEXT",
      machineId: "TEXT",
      isActive: "INTEGER DEFAULT 1",
      createdAt: "TEXT NOT NULL",
      rpm: "INTEGER DEFAULT 0",
      concurrency: "INTEGER DEFAULT 0",
      queueTimeoutMs: "INTEGER DEFAULT 0",
      allowedModels: "TEXT",
      tokenQuota: "INTEGER DEFAULT 0",
      // Per-key access control. Additive columns, picked up by
      // syncSchemaFromTables() on boot; existing rows read as unrestricted (0).
      accessRestricted: "INTEGER DEFAULT 0",
      accessAllow: "TEXT",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_ak_key ON apiKeys(key)"],
  },
  combos: {
    columns: {
      id: "TEXT PRIMARY KEY",
      name: "TEXT UNIQUE NOT NULL",
      kind: "TEXT",
      models: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_combo_name ON combos(name)"],
  },
  kv: {
    columns: {
      scope: "TEXT NOT NULL",
      key: "TEXT NOT NULL",
      value: "TEXT NOT NULL",
    },
    primaryKey: "PRIMARY KEY (scope, key)",
    indexes: ["CREATE INDEX IF NOT EXISTS idx_kv_scope ON kv(scope)"],
  },
  usageHistory: {
    columns: {
      id: "INTEGER PRIMARY KEY AUTOINCREMENT",
      timestamp: "TEXT NOT NULL",
      provider: "TEXT",
      model: "TEXT",
      connectionId: "TEXT",
      apiKey: "TEXT",
      endpoint: "TEXT",
      promptTokens: "INTEGER DEFAULT 0",
      completionTokens: "INTEGER DEFAULT 0",
      cost: "REAL DEFAULT 0",
      status: "TEXT",
      tokens: "TEXT",
      meta: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_uh_ts ON usageHistory(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_uh_provider ON usageHistory(provider)",
      "CREATE INDEX IF NOT EXISTS idx_uh_model ON usageHistory(model)",
      "CREATE INDEX IF NOT EXISTS idx_uh_conn ON usageHistory(connectionId)",
    ],
  },
  usageDaily: {
    columns: {
      dateKey: "TEXT PRIMARY KEY",
      data: "TEXT NOT NULL",
    },
  },
  requestDetails: {
    columns: {
      id: "TEXT PRIMARY KEY",
      timestamp: "TEXT NOT NULL",
      provider: "TEXT",
      model: "TEXT",
      connectionId: "TEXT",
      status: "TEXT",
      data: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_rd_ts ON requestDetails(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_rd_provider ON requestDetails(provider)",
      "CREATE INDEX IF NOT EXISTS idx_rd_model ON requestDetails(model)",
      "CREATE INDEX IF NOT EXISTS idx_rd_conn ON requestDetails(connectionId)",
    ],
  },
  requestLogs: {
    columns: {
      id: "INTEGER PRIMARY KEY AUTOINCREMENT",
      timestamp: "TEXT NOT NULL",
      apiKeyId: "TEXT",
      apiKeyName: "TEXT",
      apiKeyMasked: "TEXT",
      ip: "TEXT",
      method: "TEXT NOT NULL",
      path: "TEXT NOT NULL",
      endpointKind: "TEXT",
      model: "TEXT",
      provider: "TEXT",
      resolvedModel: "TEXT",
      status: "INTEGER",
      stream: "INTEGER DEFAULT 0",
      promptTokens: "INTEGER DEFAULT 0",
      completionTokens: "INTEGER DEFAULT 0",
      durationMs: "INTEGER DEFAULT 0",
      ttftMs: "INTEGER DEFAULT 0",
      tps: "REAL DEFAULT 0",
      userAgent: "TEXT",
      error: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_rl_ts ON requestLogs(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_rl_key ON requestLogs(apiKeyId)",
      "CREATE INDEX IF NOT EXISTS idx_rl_status ON requestLogs(status)",
    ],
  },
  // Single-writer bridge (docs/superpowers/plans/2026-09-24-sqlite-redis-multicore.md,
  // Task 2). Idempotency ledger for commands replayed from the Redis Stream: the
  // control writer inserts the receipt, applies the mutation and bumps
  // dbVersion in ONE transaction, so a duplicate delivery is a no-op.
  sqliteMutationReceipts: {
    columns: {
      receiptId: "TEXT PRIMARY KEY",
      type: "TEXT NOT NULL",
      workerId: "TEXT",
      appliedAt: "TEXT NOT NULL",
      result: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_smr_applied ON sqliteMutationReceipts(appliedAt DESC)",
    ],
  },
  // Monotonic database version. Workers compare cached values against this row
  // instead of trusting a Pub/Sub wake-up, which can be lost on reconnect.
  dbVersion: {
    columns: {
      id: "INTEGER PRIMARY KEY CHECK (id = 1)",
      version: "INTEGER NOT NULL DEFAULT 0",
      updatedAt: "TEXT",
    },
  },
  provider_footer_logs: {
    columns: {
      id: "INTEGER PRIMARY KEY AUTOINCREMENT",
      timestamp: "TEXT NOT NULL",
      provider: "TEXT NOT NULL",
      model: "TEXT NOT NULL",
      referral_text: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pfl_ts ON provider_footer_logs(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_pfl_provider ON provider_footer_logs(provider)",
    ],
  },
};

export function buildCreateTableSql(name, def, driver = "sqlite") {
  const isPostgres = driver === "postgres";
  const cols = Object.entries(def.columns).map(([k, v]) => {
    let colType = v;
    if (isPostgres) {
      colType = colType.replace(/INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/gi, "SERIAL PRIMARY KEY");
    }
    return `${k} ${colType}`;
  });
  if (def.primaryKey) cols.push(def.primaryKey);
  return `CREATE TABLE IF NOT EXISTS ${name} (${cols.join(", ")})`;
}
