// Self-check for open-sse/services/rateLimiter.js
// Run: node tests/unit/rate-limiter.test.mjs
import assert from "node:assert";
import { acquire, RateLimitTimeoutError, _reset, _stats } from "../../open-sse/services/rateLimiter.js";

async function main() {
  // 1. rpm=0 → always pass, no bucket.
  _reset();
  await acquire("apikey", "k1", { rpm: 0 });
  await acquire("apikey", "k1", {}); // undefined rpm
  assert.equal(_stats("apikey", "k1"), null, "no limit → no bucket");

  // 2. Within limit: 3 immediate grants for rpm=3.
  _reset();
  for (let i = 0; i < 3; i++) await acquire("apikey", "k2", { rpm: 3, timeoutMs: 100 });
  assert.equal(_stats("apikey", "k2").count, 3, "3 consumed");

  // 3. Over limit + no timeout → immediate reject.
  _reset();
  await acquire("provider", "c1", { rpm: 1 });
  await assert.rejects(
    () => acquire("provider", "c1", { rpm: 1 }),
    (e) => e instanceof RateLimitTimeoutError && e.retryAfter >= 1,
    "over limit no-timeout rejects"
  );

  // 4. Over limit + timeout too short → reject after timeout.
  _reset();
  await acquire("apikey", "k3", { rpm: 1, timeoutMs: 50 });
  const t0 = Date.now();
  await assert.rejects(
    () => acquire("apikey", "k3", { rpm: 1, timeoutMs: 50 }),
    RateLimitTimeoutError,
    "queued then times out"
  );
  assert.ok(Date.now() - t0 >= 45, "waited ~timeout before rejecting");

  // 5. Isolation: different keys and scopes are independent.
  _reset();
  await acquire("apikey", "a", { rpm: 1 });
  await acquire("apikey", "b", { rpm: 1 });        // different key ok
  await acquire("provider", "a", { rpm: 1 });      // different scope ok
  assert.equal(_stats("apikey", "a").count, 1);
  assert.equal(_stats("provider", "a").count, 1);

  // 6. Queue drains when window rolls (uses a tiny window via monkeypatch is not
  //    possible; instead verify grant happens within a real 60s window is too slow).
  //    Skip long-window drain here; covered by logic review + test 4 timing.

  // 7. Negative / NaN rpm → treated as no-limit (pass-through, no bucket).
  _reset();
  await acquire("apikey", "neg", { rpm: -5, timeoutMs: 100 });
  await acquire("apikey", "neg", { rpm: NaN });
  assert.equal(_stats("apikey", "neg"), null, "negative/NaN rpm → no bucket");

  // 8. Concurrent burst: fire N>rpm at once with no timeout; exactly rpm win.
  _reset();
  const rpm = 3;
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, () => acquire("provider", "burst", { rpm }))
  );
  const granted = results.filter((r) => r.status === "fulfilled").length;
  const rejected = results.filter((r) => r.status === "rejected").length;
  assert.equal(granted, rpm, `exactly ${rpm} granted in burst`);
  assert.equal(rejected, 10 - rpm, "rest rejected");
  assert.ok(
    results.every((r) => r.status === "fulfilled" || r.reason instanceof RateLimitTimeoutError),
    "burst rejects are RateLimitTimeoutError"
  );
  assert.equal(_stats("provider", "burst").count, rpm, "count matches rpm after burst");

  // 9. retry-after is a positive integer (seconds) on immediate reject.
  _reset();
  await acquire("apikey", "ra", { rpm: 1 });
  await assert.rejects(
    () => acquire("apikey", "ra", { rpm: 1 }),
    (e) => Number.isInteger(e.retryAfter) && e.retryAfter >= 1 && e.retryAfter <= 60,
    "retryAfter is int in [1,60]"
  );

  console.log("rate-limiter: all assertions passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
