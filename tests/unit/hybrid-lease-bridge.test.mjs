import test from "node:test";
import assert from "node:assert/strict";

process.env.ENABLE_GO_HYBRID = "true";
process.env.GO_ENGINE_URL = "http://limiter.test";

const { goAcquire, goRelease } = await import(
  `../../open-sse/services/hybrid/goLimiterClient.js?lease-bridge=${Date.now()}`
);

test("goAcquire captures leaseId and release callback sends it", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const leaseId = "opaque-lease-123";
  const releases = [];

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith("/health")) return new Response(null, { status: 200 });
    if (u.endsWith("/v1/limiter/acquire")) {
      return new Response(JSON.stringify({ allowed: true, leaseId }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.endsWith("/v1/limiter/release")) {
      releases.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ released: true }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${u}`);
  };

  const releaseFn = await goAcquire("apikey", "key-1", { concurrency: 1 });
  assert.equal(typeof releaseFn, "function");

  releaseFn();
  releaseFn(); // duplicate callback must not double-release
  // Give the async release a tick to run.
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(releases.length, 1);
  assert.equal(releases[0].leaseId, leaseId);
  assert.equal(releases[0].scope, "apikey");
  assert.equal(releases[0].key, "key-1");
});

test("RPM-only acquire with empty leaseId is a safe no-op release", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith("/health")) return new Response(null, { status: 200 });
    if (u.endsWith("/v1/limiter/acquire")) {
      return new Response(JSON.stringify({ allowed: true, leaseId: "" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.endsWith("/v1/limiter/release")) {
      calls.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ released: true }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${u}`);
  };

  const releaseFn = await goAcquire("apikey", "key-rpm", { rpm: 10, concurrency: 0 });
  assert.equal(typeof releaseFn, "function");

  releaseFn();
  await new Promise((r) => setTimeout(r, 10));

  // No release call and no invalid release body may ever be sent.
  assert.equal(calls.length, 0);
});

test("goAcquire throws protocol error when concurrency grant has empty leaseId", async (t) => {
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
    goAcquire("apikey", "key-protocol", { concurrency: 1 }),
    (err) => err.name === "GoLimiterProtocolError" && err.status === 502,
  );
});

test("goRelease retries a network failure once", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  let attempts = 0;
  globalThis.fetch = async (url) => {
    attempts += 1;
    if (attempts === 1) throw new Error("ECONNRESET");
    return new Response(JSON.stringify({ released: true }), { status: 200 });
  };

  await goRelease("apikey", "key-2", "opaque-lease-456");
  assert.equal(attempts, 2);
});

test("goAcquire preserves caller abort signal", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const ac = new AbortController();
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/health")) return new Response(null, { status: 200 });
    // Abort the acquire from the caller side.
    ac.abort();
    throw init.signal.reason;
  };

  await assert.rejects(
    goAcquire("apikey", "key-3", { concurrency: 1, signal: ac.signal }),
    /abort/i,
  );
});
