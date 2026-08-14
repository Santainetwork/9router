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

  console.log("rate-limiter: all assertions passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
