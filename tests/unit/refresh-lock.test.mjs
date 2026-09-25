// Task 5: Redis refresh ownership lock. Unique owner token, atomic
// compare-and-delete release, bounded TTL/renewal, AbortSignal cancellation,
// no local mutex fallback. Simulates two workers racing a single-use refresh.
import test from "node:test";
import assert from "node:assert/strict";

const { createRefreshLock, ReleaseResult } = await import("../../src/lib/redis/refreshLock.js");

function fakeRedis() {
  const store = new Map();
  const calls = { eval: [], set: [], get: [] };
  return {
    store,
    calls,
    async set(key, value, opts = {}) {
      calls.set.push([key, value, opts]);
      if (opts.NX && store.has(key)) return null;
      store.set(key, opts.PX ? { value, expiresAt: Date.now() + opts.PX } : { value });
      return "OK";
    },
    async get(key) {
      calls.get.push([key]);
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt && Date.now() > entry.expiresAt) { store.delete(key); return null; }
      return entry.value;
    },
    async eval(script_, { keys, arguments: args }) {
      calls.eval.push([script_, keys, args]);
      if (script_.includes("PEXPIRE")) {
        const entry = store.get(keys[0]);
        if (entry && entry.value === args[0]) return 1;
        return 0;
      }
      const entry = store.get(keys[0]);
      const current = entry && (!entry.expiresAt || Date.now() <= entry.expiresAt) ? entry.value : null;
      if (current === args[0]) {
        store.delete(keys[0]);
        return 1;
      }
      return 0;
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("acquire wins when the key is free and rejects when held", async () => {
  const redis = fakeRedis();
  const a = await createRefreshLock({ redis, key: "p:conn-1", ownerToken: "owner-a", ttlMs: 1000 }).acquire();
  const b = await createRefreshLock({ redis, key: "p:conn-1", ownerToken: "owner-b", ttlMs: 1000 }).acquire();

  assert.equal(a.locked, true);
  assert.equal(b.locked, false);
  assert.equal(redis.store.get("p:conn-1").value, "owner-a");
});

test("release only deletes when the owner token matches (compare-and-delete)", async () => {
  const redis = fakeRedis();
  const lock = await createRefreshLock({ redis, key: "p:conn-1", ownerToken: "owner-a", ttlMs: 1000 }).acquire();
  assert.equal(lock.locked, true);

  // Another owner cannot release.
  const wrong = await createRefreshLock({ redis, key: "p:conn-1", ownerToken: "owner-b", ttlMs: 1000 });
  assert.equal(await wrong.release(), ReleaseResult.NOT_OWNER);
  assert.equal(redis.store.has("p:conn-1"), true);

  assert.equal(await lock.release(), ReleaseResult.RELEASED);
  assert.equal(redis.store.has("p:conn-1"), false);
});

test("release after TTL expiry reports not-owner and leaves key free", async () => {
  const redis = fakeRedis();
  const lock = await createRefreshLock({ redis, key: "p:conn-1", ownerToken: "owner-a", ttlMs: 20 }).acquire();
  assert.equal(lock.locked, true);
  await sleep(40);
  assert.equal(await lock.release(), ReleaseResult.NOT_OWNER);
});

test("renewal keeps the lock alive and stops on AbortSignal", async () => {
  const redis = fakeRedis();
  const controller = new AbortController();
  const lock = await createRefreshLock({
    redis,
    key: "p:conn-1",
    ownerToken: "owner-a",
    ttlMs: 60,
    renewMs: 15,
    signal: controller.signal,
  }).acquire();

  await sleep(50);
  assert.equal(redis.store.get("p:conn-1").value, "owner-a", "renewal kept the key alive");

  controller.abort();
  const released = await lock.wait();
  assert.equal(released.aborted, true);
  assert.equal(redis.store.has("p:conn-1"), false);
});

test("two workers racing a single-use refresh: one upstream call, one commit", async () => {
  const redis = fakeRedis();
  const upstream = { calls: 0 };
  const commits = { versions: [] };

  async function refreshWorker(owner) {
    const lock = await createRefreshLock({ redis, key: "p:conn-1", ownerToken: owner, ttlMs: 500 }).acquire();
    if (!lock.locked) return { won: false, refreshed: false };
    try {
      // Read-after-lock: fetch latest connection version before refreshing.
      await lock.readLatest(async () => ({ version: commits.versions.length + 1, refreshToken: "single-use-rt" }));
      upstream.calls++;
      const version = commits.versions.length + 1;
      commits.versions.push(version);
      return { won: true, refreshed: true, version };
    } finally {
      await lock.release();
    }
  }

  const results = await Promise.all([refreshWorker("owner-a"), refreshWorker("owner-b")]);
  const winners = results.filter((r) => r.won);
  assert.equal(winners.length, 1);
  assert.equal(upstream.calls, 1);
  assert.equal(commits.versions.length, 1);
});
