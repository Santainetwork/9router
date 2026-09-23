import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { mapSharedProviderActivity, mergeActiveRequests } from "../../src/shared/utils/usageActivity.js";

const hash = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

test("shared Go provider buckets become Usage active requests", () => {
  const connections = [
    { id: "conn-1", provider: "antigravity", name: "Primary AG" },
    { id: "conn-2", provider: "openrouter", name: "Backup OR" },
  ];
  const buckets = [
    { scope: "provider", key: hash("conn-1"), activeConcurrency: 3 },
    { scope: "provider", key: hash("conn-2"), activeConcurrency: 0 },
    { scope: "apikey", key: hash("key-1"), activeConcurrency: 9 },
  ];

  assert.deepEqual(mapSharedProviderActivity(buckets, connections), [{
    connectionId: "conn-1",
    model: "In-flight",
    provider: "antigravity",
    account: "Primary AG",
    count: 3,
  }]);
});

test("shared activity drops unknown and malformed buckets", () => {
  assert.deepEqual(mapSharedProviderActivity([
    { scope: "provider", key: hash("missing"), activeConcurrency: 2 },
    { scope: "provider", key: hash("conn-1"), activeConcurrency: -1 },
  ], [{ id: "conn-1", provider: "antigravity" }]), []);
});

test("local model detail and shared aggregate activity are both preserved", () => {
  const local = [{ connectionId: "conn-1", model: "model-a", provider: "antigravity", account: "Primary AG", count: 1 }];
  const shared = [
    { connectionId: "conn-1", model: "In-flight", provider: "antigravity", account: "Primary AG", count: 2 },
    { connectionId: "conn-2", model: "In-flight", provider: "openrouter", account: "Backup OR", count: 3 },
  ];
  assert.deepEqual(mergeActiveRequests(local, shared), [local[0], ...shared]);
});
