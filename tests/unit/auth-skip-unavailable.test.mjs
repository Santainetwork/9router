// A connection marked testStatus:"unavailable" keeps that marker after its
// cooldown expires, and auth.js only filters on model locks. Left unfiltered,
// every request walks all of them: observed 48 qoder accounts in that state
// adding 28-45s per request. The account must be skipped while the marker is
// stale (no active lock), and must still be reachable when a lock is live.
//
// Non-credential statuses are the exception: a 404 (model missing), a 400
// (request rejected) or a transient 5xx is not evidence against the credential.
// Those used to poison the marker permanently, so one missing model or one
// upstream hiccup killed a healthy account.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getEarliestModelLockUntil } from "../../open-sse/services/accountFallback.js";

const futureIso = () => new Date(Date.now() + 60_000).toISOString();
const pastIso = () => new Date(Date.now() - 60_000).toISOString();

// Mirrors the guard in auth.js availability filtering.
const NON_CREDENTIAL_ERROR_CODES = new Set([400, 404, 406, 429, 500, 502, 503, 504]);
const isSkippable = (c) =>
  c.testStatus === "unavailable" &&
  !NON_CREDENTIAL_ERROR_CODES.has(Number(c.errorCode)) &&
  !getEarliestModelLockUntil(c);

test("stale unavailable account with no lock is skipped", () => {
  assert.equal(isSkippable({ testStatus: "unavailable", lastErrorAt: pastIso() }), true);
});

test("stale 429 rate limit is NOT permanently skipped once lock expires", () => {
  assert.equal(isSkippable({ testStatus: "unavailable", errorCode: 429, lastErrorAt: pastIso() }), false);
});

test("stale 404 model-missing marker does NOT disable the credential", () => {
  assert.equal(isSkippable({ testStatus: "unavailable", errorCode: 404, lastErrorAt: pastIso() }), false);
});

test("stale transient 5xx marker does NOT disable the credential", () => {
  for (const code of [500, 502, 503, 504]) {
    assert.equal(isSkippable({ testStatus: "unavailable", errorCode: code, lastErrorAt: pastIso() }), false);
  }
});

test("stale 400 request-rejected marker does NOT disable the credential", () => {
  assert.equal(isSkippable({ testStatus: "unavailable", errorCode: 400, lastErrorAt: pastIso() }), false);
  assert.equal(isSkippable({ testStatus: "unavailable", errorCode: 406, lastErrorAt: pastIso() }), false);
});

test("stale auth failures (401/403) stay skipped until a probe clears them", () => {
  assert.equal(isSkippable({ testStatus: "unavailable", errorCode: 401, lastErrorAt: pastIso() }), true);
  assert.equal(isSkippable({ testStatus: "unavailable", errorCode: 403, lastErrorAt: pastIso() }), true);
});

test("unavailable account with an expired lock is still skipped", () => {
  assert.equal(isSkippable({ testStatus: "unavailable", modelLock_gpt: pastIso() }), true);
});

test("unavailable account with a live lock is handled by the lock filter, not skipped twice", () => {
  // getEarliestModelLockUntil returns a value, so the new guard does not fire;
  // isModelLockActive() upstream (tested elsewhere) is what excludes it.
  assert.equal(isSkippable({ testStatus: "unavailable", modelLock_gpt: futureIso() }), false);
});

test("healthy account is never skipped", () => {
  assert.equal(isSkippable({ testStatus: "active" }), false);
  assert.equal(isSkippable({}), false);
});

test("getEarliestModelLockUntil ignores non-lock keys and empty values", () => {
  assert.equal(getEarliestModelLockUntil({ testStatus: "unavailable", name: "x", modelLock_a: null }), null);
  assert.equal(getEarliestModelLockUntil(null), null);
});
