// A connection marked testStatus:"unavailable" keeps that marker after its
// cooldown expires, and auth.js only filters on model locks. Left unfiltered,
// every request walks all of them: observed 48 qoder accounts in that state
// adding 28-45s per request. The account must be skipped while the marker is
// stale (no active lock), and must still be reachable when a lock is live.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getEarliestModelLockUntil } from "../../open-sse/services/accountFallback.js";

const futureIso = () => new Date(Date.now() + 60_000).toISOString();
const pastIso = () => new Date(Date.now() - 60_000).toISOString();

// Mirrors the guard added to auth.js availability filtering.
const isSkippable = (c) => c.testStatus === "unavailable" && !getEarliestModelLockUntil(c);

test("stale unavailable account with no lock is skipped", () => {
  assert.equal(isSkippable({ testStatus: "unavailable", lastErrorAt: pastIso() }), true);
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
