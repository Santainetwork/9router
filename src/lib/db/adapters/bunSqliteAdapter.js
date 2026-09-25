// Bun runtime adapter — uses built-in bun:sqlite (native, fastest under Bun).
// Loaded only when process.versions.bun is present.
import { PRAGMA_SQL, READONLY_PRAGMA_SQL, denyWrite } from "../schema.js";

const CHECKPOINT_INTERVAL_MS = 60 * 1000;

export async function createBunSqliteAdapter(filePath, { readOnly = false } = {}) {
  // Dynamic import — only resolves under Bun runtime
  const { Database } = await import("bun:sqlite");
  // readOnly: API worker of a SQLITE_MULTICORE=redis deployment. create:false so
  // a missing file is an error rather than a new empty database.
  const db = new Database(filePath, readOnly ? { readonly: true, create: false } : { create: true });
  db.exec(readOnly ? READONLY_PRAGMA_SQL : PRAGMA_SQL);

  const stmtCache = new Map();
  function prepare(sql) {
    let stmt = stmtCache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  function checkpoint() {
    try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
  }

  const checkpointTimer = readOnly ? null : setInterval(checkpoint, CHECKPOINT_INTERVAL_MS);
  if (typeof checkpointTimer?.unref === "function") checkpointTimer.unref();

  function gracefulClose() {
    if (!readOnly) checkpoint();
    try { stmtCache.clear(); } catch {}
    try { db.close(); } catch {}
  }
  const onShutdown = () => gracefulClose();
  process.once("beforeExit", onShutdown);

  function writeTransaction(fn) {
    // bun:sqlite has db.transaction() API (similar to better-sqlite3)
    const tx = db.transaction(fn);
    return tx();
  }

  return {
    driver: "bun:sqlite",
    readOnly,
    run: readOnly ? denyWrite("run") : (sql, params = []) => {
      const r = prepare(sql).run(...params);
      return { changes: Number(r.changes ?? 0), lastInsertRowid: Number(r.lastInsertRowid ?? 0) };
    },
    get(sql, params = []) {
      return prepare(sql).get(...params);
    },
    all(sql, params = []) {
      return prepare(sql).all(...params);
    },
    exec: readOnly ? denyWrite("exec") : (sql) => db.exec(sql),
    transaction: readOnly ? denyWrite("transaction") : writeTransaction,
    checkpoint: readOnly ? denyWrite("checkpoint") : checkpoint,
    close() {
      if (checkpointTimer) clearInterval(checkpointTimer);
      gracefulClose();
    },
    raw: db,
  };
}
