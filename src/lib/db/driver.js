import { ensureDirs, DATA_FILE } from "./paths.js";

// Use global to survive Next.js dev hot-reload (module state resets on reload)
if (!global._dbAdapter) global._dbAdapter = { instance: null, initPromise: null, logged: false };
const state = global._dbAdapter;

export function getDatabaseType(env = process.env) {
  // DB_TYPE is case-insensitive (custom-server validates it lowercased). Any
  // non-empty DATABASE_URL stays postgres for backward compatibility.
  if (env.DATABASE_URL || String(env.DB_TYPE || "").toLowerCase() === "postgres") {
    return "postgres";
  }
  return "sqlite";
}

// API workers must never own schema: migrations run only on the control process.
// WORKER_ROLE is set by the entrypoint; custom-server mirrors the api role into
// NINEROUTER_WORKER_ROLE. Assumes control starts first (entrypoint order) so
// tables already exist by the time an API worker serves traffic.
export function isApiWorker(env = process.env) {
  const role = env.WORKER_ROLE || env.NINEROUTER_WORKER_ROLE || "control";
  return String(role).toLowerCase() === "api";
}

// Opt-in SQLite multicore (docs/superpowers/plans/2026-09-24-sqlite-redis-multicore.md):
// an API worker of a Redis-bridged deployment opens SQLite READ-ONLY and sends
// mutations to the single control writer. Anything else (including plain
// API_WORKERS=1 with an api role) keeps the pre-existing read-write open, so
// default behavior is unchanged.
export function isSqliteMulticoreWorker(env = process.env) {
  if (!isApiWorker(env)) return false;
  return String(env.SQLITE_MULTICORE || "").toLowerCase() === "redis";
}

async function tryBunSqlite(opts) {
  // Bun runtime only — built-in, no install needed
  if (!process.versions.bun) return null;
  try {
    const { createBunSqliteAdapter } = await import("./adapters/bunSqliteAdapter.js");
    return await createBunSqliteAdapter(DATA_FILE, opts);
  } catch (e) {
    console.warn(`[DB] bun:sqlite unavailable: ${e.message}`);
    return null;
  }
}

async function tryBetterSqlite(opts) {
  // Skip on Bun — better-sqlite3 native bindings unsupported
  if (process.versions.bun) return null;
  // Skip on Node >= 24: the native addon SIGSEGVs on load there, which is a
  // process-level crash the try/catch below cannot recover from. node:sqlite covers it.
  const [nodeMajor] = process.versions.node.split(".").map(Number);
  if (nodeMajor >= 24) return null;
  try {
    const { createBetterSqliteAdapter } = await import("./adapters/betterSqliteAdapter.js");
    return createBetterSqliteAdapter(DATA_FILE, opts);
  } catch (e) {
    console.warn(`[DB] better-sqlite3 unavailable: ${e.message}`);
    return null;
  }
}

async function tryNodeSqlite(opts) {
  // Built-in since Node 22.5.0 — no install needed. Skip under Bun (no node:sqlite).
  if (process.versions.bun) return null;
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 22 || (maj === 22 && min < 5)) return null;
  try {
    const { createNodeSqliteAdapter } = await import("./adapters/nodeSqliteAdapter.js");
    return await createNodeSqliteAdapter(DATA_FILE, opts);
  } catch (e) {
    console.warn(`[DB] node:sqlite unavailable: ${e.message}`);
    return null;
  }
}

async function trySqlJs() {
  try {
    const { createSqlJsAdapter } = await import("./adapters/sqljsAdapter.js");
    return await createSqlJsAdapter(DATA_FILE);
  } catch (e) {
    console.warn(`[DB] sql.js unavailable: ${e.message}`);
    return null;
  }
}

// Ordered fallback chain per runtime (see initAdapter). `workerSafe: false` marks
// an adapter that must never back an API worker in multicore mode: sql.js loads
// the whole database into process memory and rewrites the file after mutations,
// so a worker would serve a stale private image and race the control writer.
export const SQLITE_OPENERS = [
  { name: "bun:sqlite", open: tryBunSqlite, workerSafe: true },
  { name: "better-sqlite3", open: tryBetterSqlite, workerSafe: true },
  { name: "node:sqlite", open: tryNodeSqlite, workerSafe: true },
  { name: "sql.js", open: trySqlJs, workerSafe: false },
];

// Migrations run only on the control process (see isApiWorker). getAdapter()
// clears a rejected initPromise so a readiness probe can retry, which means a
// failed migration is retried too: close the adapter first or every retry leaks
// the sqlite handle plus its -wal/-shm sidecars.
async function migrateUnlessWorker(adapter, loadMigration) {
  if (isApiWorker()) return;
  try {
    // loadMigration() is inside the try too: a failed dynamic import (broken
    // build, missing module) throws before migration even starts and would
    // otherwise leak the already-open sqlite handle on every retry.
    const { runMigrationOnce } = await loadMigration();
    await runMigrationOnce(adapter);
  } catch (e) {
    try { adapter.close?.(); } catch {}
    throw e;
  }
}

export async function initAdapter(deps = {}) {
  const dbType = getDatabaseType();
  const loadMigration = deps.loadMigration || (() => import("./migrate.js"));
  if (dbType === "postgres") {
    const createPostgresAdapter = deps.createPostgresAdapter
      || (await import("./adapters/postgresAdapter.js")).createPostgresAdapter;
    const adapter = await createPostgresAdapter(process.env.DATABASE_URL);
    if (!state.logged) {
      const target = process.env.DATABASE_URL
        ? process.env.DATABASE_URL.replace(/:[^:@]+@/, ":***@")
        : "default";
      console.log(`[DB] Driver: ${adapter.driver} | target: ${target}`);
      state.logged = true;
    }
    await migrateUnlessWorker(adapter, loadMigration);
    return adapter;
  }

  ensureDirs();
  // Multicore API worker: native read-only only — sql.js is rejected outright
  // because each process would hold a stale private image of the database.
  const readOnly = isSqliteMulticoreWorker();
  const opts = readOnly ? { readOnly: true } : undefined;
  const openers = deps.sqliteOpeners || SQLITE_OPENERS;
  let adapter = null;
  for (const { open, workerSafe } of openers) {
    if (readOnly && workerSafe === false) continue;
    adapter = await open(opts);
    if (adapter) break;
  }
  if (!adapter) {
    throw new Error(readOnly
      ? "[DB] SQLITE_MULTICORE=redis API worker requires a native SQLite adapter with read-only support (better-sqlite3, node:sqlite or bun:sqlite); sql.js is not supported in multicore mode"
      : "[DB] No SQLite driver available (bun/better/node/sql.js all failed)");
  }

  if (!state.logged) {
    console.log(`[DB] Driver: ${adapter.driver}${readOnly ? " (read-only worker)" : ""} | file: ${DATA_FILE}`);
    state.logged = true;
  }

  await migrateUnlessWorker(adapter, loadMigration);
  return adapter;
}

// deps is forwarded to initAdapter() for tests and readiness probes.
export async function getAdapter(deps) {
  if (state.instance) return state.instance;
  if (!state.initPromise) {
    // Clear a rejected initPromise: a transient init failure (DB still starting,
    // worker racing the control process) must not poison the process forever.
    state.initPromise = initAdapter(deps).then(
      (a) => { state.instance = a; return a; },
      (e) => { state.initPromise = null; throw e; },
    );
  }
  return state.initPromise;
}

export function getAdapterSync() {
  if (!state.instance) throw new Error("[DB] adapter not initialized — await getAdapter() first");
  return state.instance;
}
