// A model that 404s is a model problem, not a credential problem. The lock has
// to be long enough that the same dead model is not probed again minutes later
// (each probe is an upstream 404), while every other model on the account keeps
// working and the connection's health markers stay untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { modelLockMsForStatus, MODEL_NOT_FOUND_LOCK_MS } from "../../open-sse/services/accountFallback.js";

test("404 locks the model for the long window", () => {
  assert.equal(modelLockMsForStatus(404, 2 * 60 * 1000), MODEL_NOT_FOUND_LOCK_MS);
  assert.equal(MODEL_NOT_FOUND_LOCK_MS, 6 * 60 * 60 * 1000);
});

test("406 (model unsupported) uses the same long window", () => {
  assert.equal(modelLockMsForStatus(406, 2000), MODEL_NOT_FOUND_LOCK_MS);
});

test("a longer provider cooldown is never shortened", () => {
  const longer = MODEL_NOT_FOUND_LOCK_MS * 2;
  assert.equal(modelLockMsForStatus(404, longer), longer);
});

test("transient limits keep their short cooldown", () => {
  assert.equal(modelLockMsForStatus(429, 30_000), 30_000);
  assert.equal(modelLockMsForStatus(503, 30_000), 30_000);
});

test("missing cooldown for a 404 still yields the long window", () => {
  assert.equal(modelLockMsForStatus(404, 0), MODEL_NOT_FOUND_LOCK_MS);
  assert.equal(modelLockMsForStatus(404, undefined), MODEL_NOT_FOUND_LOCK_MS);
});
