import Database from "better-sqlite3";
import { PRAGMA_SQL, READONLY_PRAGMA_SQL, denyWrite } from "../schema.js";

// Periodic checkpoint to keep WAL file small (avoid huge -wal/-shm growth)
const CHECKPOINT_INTERVAL_MS = 60 * 1000;

// readOnly: API worker of a SQLITE_MULTICORE=redis deployment. The connection
// must not checkpoint (needs write access to -wal), migrate, or run any
// write PRAGMA; only the control process owns the read-write handle.
export function createBetterSqliteAdapter(filePath, { readOnly = false } = {}) {
  const db = new Database(filePath, readOnly ? { readonly: true, fileMustExist: true } : {});
  db.exec(readOnly ? READONLY_PRAGMA_SQL : PRAGMA_SQL);
  // Schema is created/synced by migrate.js after adapter init

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
    try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch {}
  }

  // Truncate WAL periodically so file stays small for backup/copy
  const checkpointTimer = readOnly ? null : setInterval(checkpoint, CHECKPOINT_INTERVAL_MS);
  if (typeof checkpointTimer?.unref === "function") checkpointTimer.unref();

  function gracefulClose() {
    if (!readOnly) checkpoint();
    try { stmtCache.clear(); } catch {}
    try { db.close(); } catch {}
  }

  // Ensure WAL is flushed and -wal/-shm files removed on shutdown
  const onShutdown = () => gracefulClose();
  process.once("beforeExit", onShutdown);

  return {
    driver: "better-sqlite3",
    readOnly,
    run: readOnly ? denyWrite("run") : (sql, params = []) => prepare(sql).run(...params),
    get(sql, params = []) { return prepare(sql).get(...params); },
    all(sql, params = []) { return prepare(sql).all(...params); },
    exec: readOnly ? denyWrite("exec") : (sql) => db.exec(sql),
    transaction: readOnly ? denyWrite("transaction") : (fn) => db.transaction(fn)(),
    checkpoint: readOnly ? denyWrite("checkpoint") : checkpoint,
    close() {
      if (checkpointTimer) clearInterval(checkpointTimer);
      gracefulClose();
    },
    raw: db,
  };
}
