// Task 7 of docs/superpowers/plans/2026-09-24-sqlite-redis-multicore.md
//
//   * Non-multicore roles (control, postgres, plain sqlite) delegate straight
//     to checkDatabaseReady().
//   * A SQLite Redis API worker is ready only when every dependency holds:
//     database ready and opened read-only, Redis ping, writer heartbeat fresh,
//     Go limiter healthy, stream backlog within limit, and oldest pending entry
//     within its age limit.
//   * The payload is sanitized: ready/database/reason plus bounded counters.
//     No URL, secret, raw error text, schemaVersion or latency ever leaves here.
//
// Everything is dependency-injected so the gate is testable without Redis,
// SQLite or the Go engine.

import { getAdapter, isSqliteMulticoreWorker } from "./driver.js";
import { checkDatabaseReady } from "./readiness.js";

const DEFAULT_NAMESPACE = "9router:sqlite";
const DEFAULT_STREAM_KEY = "9router:sqlite:mutations";
const DEFAULT_GROUP = "sqlite-writer";
// Writer heartbeat TTL is 15s (sqliteMutationWriter.js); two TTLs of grace so a
// writer mid-commit is never falsely declared stale.
const DEFAULT_HEARTBEAT_FRESH_MS = 30_000;
const DEFAULT_MAX_BACKLOG = 10_000;
const DEFAULT_MAX_PENDING_AGE_MS = 120_000;
const MAX_COUNTER = 1_000_000_000;

export const WORKER_READY_REASONS = {
  dbNotReady: "db_not_ready",
  adapterError: "adapter_error",
  dbNotReadOnly: "db_not_readonly",
  redisUnhealthy: "redis_unhealthy",
  heartbeatStale: "writer_heartbeat_stale",
  goLimiterUnhealthy: "go_limiter_unhealthy",
  backlogExceeded: "backlog_exceeded",
  pendingAgeExceeded: "pending_age_exceeded",
};

function clamp(value, max = MAX_COUNTER) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(n, max));
}

function streamIdTimestampMs(id) {
  if (typeof id !== "string") return null;
  const ms = Number(id.split("-")[0]);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function fail(database, reason, counters = {}) {
  return { ready: false, database, reason, counters };
}

function ready(database, counters = {}) {
  return { ready: true, database, reason: undefined, counters };
}

export async function checkWorkerReady(deps = {}) {
  const env = deps.env ?? process.env;
  const detect = deps.isSqliteMulticoreWorker ?? isSqliteMulticoreWorker;

  if (!detect(env)) {
    const db = await (deps.checkDatabaseReady ?? checkDatabaseReady)(deps);
    return { ...db, counters: {} };
  }

  const database = deps.database ?? "sqlite";
  const dbProbe = deps.checkDatabaseReady ?? checkDatabaseReady;
  const loadAdapter = deps.getAdapter ?? getAdapter;
  const redis = deps.redis;
  const now = deps.now ?? (() => Date.now());
  const heartbeatKey = deps.heartbeatKey ?? `${deps.namespace ?? DEFAULT_NAMESPACE}:writer:heartbeat`;
  const streamKey = deps.streamKey ?? DEFAULT_STREAM_KEY;
  const group = deps.group ?? DEFAULT_GROUP;
  const heartbeatFreshMs = deps.heartbeatFreshMs ?? DEFAULT_HEARTBEAT_FRESH_MS;
  const maxBacklog = deps.maxBacklog ?? DEFAULT_MAX_BACKLOG;
  const maxPendingAgeMs = deps.maxPendingAgeMs ?? DEFAULT_MAX_PENDING_AGE_MS;

  // 1. Database ready and opened read-only.
  const db = await dbProbe(deps);
  if (!db.ready) return fail(db.database ?? database, db.reason ?? WORKER_READY_REASONS.dbNotReady);

  let adapter;
  try {
    adapter = await loadAdapter();
  } catch {
    return fail(db.database ?? database, WORKER_READY_REASONS.adapterError);
  }
  if (adapter?.readOnly !== true) {
    return fail(db.database ?? database, WORKER_READY_REASONS.dbNotReadOnly);
  }

  // 2. Redis health.
  if (!redis) return fail(db.database ?? database, WORKER_READY_REASONS.redisUnhealthy);
  let pingOk = false;
  try {
    pingOk = (await redis.ping?.()) === "PONG";
  } catch {}
  if (!pingOk) return fail(db.database ?? database, WORKER_READY_REASONS.redisUnhealthy);

  // 3. Writer heartbeat fresh.
  let heartbeatFresh = false;
  try {
    const value = await redis.get?.(heartbeatKey);
    const stampedAt = typeof value === "string" ? Date.parse(value) : NaN;
    heartbeatFresh = Number.isFinite(stampedAt) && now() - stampedAt <= heartbeatFreshMs;
  } catch {}
  if (!heartbeatFresh) return fail(db.database ?? database, WORKER_READY_REASONS.heartbeatStale);

  // 4. Go limiter health.
  const limiterProbe = deps.goLimiterHealth;
  let limiterOk = false;
  if (typeof limiterProbe === "function") {
    try { limiterOk = await limiterProbe(); } catch {}
  }
  if (!limiterOk) return fail(db.database ?? database, WORKER_READY_REASONS.goLimiterUnhealthy);

  // 5. Stream backlog and oldest pending age.
  let streamLength = 0;
  let pending = 0;
  let oldestPendingAgeMs = 0;
  let oldestMs = null;
  try {
    if (typeof redis.xLen === "function") streamLength = clamp(await redis.xLen(streamKey));
    const summary = typeof redis.xPending === "function"
      ? await redis.xPending(streamKey, group)
      : null;
    pending = clamp(summary?.pending ?? 0);
    oldestMs = streamIdTimestampMs(summary?.firstId);
    if (oldestMs !== null) oldestPendingAgeMs = clamp(now() - oldestMs);
  } catch {
    return fail(db.database ?? database, WORKER_READY_REASONS.redisUnhealthy);
  }

  const counters = { streamLength, pending, oldestPendingAgeMs };
  if (streamLength > maxBacklog) {
    return fail(db.database ?? database, WORKER_READY_REASONS.backlogExceeded, counters);
  }
  if (oldestMs !== null && oldestPendingAgeMs > maxPendingAgeMs) {
    return fail(db.database ?? database, WORKER_READY_REASONS.pendingAgeExceeded, counters);
  }

  return ready(db.database ?? database, counters);
}
