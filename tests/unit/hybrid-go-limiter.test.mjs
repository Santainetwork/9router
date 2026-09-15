import test from "node:test";
import assert from "node:assert/strict";
import { isGoLimiterActive, goAcquire, goReset, goSnapshot, goBucketDetail } from "../../open-sse/services/hybrid/goLimiterClient.js";

test("hybrid Go engine client integrates with running Go daemon", async () => {
  const active = await isGoLimiterActive();
  if (!active) {
    console.log("Go engine not reachable on 20129, skipping live hybrid test");
    return;
  }

  const key = "test-go-hybrid-" + Date.now();

  // Test slot 1 (limit 1)
  const rel1 = await goAcquire("apikey", key, { rpm: 0, concurrency: 1, timeoutMs: 0 });
  assert.equal(typeof rel1, "function");

  // Test slot 2 (should fail with 429)
  await assert.rejects(
    async () => {
      await goAcquire("apikey", key, { rpm: 0, concurrency: 1, timeoutMs: 0 });
    },
    (err) => {
      return /concurrency/i.test(err.message);
    }
  );

  // Verify bucket-detail reflects active concurrency
  const detail = await goBucketDetail("apikey", key);
  assert.ok(detail, "bucket-detail must return a response");
  assert.equal(detail.activeConcurrency, 1, "bucket-detail shows 1 active slot");
  assert.equal(detail.concurrency, 1, "bucket-detail shows configured concurrency limit");

  // Release
  rel1();

  // Give 50ms for network release
  await new Promise((r) => setTimeout(r, 50));

  // Verify bucket-detail shows 0 after release
  const detailAfter = await goBucketDetail("apikey", key);
  assert.equal(detailAfter.activeConcurrency, 0, "bucket-detail shows 0 active after release");

  // Test slot 3 (now succeeds)
  const rel3 = await goAcquire("apikey", key, { rpm: 0, concurrency: 1, timeoutMs: 0 });
  assert.equal(typeof rel3, "function");
  rel3();

  // Snapshot should show the bucket count header
  const snap = await goSnapshot();
  assert.ok(snap, "snapshot must return a response");
  assert.equal(typeof snap.totalBuckets, "number", "snapshot includes totalBuckets count");

  // Cleanup
  await goReset("apikey", key);
});
