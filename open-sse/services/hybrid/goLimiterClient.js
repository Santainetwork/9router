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

export async function goAcquire(scope, key, { rpm = 0, concurrency = 0, timeoutMs = 0, onQueued } = {}) {
  const active = await isGoLimiterActive();
  if (!active) return null; // Fallback to JS limiter

  if (timeoutMs > 0 && typeof onQueued === "function") {
    // Notify queue listener if timeout allowed
    onQueued();
  }

  const res = await fetch(`${GO_ENGINE_URL}/v1/limiter/acquire`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope, key, rpm, concurrency, timeoutMs }),
    signal: AbortSignal.timeout(timeoutMs > 0 ? timeoutMs + 2000 : 3000),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error || "Rate limit / Concurrency queue timeout");
    err.status = res.status;
    err.retryAfter = 1;
    throw err;
  }

  let released = false;
  return function releaseFn() {
    if (released) return;
    released = true;
    goRelease(scope, key).catch(() => {});
  };
}

export async function goRelease(scope, key) {
  try {
    await fetch(`${GO_ENGINE_URL}/v1/limiter/release`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope, key }),
      signal: AbortSignal.timeout(1000),
    });
  } catch {
    // Ignore network error on release
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
