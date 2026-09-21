// Hybrid Go Engine Limiter Client
// Offloads in-flight concurrency tracking and queue management to high-speed compiled Go daemon.
// Fails over automatically to in-memory JS limiter if daemon is unreachable.

import { getEngineConfig } from "../../../src/shared/utils/engineConfig.js";

const { limiterUrl: GO_ENGINE_URL, enabled: HYBRID_ENABLED } = getEngineConfig();

let isEngineAvailable = null;
let lastCheckTime = 0;

async function checkEngineHealth({ force = false } = {}) {
  if (!force && Date.now() - lastCheckTime < 5000 && isEngineAvailable !== null) {
    return isEngineAvailable;
  }
  lastCheckTime = Date.now();
  try {
    const res = await fetch(`${GO_ENGINE_URL}/health`, {
      signal: AbortSignal.timeout(800),
    });
    isEngineAvailable = res.ok;
  } catch {
    isEngineAvailable = false;
  }
  return isEngineAvailable;
}

export async function isGoLimiterActive({ force = false } = {}) {
  if (!HYBRID_ENABLED) return false;
  return await checkEngineHealth({ force });
}

export async function goAcquire(scope, key, { rpm = 0, concurrency = 0, timeoutMs = 0, onQueued, signal } = {}) {
  const active = await isGoLimiterActive();
  if (!active) return null; // Fallback to JS limiter

  if (timeoutMs > 0 && typeof onQueued === "function") {
    // Notify queue listener if timeout allowed
    onQueued();
  }

  // Preserve client abort semantics: cancel the Go-side waiter when the caller
  // aborts, while still enforcing the queue timeout with a hard ceiling.
  const timeoutSignal = AbortSignal.timeout(timeoutMs > 0 ? timeoutMs + 2000 : 3000);
  const fetchSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  const res = await fetch(`${GO_ENGINE_URL}/v1/limiter/acquire`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope, key, rpm, concurrency, timeoutMs }),
    signal: fetchSignal,
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error || "Rate limit / Concurrency queue timeout");
    err.status = res.status;
    err.retryAfter = 1;
    throw err;
  }

  const data = await res.json().catch(() => ({}));
  const leaseId = data.leaseId || null;

  // Concurrency slots are lease-owned by the Go daemon. A concurrency grant
  // without a leaseId means the daemon speaks an older protocol; surface a
  // non-429, no-fallback error so the caller does not leak an unowned Go slot
  // by silently enqueuing anew in the JS limiter.
  if (concurrency > 0 && !leaseId) {
    const err = new Error("Go limiter protocol error: concurrency acquire returned empty leaseId");
    err.name = "GoLimiterProtocolError";
    err.status = 502;
    err.noFallback = true;
    throw err;
  }

  let released = false;
  return function releaseFn() {
    if (released) return;
    released = true;
    if (leaseId) {
      goRelease(scope, key, leaseId).catch(() => {});
    }
  };
}

export async function goRelease(scope, key, leaseId) {
  if (!leaseId) return; // No-op: never send an invalid release without a lease

  const body = { scope, key, leaseId };
  // Retry a release network failure once with a short timeout so a transient
  // drop does not permanently strand an owned concurrency slot.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fetch(`${GO_ENGINE_URL}/v1/limiter/release`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(1000),
      });
      return;
    } catch {
      // Ignore network error on release; retry once below.
    }
  }
}

export async function goReset(scope, key) {
  try {
    const res = await fetch(`${GO_ENGINE_URL}/v1/limiter/reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope, key, all: !scope && !key }),
      signal: AbortSignal.timeout(1000),
    });
    const j = await res.json();
    return j.cleared || 0;
  } catch {
    return 0;
  }
}

export async function goSnapshot() {
  try {
    const res = await fetch(`${GO_ENGINE_URL}/v1/limiter/snapshot`, {
      cache: "no-store",
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function goBucketDetail(scope, key) {
  try {
    const url = `${GO_ENGINE_URL}/v1/limiter/bucket-detail?scope=${encodeURIComponent(scope)}&key=${encodeURIComponent(key)}`;
    const res = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
