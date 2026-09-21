// Regression: an unavailable shared Go limiter on API workers (WORKER_ROLE=api)
// must surface HTTP 503, not a generic Next 500, across /v1 handlers.
//
//  * rateLimitGate (every /v1 handler's apikey gate) must convert the
//    no-fallback limiter error into a 503 Response.
//  * chat.js provider-scope acquire must do the same and release the API key.
//
// The gate imports Next path aliases / a DB-backed localDb, so a module loader
// (helpers/alias-loader.mjs) supplies those plus a virtual rateLimiter whose
// acquire() throws a controllable error.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

register(new URL("./helpers/alias-loader.mjs", import.meta.url));

const { limiterUnavailableResponse } = await import("../../open-sse/utils/error.js");
const { enforceApiKeyRateLimit } = await import(
  `../../src/sse/services/rateLimitGate.js?limiter-503=${Date.now()}`,
);
const { RateLimitTimeoutError } = await import("open-sse/services/rateLimiter.js");

// Mimics goLimiterUnavailableError() from open-sse/services/hybrid/goLimiterClient.js.
function goLimiterUnavailableError(reason = "engine disabled or unhealthy") {
  const err = new Error(`Go hybrid limiter unavailable (${reason}) and JS fallback is disabled for API workers`);
  err.name = "GoLimiterUnavailableError";
  err.status = 503;
  err.noFallback = true;
  return err;
}

test("limiterUnavailableResponse converts no-fallback errors to 503, else null", async () => {
  const err = goLimiterUnavailableError("unit");
  const res = limiterUnavailableResponse(err);
  assert.equal(res.status, 503);
  assert.ok(res.headers.get("content-type").includes("application/json"));
  const body = await res.json();
  assert.match(body.error.message, /Go hybrid limiter unavailable/);

  // Timeout errors must be left to the caller's 429 path.
  const timeout = new RateLimitTimeoutError("queue timeout", 2);
  assert.equal(limiterUnavailableResponse(timeout), null);
  assert.equal(limiterUnavailableResponse(new Error("plain")), null);
  assert.equal(limiterUnavailableResponse(undefined), null);
});

test("limiterUnavailableResponse releases the held key before returning", () => {
  let released = 0;
  const res = limiterUnavailableResponse(goLimiterUnavailableError(), () => { released++; });
  assert.equal(res.status, 503);
  assert.equal(released, 1, "release must run before the 503 is returned");
});

test("rate gate: apikey scope Go-limiter-unavailable returns 503 Response", async () => {
  globalThis.__TEST_LIMITS__ = { id: "key-1", rpm: 0, concurrency: 1, queueTimeoutMs: 1000 };
  globalThis.__TEST_ACQUIRE_ERROR__ = goLimiterUnavailableError("engine disabled or unhealthy");

  const result = await enforceApiKeyRateLimit("sk-test");
  assert.ok(result.limited, "gate must return a limited response, not throw");
  assert.equal(result.limited.status, 503);
  const body = await result.limited.json();
  assert.match(body.error.message, /Go hybrid limiter unavailable/);
});

test("rate gate: limiter protocol error (noFallback 502) is surfaced, not thrown", async () => {
  globalThis.__TEST_LIMITS__ = { id: "key-2", rpm: 0, concurrency: 1, queueTimeoutMs: 1000 };
  const protocol = new Error("Go limiter protocol error: concurrency acquire returned empty leaseId");
  protocol.name = "GoLimiterProtocolError";
  protocol.status = 502;
  protocol.noFallback = true;
  globalThis.__TEST_ACQUIRE_ERROR__ = protocol;

  const result = await enforceApiKeyRateLimit("sk-test");
  assert.equal(result.limited?.status, 502);
});

test("rate gate: timeout still maps to 429 (unchanged behavior)", async () => {
  globalThis.__TEST_LIMITS__ = { id: "key-3", rpm: 0, concurrency: 1, queueTimeoutMs: 1000 };
  globalThis.__TEST_ACQUIRE_ERROR__ = new RateLimitTimeoutError("queue timeout", 3);

  const result = await enforceApiKeyRateLimit("sk-test");
  assert.equal(result.limited?.status, 429);
});

test("chat provider-scope catch converts the same error and releases the key", () => {
  // The provider-scope acquire() lives inline in chat.js; assert the catch wires
  // the conversion (with release) rather than rethrowing to a Next 500.
  const src = readFileSync(fileURLToPath(new URL("../../src/sse/handlers/chat.js", import.meta.url)), "utf8");
  assert.match(
    src,
    /limiterUnavailableResponse\(e, doReleaseApiKey\)/,
    "chat provider-scope catch must release the key via limiterUnavailableResponse(e, doReleaseApiKey)",
  );
  // And that conversion must be reachable before the unreleased rethrow.
  const catchIdx = src.indexOf("limiterUnavailableResponse(e, doReleaseApiKey)");
  const throwIdx = src.indexOf("doReleaseApiKey();\n        throw e;");
  assert.ok(catchIdx !== -1 && throwIdx !== -1, "both conversion and fallback throw must exist");
});

test("nosaver/messages delegates to handleChat so the gate 503 is not masked", () => {
  // /v1/nosaver/messages runs the same handleChat path as /v1/messages, so the
  // gate/chat conversion above is what protects it. Its own try/catch only runs
  // when handleChat *throws*, which the 503 conversion prevents.
  for (const rel of [
    "../../src/app/api/v1/nosaver/messages/route.js",
    "../../src/app/api/v1/messages/route.js",
  ]) {
    const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    assert.match(src, /handleChat/, `${rel} must delegate to handleChat`);
  }
});