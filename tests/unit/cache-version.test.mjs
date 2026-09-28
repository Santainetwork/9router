// Task 6: version-checked read-through cache. A critical cache must compare the
// committed SQLite dbVersion before reuse; Pub/Sub is only a wake-up hint, so a
// missed invalidation is still caught by the version poll.
import test from "node:test";
import assert from "node:assert/strict";

const { createVersionedCache, readCommittedDbVersion } = await import("../../src/lib/redis/cacheVersion.js");

test("readCommittedDbVersion returns the committed version or 0 when absent", async () => {
  assert.equal(await readCommittedDbVersion({ get: () => ({ version: 7 }) }), 7);
  assert.equal(await readCommittedDbVersion({ get: () => undefined }), 0);
  assert.equal(await readCommittedDbVersion({ get: () => { throw new Error("boom"); } }), 0);
});

test("cache hits within TTL while the committed version is unchanged", async () => {
  let version = 3;
  let loads = 0;
  const db = { get: () => ({ version }) };
  const cache = createVersionedCache({
    load: async () => { loads++; return `v${version}`; },
    readVersion: (d) => readCommittedDbVersion(d),
    now: () => 1000,
  });
  // Provide a db source; the factory reads it through its default loader here.
  const first = await cache.get(db);
  const second = await cache.get(db);
  assert.equal(first, "v3");
  assert.equal(second, "v3");
  assert.equal(loads, 1);
});

test("cache misses when the committed version bumps even with no Pub/Sub hint", async () => {
  let version = 3;
  let loads = 0;
  const db = { get: () => ({ version }) };
  let t = 1000;
  const cache = createVersionedCache({
    load: async () => { loads++; return `v${version}`; },
    readVersion: (d) => readCommittedDbVersion(d),
    now: () => t,
  });
  assert.equal(await cache.get(db), "v3");
  // Missed invalidation: writer bumped the version but no Pub/Sub arrived.
  version = 4;
  assert.equal(await cache.get(db), "v4");
  assert.equal(loads, 2);
});

test("cache misses on TTL expiry even at the same version", async () => {
  let loads = 0;
  let t = 1000;
  const db = { get: () => ({ version: 1 }) };
  const cache = createVersionedCache({
    load: async () => { loads++; return "x"; },
    readVersion: (d) => readCommittedDbVersion(d),
    ttlMs: 5000,
    now: () => t,
  });
  await cache.get(db);
  t = 1000 + 5001;
  await cache.get(db);
  assert.equal(loads, 2);
});

test("invalidate forces the next read to reload", async () => {
  let loads = 0;
  const db = { get: () => ({ version: 1 }) };
  const cache = createVersionedCache({
    load: async () => { loads++; return "x"; },
    readVersion: (d) => readCommittedDbVersion(d),
    now: () => 1000,
  });
  await cache.get(db);
  cache.invalidate();
  await cache.get(db);
  assert.equal(loads, 2);
});

test("a finished load never nulls a newer in-flight promise", async () => {
  // Sequence: promise A settles and writes fresh state; a second get() then
  // installs promise B (after an invalidate, so it must reload). A's finally
  // must not clear B — otherwise a concurrent caller sees state.promise null,
  // misses the dedup, and fires a duplicate load. Identity check, not
  // truthiness, is what protects B.
  let loads = 0;
  let resolveA;
  let resolveB;
  const db = { get: () => ({ version: 1 }) };
  const cache = createVersionedCache({
    load: () => new Promise((resolve) => { loads++; if (loads === 1) resolveA = resolve; else resolveB = resolve; }),
    readVersion: (d) => readCommittedDbVersion(d),
    now: () => 1000,
  });
  const first = cache.get(db);
  await new Promise((r) => setTimeout(r, 5));
  resolveA("a");
  assert.equal(await first, "a");
  // Force the next get to miss so it installs a new in-flight promise B.
  cache.invalidate();
  const second = cache.get(db);
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(resolveB, "second load is in flight");
  // A's identity-guarded finally ran here; it must not have cleared B.
  const third = cache.get(db);
  await new Promise((r) => setTimeout(r, 5));
  resolveB("b");
  const results = await Promise.all([second, third]);
  assert.deepEqual(results, ["b", "b"], "concurrent callers share the in-flight promise B");
  assert.equal(loads, 2, "no duplicate load was fired after A's stale finally");
});
