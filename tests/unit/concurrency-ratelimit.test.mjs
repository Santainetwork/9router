import test from "node:test";
import assert from "node:assert/strict";
import { acquire, release, _stats, _reset, RateLimitTimeoutError } from "../../open-sse/services/rateLimiter.js";

test("concurrency limiter blocks when limit reached and releases correctly", async () => {
  _reset();
  const scope = "apikey";
  const key = "test-concurrency-" + Date.now();

  // 1st request acquires slot (limit concurrency=2, timeoutMs=0 for immediate reject)
  const rel1 = await acquire(scope, key, { rpm: 0, concurrency: 2, timeoutMs: 0 });
  assert.equal(typeof rel1, "function");

  // 2nd request acquires slot
  const rel2 = await acquire(scope, key, { rpm: 0, concurrency: 2, timeoutMs: 0 });
  assert.equal(typeof rel2, "function");

  const stats = _stats(scope, key);
  assert.equal(stats.activeConcurrency, 2);

  // 3rd request rejected with RateLimitTimeoutError
  await assert.rejects(
    async () => {
      await acquire(scope, key, { rpm: 0, concurrency: 2, timeoutMs: 0 });
    },
    (err) => {
      return err instanceof RateLimitTimeoutError && /Concurrency limit/i.test(err.message);
    }
  );

  // Release 1 slot
  rel1();
  const statsAfter1 = _stats(scope, key);
  assert.equal(statsAfter1.activeConcurrency, 1);

  // 4th request now succeeds
  const rel4 = await acquire(scope, key, { rpm: 0, concurrency: 2, timeoutMs: 0 });
  assert.equal(typeof rel4, "function");

  // Clean up
  rel2();
  rel4();
  const statsFinal = _stats(scope, key);
  assert.equal(statsFinal.activeConcurrency, 0);
});

test("concurrency limiter handles zero/undefined concurrency as unlimited", async () => {
  _reset();
  const scope = "apikey";
  const key = "test-unlimited-" + Date.now();

  const releases = [];
  for (let i = 0; i < 10; i++) {
    const rel = await acquire(scope, key, { rpm: 0, concurrency: 0, timeoutMs: 0 });
    releases.push(rel);
  }

  for (const rel of releases) {
    rel();
  }
});
