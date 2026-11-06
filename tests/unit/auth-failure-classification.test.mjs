// Which upstream failures may mark a credential "unavailable".
//
// A persisted "unavailable" marker survives the model lock that produced it, and
// getProviderCredentials then skips the account forever — nothing can succeed to
// clear it. So only real credential faults may persist it; a missing model, a
// rejected request, a rate limit or an upstream 5xx must only lock that model.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  persistsUnavailableMarker,
  skipsStaleUnavailable,
  modelLockMsForStatus,
  MODEL_NOT_FOUND_LOCK_MS,
} from "../../open-sse/services/accountFallback.js";

test("only 401/402/403 persist an unavailable marker", () => {
  for (const status of [401, 402, 403]) {
    assert.equal(persistsUnavailableMarker(status), true, `status ${status}`);
  }
});

test("model/request/upstream failures never persist an unavailable marker", () => {
  for (const status of [400, 404, 406, 429, 500, 502, 503, 504]) {
    assert.equal(persistsUnavailableMarker(status), false, `status ${status}`);
  }
});

test("stale markers from non-credential statuses do not keep an account skipped", () => {
  for (const code of [400, 404, 406, 429, 500, 502, 503, 504]) {
    assert.equal(skipsStaleUnavailable(code), false, `errorCode ${code}`);
  }
});

test("stale markers from credential statuses keep the account skipped", () => {
  for (const code of [401, 402, 403]) {
    assert.equal(skipsStaleUnavailable(code), true, `errorCode ${code}`);
  }
});

test("a marker with no errorCode is still treated as stale and skipped", () => {
  // Legacy rows written before errorCode was recorded; skipping them avoids the
  // 28-45s walk over dead connections that the original guard fixed.
  assert.equal(skipsStaleUnavailable(null), true);
  assert.equal(skipsStaleUnavailable(undefined), true);
});

test("404/406 lock the model for the long window, others keep their cooldown", () => {
  assert.equal(modelLockMsForStatus(404, 120000), MODEL_NOT_FOUND_LOCK_MS);
  assert.equal(modelLockMsForStatus(406, 5000), MODEL_NOT_FOUND_LOCK_MS);
  assert.equal(modelLockMsForStatus(429, 30000), 30000);
  assert.equal(modelLockMsForStatus(502, 30000), 30000);
});
