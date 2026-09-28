// Task 7 of docs/superpowers/plans/2026-09-24-sqlite-redis-multicore.md
//
//   * Non-multicore roles (control, postgres, plain sqlite) delegate straight
//     to checkDatabaseReady().
//   * A SQLite Redis API worker is ready only when every dependency holds:
//     database ready and opened read-only, Redis ping, live writer heartbeat TTL,
//     Go limiter healthy, stream backlog within limit, and oldest pending entry
//     within its age limit.
//   * The payload is sanitized: ready/database/reason plus bounded counters.
//     No URL, secret, raw error text, schemaVersion or latency ever leaves here.
//
// Everything is dependency-injected so the gate is testable without Redis,
// SQLite or the Go engine.

import { redisNamespace } from "../redis/client.js";
import { checkRoutingState } from "../redis/routingState.js";
import { getAdapter, isSqliteMulticoreWorker } from "./driver.js";
import { checkDatabaseReady } from "./readiness.js";

const DEFAULT_GROUP = "sqlite-writer";
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
  const namespace = deps.namespace ?? redisNamespace(env);
  const heartbeatKey = deps.heartbeatKey ?? `${namespace}:writer:heartbeat`;
  const streamKey = deps.streamKey ?? `${namespace}:mutations`;
  const group = deps.group ?? DEFAULT_GROUP;
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

  const routingProbe = deps.checkRoutingState ?? checkRoutingState;
  if (!(await routingProbe(redis, namespace))) {
    return fail(db.database ?? database, WORKER_READY_REASONS.redisUnhealthy);
  }

  // 3. Writer heartbeat live. The writer sets the key with PX, so Redis owns
  //    the deadline: a skewed worker clock cannot invalidate a beating writer,
  //    and an expired/missing key (or one with no TTL) fails closed.
  let heartbeatLive = false;
  try {
    const pttl = await (redis.pTTL ?? redis.pttl)?.(heartbeatKey);
    heartbeatLive = Number.isFinite(Number(pttl)) && Number(pttl) > 0;
  } catch {}
  if (!heartbeatLive) return fail(db.database ?? database, WORKER_READY_REASONS.heartbeatStale);

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

  // 5b. Worker telemetry health. Loss/backpressure are reported, never a gate:
  // telemetry is best-effort by design, so a degraded producer stays ready while
  // operators can still see the loss.
  const telemetryProbe = deps.telemetryStatus;
  if (typeof telemetryProbe === "function") {
    try {
      const status = await telemetryProbe();
      if (status && typeof status === "object") {
        counters.telemetryDropped = clamp(status.telemetryDropped);
        counters.backpressure = clamp(status.backpressure);
        counters.telemetryLost = clamp(status.telemetryLost);
      }
    } catch {}
  }

  if (streamLength > maxBacklog) {
    return fail(db.database ?? database, WORKER_READY_REASONS.backlogExceeded, counters);
  }
  if (oldestMs !== null && oldestPendingAgeMs > maxPendingAgeMs) {
    return fail(db.database ?? database, WORKER_READY_REASONS.pendingAgeExceeded, counters);
  }

  return ready(db.database ?? database, counters);
}
