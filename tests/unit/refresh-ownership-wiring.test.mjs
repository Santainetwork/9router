// Task 5 (P4): refresh-lock runtime wiring. The Redis refresh lock helper
// existed but was never called from the credential refresh path, so two SQLite
// Redis multicore API workers could still rotate one single-use refresh token.
//
// These tests simulate two worker processes by loading the credential manager
// twice under distinct module URLs: each copy has its own process-local lock
// Map, so any single-upstream-rotation guarantee must come from the shared
// Redis lock.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const managerSource = await readFile(
  new URL("../../open-sse/services/oauthCredentialManager.js", import.meta.url),
  "utf8",
);

// proxyFetch captures globalThis.fetch once, at its first import (triggered by
// the first credential-manager import below). Install one stable dispatcher now
// and route each test through it, so every later module copy reaches the
// current test's stub instead of a stale one.
let httpStub = async () => { throw new Error("no HTTP stub installed for this test"); };
globalThis.fetch = (url, options) => httpStub(url, options);

function fakeRedis() {
  const store = new Map();
  const calls = { set: 0, eval: 0 };
  return {
    store,
    calls,
    async set(key, value, opts = {}) {
      calls.set++;
      if (opts.NX && store.has(key)) return null;
      store.set(key, opts.PX ? { value, expiresAt: Date.now() + opts.PX } : { value });
      return "OK";
    },
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt && Date.now() > entry.expiresAt) { store.delete(key); return null; }
      return entry.value;
    },
    async eval(script, { keys, arguments: args }) {
      calls.eval++;
      const entry = store.get(keys[0]);
      const live = entry && (!entry.expiresAt || Date.now() <= entry.expiresAt) ? entry.value : null;
      if (script.includes("PEXPIRE")) return live === args[0] ? 1 : 0;
      if (live === args[0]) { store.delete(keys[0]); return 1; }
      return 0;
    },
  };
}

// One committed connection row shared by both worker copies. The upstream stub
// writes the row the control writer would commit, so a second rotation is
// observable as a second committed version.
function sharedWorkerHarness({ ttlMs = 30_000, renewMs = 5_000, refreshDelayMs = 0 } = {}) {
  const redis = fakeRedis();
  const row = { id: "conn-1", provider: "claude", accessToken: "at-0", refreshToken: "rt-0" };
  const upstream = { rotations: 0 };
  const commits = { versions: [] };

  httpStub = async () => {
    if (refreshDelayMs) await new Promise((r) => setTimeout(r, refreshDelayMs));
    upstream.rotations++;
    const version = commits.versions.length + 1;
    row.accessToken = `at-${version}`;
    row.refreshToken = `rt-${version}`;
    commits.versions.push(version);
    return new Response(
      JSON.stringify({ access_token: row.accessToken, refresh_token: row.refreshToken, expires_in: 3600 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  return {
    redis,
    row,
    upstream,
    commits,
    deps: { redis, readLatest: async () => ({ ...row }), pollMs: 5, deadlineMs: 1000, ttlMs, renewMs },
    restore: () => { httpStub = async () => { throw new Error("stub restored"); }; },
  };
}

function withEnv(env, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

async function loadWorkerCopy(workerId) {
  return await import(`../../open-sse/services/oauthCredentialManager.js?worker=${workerId}`);
}

const MULTICORE_API_WORKER = {
  DB_TYPE: "sqlite",
  SQLITE_MULTICORE: "redis",
  WORKER_ROLE: "api",
  DATABASE_URL: undefined,
};

test("refresh path is wired to the distributed lock helper", () => {
  assert.match(managerSource, /withDistributedRefreshOwnership/);
});

test("two workers racing one refresh: one upstream rotation, one committed version", async () => {
  const harness = sharedWorkerHarness();
  globalThis.__refreshOwnershipTestDeps = harness.deps;
  try {
    await withEnv(MULTICORE_API_WORKER, async () => {
      const [w1, w2] = await Promise.all([loadWorkerCopy("a"), loadWorkerCopy("b")]);
      const credentials = { connectionId: "conn-1", provider: "claude", accessToken: "at-0", refreshToken: "rt-0" };

      const results = await Promise.all([
        w1.refreshProviderCredentials("claude", credentials, null),
        w2.refreshProviderCredentials("claude", credentials, null),
      ]);

      assert.equal(harness.upstream.rotations, 1, "exactly one upstream rotation");
      assert.equal(harness.commits.versions.length, 1, "exactly one committed token version");
      assert.ok(harness.redis.calls.set >= 1, "the Redis lock was actually used");
      for (const result of results) {
        assert.ok(result?.accessToken, "every caller observes a usable credential");
        assert.equal(result.refreshToken, "rt-1", "no caller keeps a consumed refresh token");
      }
    });
  } finally {
    delete globalThis.__refreshOwnershipTestDeps;
    harness.restore();
  }
});

test("lock loss discards this worker's rotation and uses committed credentials", async () => {
  // Short TTL with renewal: a steal during the refresh makes the renewal
  // compare-and-swap fail, so ownership is lost while refreshFn is still running.
  const harness = sharedWorkerHarness({ ttlMs: 60, renewMs: 15, refreshDelayMs: 60 });
  const stealingRedis = {
    ...harness.redis,
    async eval(script, { keys, arguments: args }) {
      if (script.includes("PEXPIRE")) harness.redis.store.set(keys[0], { value: "other-owner" });
      return harness.redis.eval(script, { keys, arguments: args });
    },
  };
  globalThis.__refreshOwnershipTestDeps = { ...harness.deps, redis: stealingRedis };
  try {
    await withEnv(MULTICORE_API_WORKER, async () => {
      const { withDistributedRefreshOwnership } = await import("../../src/lib/redis/refreshOwnership.js");
      const outcome = await withDistributedRefreshOwnership({
        key: "claude:conn-1",
        connectionId: "conn-1",
        credentials: { connectionId: "conn-1", accessToken: "at-0", refreshToken: "rt-0" },
        refreshFn: async () => {
          harness.upstream.rotations++;
          // Outlive several renewal intervals so the steal lands mid-refresh.
          await new Promise((r) => setTimeout(r, 60));
          // Do not write the shared row: the point of the test is that this
          // worker's own rotation result is discarded when ownership is lost.
          return { accessToken: "at-stale", refreshToken: "rt-stale" };
        },
      });
      assert.equal(outcome.lockLost, true, "lost ownership is reported");
      assert.notEqual(outcome.result?.accessToken, "at-stale", "stale rotation is not returned");
      assert.equal(outcome.result?.accessToken, "at-0", "committed credentials are returned");
    });
  } finally {
    delete globalThis.__refreshOwnershipTestDeps;
    harness.restore();
  }
});

test("persist callback runs while the lock is still held", async () => {
  // The committed row must be visible before the lock is released: otherwise a
  // second worker acquires, readLatest still shows the pre-rotation identity,
  // and it rotates the same single-use refresh token a second time. The persist
  // step therefore has to run inside the ownership critical section.
  const harness = sharedWorkerHarness();
  const events = [];
  const persistingRedis = {
    ...harness.redis,
    async eval(script, { keys, arguments: args }) {
      const res = await harness.redis.eval(script, { keys, arguments: args });
      // Release-path eval means the lock is being dropped.
      if (!script.includes("PEXPIRE") && script.includes("DEL")) events.push("lock-released");
      return res;
    },
  };
  globalThis.__refreshOwnershipTestDeps = { ...harness.deps, redis: persistingRedis };
  try {
    await withEnv(MULTICORE_API_WORKER, async () => {
      const { withDistributedRefreshOwnership } = await import("../../src/lib/redis/refreshOwnership.js");
      const outcome = await withDistributedRefreshOwnership({
        key: "claude:conn-1",
        connectionId: "conn-1",
        credentials: { connectionId: "conn-1", accessToken: "at-0", refreshToken: "rt-0" },
        refreshFn: async () => {
          events.push("rotated");
          return { accessToken: "at-1", refreshToken: "rt-1" };
        },
        persistFn: async () => {
          events.push("persist-start");
          await new Promise((r) => setTimeout(r, 30));
          events.push("persist-done");
        },
      });
      assert.equal(outcome.owner, true);
      assert.deepEqual(events, ["rotated", "persist-start", "persist-done", "lock-released"],
        "persist must complete before the lock is released");
    });
  } finally {
    delete globalThis.__refreshOwnershipTestDeps;
    harness.restore();
  }
});

test("single-process and PostgreSQL roles keep the local path and never touch Redis", async () => {
  for (const env of [
    { DB_TYPE: "sqlite", SQLITE_MULTICORE: undefined, WORKER_ROLE: undefined, DATABASE_URL: undefined },
    { DB_TYPE: "postgres", SQLITE_MULTICORE: "redis", WORKER_ROLE: "api",
      DATABASE_URL: "postgres://u:p@localhost:5432/db" },
  ]) {
    const harness = sharedWorkerHarness();
    globalThis.__refreshOwnershipTestDeps = harness.deps;
    try {
      await withEnv(env, async () => {
        // One process copy: the unchanged local Map must still dedupe in-process.
        const mod = await loadWorkerCopy(`local-${env.DB_TYPE}`);
        // Fresh refresh token per case: tokenRefresh/dedup.js keeps a 10s
        // module-level result cache keyed by provider:refreshToken, which would
        // otherwise serve an earlier test's result without any HTTP call.
        const credentials = {
          connectionId: "conn-1",
          provider: "claude",
          accessToken: "at-local",
          refreshToken: `rt-local-${env.DB_TYPE}`,
        };
        await Promise.all([
          mod.refreshProviderCredentials("claude", credentials, null),
          mod.refreshProviderCredentials("claude", credentials, null),
        ]);
        assert.equal(harness.upstream.rotations, 1, `${env.DB_TYPE}: local lock still dedupes in-process`);
        assert.equal(harness.redis.calls.set, 0, `${env.DB_TYPE}: no Redis lock in the unchanged path`);
      });
    } finally {
      delete globalThis.__refreshOwnershipTestDeps;
      harness.restore();
    }
  }
});
