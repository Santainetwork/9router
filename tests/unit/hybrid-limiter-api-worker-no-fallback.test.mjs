// P0: API workers (WORKER_ROLE=api / NINEROUTER_WORKER_ROLE=api) must never fall
// back to the per-process JS limiter. Per-replica accounting would let each
// replica independently exceed the shared global concurrency/RPM budget, so an
// unavailable shared Go limiter must surface an actionable 503 instead.
import test from "node:test";
import assert from "node:assert/strict";

const { acquire, RateLimitTimeoutError, _reset } = await import(
  `../../open-sse/services/rateLimiter.js?api-worker-p0=${Date.now()}`
);
const { isGoLimiterActive, goLimiterUnavailableError } = await import(
  "../../open-sse/services/hybrid/goLimiterClient.js"
);

const ENV_KEYS = ["WORKER_ROLE", "NINEROUTER_WORKER_ROLE", "ENABLE_GO_HYBRID", "GO_ENGINE_URL"];

function setEnv(t, env) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  t.after(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

function stubFetch(t, handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(String(url));
    return handler(String(url), opts);
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

const ok = () => new Response(null, { status: 200 });
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("error shape: 503 + noFallback + actionable message", () => {
  const err = goLimiterUnavailableError("test reason");
  assert.equal(err.status, 503);
  assert.equal(err.noFallback, true);
  assert.equal(err.name, "GoLimiterUnavailableError");
  assert.match(err.message, /ENABLE_GO_HYBRID/);
});

test("api worker + hybrid disabled: rejects 503 noFallback, no fetch attempted", async (t) => {
  setEnv(t, { WORKER_ROLE: "api" });
  const calls = stubFetch(t, () => ok());

  await assert.rejects(
    acquire("apikey", "api-disabled", { concurrency: 1, timeoutMs: 1_000 }),
    (e) => e.status === 503 && e.noFallback === true && !(e instanceof RateLimitTimeoutError),
  );
  assert.equal(calls.length, 0, "must not touch the JS limiter or the network");
});

test("api worker + engine unhealthy: rejects 503 noFallback, never queues in JS", async (t) => {
  setEnv(t, { WORKER_ROLE: "api", ENABLE_GO_HYBRID: "true", GO_ENGINE_URL: "http://unhealthy.test" });
  const calls = stubFetch(t, (url) =>
    url.endsWith("/health") ? new Response(null, { status: 503 }) : json({ error: "x" }, 500));

  await isGoLimiterActive({ force: true }); // prime the health cache as unhealthy

  await assert.rejects(
    acquire("apikey", "api-unhealthy", { concurrency: 1, timeoutMs: 1_000 }),
    (e) => e.status === 503 && e.noFallback === true,
  );
  assert.ok(!calls.some((u) => u.includes("/acquire")), "must not attempt an acquire");
});

test("api worker + network failure mid-acquire: rejects 503 noFallback", async (t) => {
  setEnv(t, { WORKER_ROLE: "api", ENABLE_GO_HYBRID: "true", GO_ENGINE_URL: "http://flaky.test" });
  stubFetch(t, (url) => (url.endsWith("/health") ? ok() : json({ allowed: true, leaseId: "l1" })));
  await isGoLimiterActive({ force: true }); // prime as healthy

  stubFetch(t, (url) => {
    if (url.endsWith("/health")) return ok();
    throw new TypeError("fetch failed");
  });

  await assert.rejects(
    acquire("apikey", "api-flaky", { concurrency: 1, timeoutMs: 1_000 }),
    (e) => e.status === 503 && e.noFallback === true && /network failure/.test(e.message),
  );
});

test("api worker + 429 still surfaces as RateLimitTimeoutError", async (t) => {
  setEnv(t, { WORKER_ROLE: "api", ENABLE_GO_HYBRID: "true", GO_ENGINE_URL: "http://busy.test" });
  stubFetch(t, (url) => (url.endsWith("/health") ? ok() : json({ allowed: true, leaseId: "l1" })));
  await isGoLimiterActive({ force: true });

  stubFetch(t, (url) =>
    url.endsWith("/health") ? ok() : json({ error: "queue timeout" }, 429));

  await assert.rejects(
    acquire("apikey", "api-busy", { concurrency: 1, timeoutMs: 1_000 }),
    (e) => e instanceof RateLimitTimeoutError && e.retryAfter === 1,
  );
});

test("api worker + no limits: immediate no-op even with limiter disabled", async (t) => {
  setEnv(t, { WORKER_ROLE: "api" });
  const calls = stubFetch(t, () => ok());
  _reset();

  const release = await acquire("apikey", "api-nolimits", {});
  assert.equal(typeof release, "function");
  release();
  assert.equal(calls.length, 0);
});

test("control node + limiter disabled: JS fallback still works (unchanged)", async (t) => {
  setEnv(t, {});
  const calls = stubFetch(t, () => ok());
  _reset();

  const release = await acquire("apikey", "control-disabled", { concurrency: 1, timeoutMs: 1_000 });
  assert.equal(typeof release, "function");
  release();
  assert.equal(calls.length, 0);
});

test("api worker via NINEROUTER_WORKER_ROLE: same hard-fail", async (t) => {
  setEnv(t, { NINEROUTER_WORKER_ROLE: "api" });
  stubFetch(t, () => ok());

  await assert.rejects(
    acquire("apikey", "api-alt-env", { rpm: 5, timeoutMs: 1_000 }),
    (e) => e.status === 503 && e.noFallback === true,
  );
});
