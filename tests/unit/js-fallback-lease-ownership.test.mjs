import test from "node:test";
import assert from "node:assert/strict";

process.env.ENABLE_GO_HYBRID = "false";

const originalSetInterval = globalThis.setInterval;
const originalNow = Date.now;
let watchdog;
let clock = 1_000_000;
globalThis.setInterval = (fn) => {
  watchdog = fn;
  return { unref() {} };
};
Date.now = () => clock;

const { acquire, _stats, _reset } = await import(
  `../../open-sse/services/rateLimiter.js?fallback-lease=${originalNow()}`
);
globalThis.setInterval = originalSetInterval;

test("stale fallback release cannot free a newer owned slot", async (t) => {
  t.after(() => {
    _reset();
    Date.now = originalNow;
    globalThis.setInterval = originalSetInterval;
  });

  const key = `fallback-lease-${originalNow()}`;
  const releaseStale = await acquire("apikey", key, { concurrency: 2 });
  clock += 4 * 60_000;
  const releaseFresh = await acquire("apikey", key, { concurrency: 2 });
  assert.equal(_stats("apikey", key).activeConcurrency, 2);

  clock += 2 * 60_000;
  watchdog();
  assert.equal(_stats("apikey", key).activeConcurrency, 1, "watchdog expires only the old slot");

  releaseStale();
  assert.equal(_stats("apikey", key).activeConcurrency, 1, "stale owner cannot release fresh slot");

  releaseFresh();
  assert.equal(_stats("apikey", key).activeConcurrency, 0);
});
