// RPM & Concurrent rate limiter + request queue with timeout.
//
// Two independent scopes share this module: per-API-key and per-provider-connection.
// Each bucket tracks both:
//   1. RPM window (requests per 60s)
//   2. Concurrency semaphore (active concurrent in-flight requests)
//
// When either limit is reached, callers wait in a FIFO queue until a slot frees
// (window rolls over or active request releases) or per-caller timeout elapses.

const WINDOW_MS = 60_000;

export class RateLimitTimeoutError extends Error {
  constructor(retryAfterSec, reason = "Rate limit queue timeout") {
    super(reason);
    this.name = "RateLimitTimeoutError";
    this.retryAfter = retryAfterSec; // seconds
  }
}

// scope -> Map<key, bucket>
const scopes = new Map();

function bucketFor(scope, key) {
  let m = scopes.get(scope);
  if (!m) { m = new Map(); scopes.set(scope, m); }
  let b = m.get(key);
  if (!b) {
    b = { 
      windowStart: 0, 
      count: 0, 
      activeConcurrency: 0, 
      rpmLast: 0,
      concurrencyLast: 0,
      queue: [] 
    };
    m.set(key, b);
  }
  return b;
}

function now() { return Date.now(); }

// Roll the window forward if expired; returns true when a fresh window was opened.
function rollWindow(b, t) {
  if (t - b.windowStart >= WINDOW_MS) {
    b.windowStart = t;
    b.count = 0;
    return true;
  }
  return false;
}

// Try to consume one slot immediately honoring both RPM and Concurrency limits.
function tryConsume(b, rpm, concurrency, t) {
  rollWindow(b, t);
  const rpmOk = !rpm || rpm <= 0 || b.count < rpm;
  const concurrencyOk = !concurrency || concurrency <= 0 || b.activeConcurrency < concurrency;

  if (rpmOk && concurrencyOk) {
    if (rpm > 0) b.count += 1;
    if (concurrency > 0) b.activeConcurrency += 1;
    return true;
  }
  return false;
}

// Release one active concurrency slot and drain queued waiters.
export function release(scope, key) {
  const m = scopes.get(scope);
  if (!m) return;
  const b = m.get(key);
  if (!b) return;
  if (b.activeConcurrency > 0) {
    b.activeConcurrency -= 1;
  }
  pump(scope, key);
}

// Drain waiters when a slot or new window opens.
function pump(scope, key) {
  const b = bucketFor(scope, key);
  const t = now();
  rollWindow(b, t);

  while (b.queue.length > 0) {
    const head = b.queue[0];
    if (head.settled) {
      b.queue.shift();
      continue;
    }

    const rpmOk = !b.rpmLast || b.rpmLast <= 0 || b.count < b.rpmLast;
    const concurrencyOk = !b.concurrencyLast || b.concurrencyLast <= 0 || b.activeConcurrency < b.concurrencyLast;

    if (rpmOk && concurrencyOk) {
      const w = b.queue.shift();
      clearTimeout(w.timer);
      w.settled = true;
      if (b.rpmLast > 0) b.count += 1;
      if (b.concurrencyLast > 0) b.activeConcurrency += 1;
      w.resolve(createReleaseFn(scope, key, b.concurrencyLast > 0));
    } else {
      break;
    }
  }

  // Schedule next pump if waiters remain and waiting on RPM window.
  if (b.queue.length > 0) {
    const msLeft = Math.max(1, WINDOW_MS - (t - b.windowStart));
    if (!b.pumpTimer) {
      b.pumpTimer = setTimeout(() => { b.pumpTimer = null; pump(scope, key); }, msLeft);
      if (typeof b.pumpTimer.unref === "function") b.pumpTimer.unref();
    }
  }
}

function createReleaseFn(scope, key, hasConcurrency) {
  let released = false;
  return function releaseFn() {
    if (released) return;
    released = true;
    if (hasConcurrency) {
      release(scope, key);
    }
  };
}

/**
 * Acquire one slot in scope/key, honoring rpm and concurrency. Resolves with a release function.
 * @param {string} scope  "apikey" | "provider"
 * @param {string} key     bucket key (api key id / connection id)
 * @param {object} opts    { rpm, concurrency, timeoutMs, onQueued }
 * @returns {Promise<Function>} resolves on grant with release() callback, rejects RateLimitTimeoutError on timeout
 */
export function acquire(scope, key, { rpm = 0, concurrency = 0, timeoutMs = 0, onQueued } = {}) {
  const hasRpm = Number(rpm) > 0;
  const hasConcurrency = Number(concurrency) > 0;

  // No limits configured -> return immediate no-op release function.
  if (!hasRpm && !hasConcurrency) {
    return Promise.resolve(() => {});
  }

  const b = bucketFor(scope, key);
  b.rpmLast = rpm;
  b.concurrencyLast = concurrency;
  const t = now();

  if (b.queue.length === 0 && tryConsume(b, rpm, concurrency, t)) {
    return Promise.resolve(createReleaseFn(scope, key, hasConcurrency));
  }

  // Must queue. If no timeout budget, reject immediately with time until window rolls or retry estimate.
  const retryAfterSec = Math.max(1, Math.ceil((WINDOW_MS - (t - b.windowStart)) / 1000));
  if (!timeoutMs || timeoutMs <= 0) {
    const reason = hasConcurrency && b.activeConcurrency >= concurrency
      ? "Concurrency limit reached (no queue timeout)"
      : "Rate limit reached (no queue timeout)";
    return Promise.reject(new RateLimitTimeoutError(retryAfterSec, reason));
  }

  if (typeof onQueued === "function") onQueued();
  return new Promise((resolve, reject) => {
    const w = { resolve, reject, settled: false, timer: null };
    w.timer = setTimeout(() => {
      if (w.settled) return;
      w.settled = true;
      const i = b.queue.indexOf(w);
      if (i >= 0) b.queue.splice(i, 1);
      reject(new RateLimitTimeoutError(retryAfterSec, "Rate limit / Concurrency queue timeout"));
    }, timeoutMs);
    b.queue.push(w);
    pump(scope, key);
  });
}

// Test/introspection helpers.
export function _reset() {
  for (const m of scopes.values()) {
    for (const b of m.values()) {
      if (b.pumpTimer) { clearTimeout(b.pumpTimer); b.pumpTimer = null; }
      for (const w of b.queue) { if (w.timer) clearTimeout(w.timer); }
    }
  }
  scopes.clear();
}

export function _stats(scope, key) {
  const b = scopes.get(scope)?.get(key);
  if (!b) return null;
  return { 
    count: b.count, 
    activeConcurrency: b.activeConcurrency,
    queued: b.queue.filter(w => !w.settled).length, 
    windowStart: b.windowStart 
  };
}

// Admin introspection: snapshot of every bucket that currently has waiters or in-flight requests.
export function queueSnapshot() {
  const t = now();
  const buckets = [];
  let totalQueued = 0;
  let totalActiveWindows = 0;
  let totalActiveConcurrent = 0;

  for (const [scope, m] of scopes.entries()) {
    for (const [key, b] of m.entries()) {
      const inWindow = t - b.windowStart < WINDOW_MS ? b.count : 0;
      const queued = b.queue.filter((w) => !w.settled).length;
      const active = b.activeConcurrency || 0;

      if (queued === 0 && inWindow === 0 && active === 0) continue; // idle bucket, skip
      totalQueued += queued;
      if (inWindow > 0) totalActiveWindows += 1;
      totalActiveConcurrent += active;

      buckets.push({
        scope,                        // "apikey" | "provider"
        key,                          // api key id / connection id
        rpm: b.rpmLast || 0,          // configured limit
        concurrency: b.concurrencyLast || 0, // configured concurrency limit
        activeConcurrency: active,    // currently in-flight
        inWindow,                     // requests used in the current 60s window
        queued,                       // requests waiting for a slot
        windowResetInMs: Math.max(0, WINDOW_MS - (t - b.windowStart)),
      });
    }
  }
  buckets.sort((a, b) => b.queued - a.queued || b.activeConcurrency - a.activeConcurrency || b.inWindow - a.inWindow);
  return { totalQueued, totalActiveWindows, totalActiveConcurrent, buckets };
}
