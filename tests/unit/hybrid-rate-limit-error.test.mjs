import test from "node:test";
import assert from "node:assert/strict";

process.env.ENABLE_GO_HYBRID = "true";
process.env.GO_ENGINE_URL = "http://limiter.test";

const { acquire, RateLimitTimeoutError } = await import(
  `../../open-sse/services/rateLimiter.js?hybrid-timeout=${Date.now()}`
);

test("hybrid limiter 429 is exposed as RateLimitTimeoutError", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/health")) return new Response(null, { status: 200 });
    return new Response(JSON.stringify({ error: "rate limit / concurrency queue timeout" }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
  };

  await assert.rejects(
    acquire("apikey", "key-1", { concurrency: 1, timeoutMs: 1_000 }),
    (error) => error instanceof RateLimitTimeoutError && error.retryAfter === 1,
  );
});

test("protocol error (empty leaseId on concurrency grant) does not fall back to JS", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/health")) return new Response(null, { status: 200 });
    return new Response(JSON.stringify({ allowed: true, leaseId: "" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  await assert.rejects(
    acquire("apikey", "key-protocol", { concurrency: 1, timeoutMs: 1_000 }),
    (error) => error.name === "GoLimiterProtocolError" && error.noFallback === true,
  );
});
