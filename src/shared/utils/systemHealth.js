// Shared system health collector.
// Used by the admin panel with detail=1 (full diagnostics) and the public
// /api/health probe with no query (fast liveness + component summary).

import { getAdapterSync, getDatabaseType } from "../../lib/db/driver.js";
import { getEngineConfig } from "./engineConfig.js";
import { goSnapshot, isGoLimiterActive } from "open-sse/services/hybrid/goLimiterClient.js";
import { queueSnapshot } from "open-sse/services/rateLimiter.js";

const UPSTREAM_URL =
  process.env.INTERNAL_UPSTREAM_URL || process.env.UPSTREAM_URL || "http://127.0.0.1:20127";

const LIMITER_SCOPE = "apikey";

export function getWorkerTopology(env = process.env) {
  const requested = env.API_WORKERS || "1";
  const parsed = Number(requested);
  const postgres =
    String(env.DB_TYPE || "").toLowerCase() === "postgres" ||
    /^(postgres|postgresql):\/\//i.test(env.DATABASE_URL || "");
  const validTotal = /^[1-8]$/.test(requested) && Number.isSafeInteger(parsed);
  const totalProcesses = validTotal && (parsed === 1 || postgres) ? parsed : 1;
  const requestedRole = String(env.WORKER_ROLE || env.NINEROUTER_WORKER_ROLE || "control").toLowerCase();
  const role = totalProcesses > 1 && requestedRole === "api" ? "api" : "control";

  return {
    role,
    totalProcesses,
    apiWorkers: totalProcesses - 1,
    mode: totalProcesses > 1 ? "postgres-multicore" : "single-process",
  };
}

export function getDatabaseInfo() {
  const type = getDatabaseType();
  let target = "";
  let driver = "";
  if (type === "postgres") {
    target = (process.env.DATABASE_URL || "").replace(/:[^:@/]+@/, ":***@");
  } else {
    try {
      driver = getAdapterSync().driver || "";
    } catch {
      driver = "";
    }
    target = "~/.9router/db/data.sqlite";
  }
  return { type, driver, target };
}

export function getProcessInfo() {
  const m = process.memoryUsage();
  const mb = (n) => Math.round(n / 1048576);
  return {
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    rssMb: mb(m.rss),
    heapUsedMb: mb(m.heapUsed),
    heapTotalMb: mb(m.heapTotal),
    node: process.version,
  };
}

export async function getEngineHealth() {
  const cfg = getEngineConfig();
  // Force a fresh probe when requested so the panel never shows a stale cache.
  const active = await isGoLimiterActive({ force: true }).catch(() => false);
  const probed = active ? await probeEngine(cfg.limiterUrl) : { reachable: false };

  let limiter = { totalBuckets: 0, totalQueued: 0, totalActiveConcurrent: 0 };
  if (active) {
    const [jsSnap, goSnap] = await Promise.all([
      Promise.resolve(queueSnapshot()),
      goSnapshot(),
    ]);
    const snap = goSnap || jsSnap;
    limiter = {
      totalBuckets: snap?.totalBuckets ?? 0,
      totalQueued: snap?.totalQueued ?? 0,
      totalActiveConcurrent: snap?.totalActiveConcurrent ?? 0,
    };
  } else {
    const snap = queueSnapshot();
    limiter = {
      totalBuckets: snap?.totalBuckets ?? 0,
      totalQueued: snap?.totalQueued ?? 0,
      totalActiveConcurrent: snap?.totalActiveConcurrent ?? 0,
    };
  }

  return {
    type: active ? "golang" : "javascript",
    active,
    status: active ? "healthy" : "fallback",
    version: probed.version || null,
    limiter: {
      url: cfg.limiterUrl,
      port: cfg.limiterPort,
      reachable: probed.reachable,
      probeLatencyMs: probed.latencyMs,
      ...limiter,
    },
    gateway: {
      port: cfg.gatewayPort,
      configured: cfg.masterGateway,
      urls: cfg.gatewayUrls,
    },
    publicProxy: {
      port: cfg.publicProxyPort,
      configured: cfg.publicProxyEnabled,
      enabled: cfg.publicProxyEnabled,
    },
    config: {
      enabled: cfg.enabled,
      scope: cfg.scope,
      proxyConcurrency: cfg.proxyConcurrency,
      proxyRpm: cfg.proxyRpm,
      queueTimeoutSec: cfg.queueTimeoutSec,
    },
  };
}

export async function getNextBackendHealth() {
  const started = Date.now();
  try {
    const res = await fetch(`${UPSTREAM_URL}/api/version`, {
      cache: "no-store",
      signal: AbortSignal.timeout(1500),
    });
    const body = await res.json().catch(() => ({}));
    return {
      ok: res.ok,
      url: UPSTREAM_URL,
      status: res.status,
      version: body?.version || null,
      latencyMs: Date.now() - started,
    };
  } catch (e) {
    return {
      ok: false,
      url: UPSTREAM_URL,
      status: null,
      version: null,
      latencyMs: Date.now() - started,
      error: e?.message || "unreachable",
    };
  }
}

async function probeJson(url) {
  try {
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(1200) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function probeEngine(baseUrl) {
  const started = Date.now();
  const body = await probeJson(`${baseUrl}/health`);
  return {
    reachable: Boolean(body),
    version: body?.engine || null,
    latencyMs: Date.now() - started,
  };
}

export async function collectSystemHealth({ detail = false } = {}) {
  const [engine, backend] = await Promise.all([getEngineHealth(), getNextBackendHealth()]);
  const out = {
    ok: true,
    at: new Date().toISOString(),
    engine,
    nextBackend: backend,
    database: getDatabaseInfo(),
    limiter: engine.limiter,
  };
  if (detail) out.process = getProcessInfo();
  return out;
}

// Export for tests / callers that need the limiter scope used by the gateway.
export { LIMITER_SCOPE };
