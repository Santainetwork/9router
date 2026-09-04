import test from "node:test";
import assert from "node:assert/strict";
import { acquire, release, _stats, _reset, RateLimitTimeoutError } from "../../open-sse/services/rateLimiter.js";

test("concurrency leak protection - request aborted while in queue does not consume slot upon release", async () => {
  _reset();
  const scope = "apikey";
  const key = "test-leak-abort-" + Date.now();

  // 1. Acquire slot 1 (concurrency limit = 1)
  const rel1 = await acquire(scope, key, { rpm: 0, concurrency: 1, timeoutMs: 0 });
  assert.equal(typeof rel1, "function");
  assert.equal(_stats(scope, key).activeConcurrency, 1);

  // 2. Request 2 queues with an AbortController
  const ac = new AbortController();
  const p2 = acquire(scope, key, { rpm: 0, concurrency: 1, timeoutMs: 5000, signal: ac.signal });

  // 3. Client aborts request 2 while waiting
  ac.abort();

  // Request 2 promise must reject with abort error
  await assert.rejects(p2, /aborted/i);

  // 4. Request 1 finishes and calls release()
  rel1();

  // 5. Active concurrency MUST be 0, NOT 1! (Waiters should have been cleaned up)
  const statsAfter = _stats(scope, key);
  assert.equal(statsAfter.activeConcurrency, 0);
  assert.equal(statsAfter.queued, 0);
});

test("concurrency limit strictly prevents adding new requests while full", async () => {
  _reset();
  const scope = "apikey";
  const key = "test-strict-cap-" + Date.now();

  // Acquire 2 slots (limit = 2)
  const rel1 = await acquire(scope, key, { rpm: 0, concurrency: 2, timeoutMs: 0 });
  const rel2 = await acquire(scope, key, { rpm: 0, concurrency: 2, timeoutMs: 0 });
  assert.equal(_stats(scope, key).activeConcurrency, 2);

  // 3rd request MUST be rejected while first 2 are not finished
  await assert.rejects(
    acquire(scope, key, { rpm: 0, concurrency: 2, timeoutMs: 0 }),
    RateLimitTimeoutError
  );

  // Active concurrency remains exactly 2
  assert.equal(_stats(scope, key).activeConcurrency, 2);

  // Clean up
  rel1();
  rel2();
  assert.equal(_stats(scope, key).activeConcurrency, 0);
});
