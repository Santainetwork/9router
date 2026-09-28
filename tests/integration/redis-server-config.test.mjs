// Task 8 acceptance: real Redis preflight. A server without AOF/noeviction
// must fail the preflight; a correctly configured one must pass. Requires
// disposable Redis containers; skipped when REDIS_AOF_TEST_URL is unset.
import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "redis";

const url = process.env.REDIS_AOF_TEST_URL;
const unsafeUrl = process.env.REDIS_UNSAFE_TEST_URL;
const run = url ? test : test.skip;

async function probe(urlString) {
  const { checkRedisServerConfig } = await import("../../src/lib/redis/serverConfig.js");
  const client = createClient({ url: urlString, disableOfflineQueue: true });
  await client.connect();
  try {
    return await checkRedisServerConfig(client);
  } finally {
    await client.close();
  }
}

run("real Redis with AOF+noeviction passes the preflight", async () => {
  const result = await probe(url);
  assert.equal(result.ok, true, JSON.stringify(result));
});

(unsafeUrl ? test : test.skip)("real Redis without AOF fails the preflight", async () => {
  const result = await probe(unsafeUrl);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => /appendonly/i.test(i)));
});
