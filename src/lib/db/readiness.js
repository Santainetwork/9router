import { getAdapter, getDatabaseType } from "./driver.js";
import { SCHEMA_VERSION } from "./schema.js";

// Bounds adapter *initialization* only: adapter.get dispatches synchronously,
// so a query that hangs after the adapter exists blocks the event loop anyway.
const DEFAULT_TIMEOUT_MS = 5000;

// Stable machine-readable reasons. The payload never carries raw driver error
// text or the connection string.
export const READY_REASONS = {
  adapterError: "adapter_error",
  schemaReadFailed: "schema_read_failed",
  timeout: "timeout",
  schemaMissing: "schema_missing",
  schemaInvalid: "schema_invalid",
  schemaMismatch: "schema_mismatch",
};

const TIMEOUT_CODE = "DB_READY_TIMEOUT";

function withTimeout(promise, ms) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error("database adapter initialization timed out");
      err.code = TIMEOUT_CODE;
      reject(err);
    }, ms);
  });
  // race() attaches handlers to both sides, so a late rejection is still handled.
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

function driverType(adapter) {
  const driver = adapter?.driver;
  return typeof driver === "string" && driver ? driver : getDatabaseType();
}

// Minimal dependency injection: { getAdapter, schemaVersion, timeoutMs }.
export async function checkDatabaseReady(deps = {}) {
  const loadAdapter = deps.getAdapter || getAdapter;
  const expected = deps.schemaVersion ?? SCHEMA_VERSION;
  const started = Date.now();
  const elapsed = () => Date.now() - started;

  let adapter;
  try {
    adapter = await withTimeout(loadAdapter(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  } catch (e) {
    return {
      ready: false,
      database: getDatabaseType(),
      reason: e?.code === TIMEOUT_CODE ? READY_REASONS.timeout : READY_REASONS.adapterError,
      latencyMs: elapsed(),
    };
  }

  const database = driverType(adapter);

  let row;
  try {
    row = adapter.get("SELECT value FROM _meta WHERE key = ?", ["schemaVersion"]);
  } catch {
    return { ready: false, database, reason: READY_REASONS.schemaReadFailed, latencyMs: elapsed() };
  }

  const raw = row?.value;
  if (raw === null || raw === undefined || String(raw).trim() === "") {
    return { ready: false, database, reason: READY_REASONS.schemaMissing, latencyMs: elapsed() };
  }

  const version = Number(raw);
  if (!Number.isInteger(version)) {
    return { ready: false, database, reason: READY_REASONS.schemaInvalid, latencyMs: elapsed() };
  }
  if (version !== expected) {
    return { ready: false, database, reason: READY_REASONS.schemaMismatch, latencyMs: elapsed() };
  }

  return { ready: true, database, schemaVersion: version, latencyMs: elapsed() };
}
