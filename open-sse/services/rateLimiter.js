// RPM rate limiter + request queue with timeout.
//
// Two independent scopes share this module: per-API-key and per-provider-connection.
// Each bucket is a fixed 60s window counting requests. When the window is full,
// callers wait in a FIFO queue until a slot frees (window rolls over) or the
// per-caller timeout elapses (→ throws RateLimitTimeoutError, surfaced as 429).
//
// In-memory only (single-process router). ponytail: no persistence/cluster — add a
// shared store (redis) when 9router runs multi-instance.

const WINDOW_MS = 60_000;

export class RateLimitTimeoutError extends Error {
  constructor(retryAfterSec) {
    super("Rate limit queue timeout");
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
    b = { windowStart: 0, count: 0, queue: [] };
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

// Try to consume one slot immediately. Returns true on success.
function tryConsume(b, rpm, t) {
  rollWindow(b, t);
  if (b.count < rpm) {
    b.count += 1;
    return true;
  }
  return false;
}

// Drain waiters when a new window opens.
function pump(scope, key) {
  const b = bucketFor(scope, key);
  const t = now();
  rollWindow(b, t);
  while (b.queue.length > 0 && b.count < b.rpmLast) {
    const w = b.queue.shift();
    if (w.settled) continue;
    clearTimeout(w.timer);
    w.settled = true;
    b.count += 1;
    w.resolve();
  }
  // Schedule next pump if waiters remain (at window end).
  if (b.queue.length > 0) {
    const msLeft = Math.max(1, WINDOW_MS - (t - b.windowStart));
    if (!b.pumpTimer) {
      b.pumpTimer = setTimeout(() => { b.pumpTimer = null; pump(scope, key); }, msLeft);
      // Don't keep the process alive solely to drain an empty-ish queue.
      if (typeof b.pumpTimer.unref === "function") b.pumpTimer.unref();
    }
  }
}

/**
 * Acquire one slot in scope/key, honoring rpm. Resolves when a slot is granted.
 * @param {string} scope  "apikey" | "provider"
 * @param {string} key     bucket key (api key id / connection id)
 * @param {object} opts    { rpm, timeoutMs }
 * @returns {Promise<void>} resolves on grant, rejects RateLimitTimeoutError on timeout
 */
export function acquire(scope, key, { rpm, timeoutMs = 0 } = {}) {
  // No limit configured → pass through.
  if (!rpm || rpm <= 0) return Promise.resolve();

  const b = bucketFor(scope, key);
  b.rpmLast = rpm; // remember for pump()
  const t = now();

  if (b.queue.length === 0 && tryConsume(b, rpm, t)) {
    return Promise.resolve();
  }

  // Must queue. If no timeout budget, reject immediately with time until window rolls.
  const retryAfterSec = Math.max(1, Math.ceil((WINDOW_MS - (t - b.windowStart)) / 1000));
  if (!timeoutMs || timeoutMs <= 0) {
    return Promise.reject(new RateLimitTimeoutError(retryAfterSec));
  }

  return new Promise((resolve, reject) => {
    const w = { resolve, reject, settled: false, timer: null };
    w.timer = setTimeout(() => {
      if (w.settled) return;
      w.settled = true;
      const i = b.queue.indexOf(w);
      if (i >= 0) b.queue.splice(i, 1);
      reject(new RateLimitTimeoutError(retryAfterSec));
    }, timeoutMs);
    b.queue.push(w);
    pump(scope, key);
  });
}

// Test/introspection helpers.
export function _reset() {
  // Clear any pending pump/queue timers before dropping buckets so tests and
  // hot-reloads don't leak timers that keep the event loop alive.
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
  return { count: b.count, queued: b.queue.length, windowStart: b.windowStart };
}

// Admin introspection: snapshot of every bucket that currently has waiters or
// in-window usage, across all scopes. Used by the admin queue view so ops can
// see how many requests are queued (waiting for an RPM slot) right now.
export function queueSnapshot() {
  const t = now();
  const buckets = [];
  let totalQueued = 0;
  let totalActiveWindows = 0;
  for (const [scope, m] of scopes.entries()) {
    for (const [key, b] of m.entries()) {
      // Live count for the current window (0 if the window has rolled over).
      const inWindow = t - b.windowStart < WINDOW_MS ? b.count : 0;
      const queued = b.queue.filter((w) => !w.settled).length;
      if (queued === 0 && inWindow === 0) continue; // idle bucket, skip
      totalQueued += queued;
      if (inWindow > 0) totalActiveWindows += 1;
      buckets.push({
        scope,               // "apikey" | "provider"
        key,                 // api key id / connection id
        rpm: b.rpmLast || 0, // configured limit
        inWindow,            // requests used in the current 60s window
        queued,              // requests waiting for a slot
        windowResetInMs: Math.max(0, WINDOW_MS - (t - b.windowStart)),
      });
    }
  }
  buckets.sort((a, b) => b.queued - a.queued || b.inWindow - a.inWindow);
  return { totalQueued, totalActiveWindows, buckets };
}
