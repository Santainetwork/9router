// Task 6: atomic Redis routing state. Selection keys are namespaced by scope,
// carry no credentials, and advance only among caller-supplied eligible IDs.
// Redis failure rejects; there is no local fallback in multicore.
import test from "node:test";
import assert from "node:assert/strict";

const { createRoutingState, ROUTING_ERROR } = await import("../../src/lib/redis/routingState.js");

// Minimal atomic Redis fake implementing GET/SET/EVAL over a Map.
function fakeRedis() {
  const store = new Map();
  const calls = { eval: [] };
  const redis = {
    store,
    calls,
    async eval(script, { keys, arguments: args }) {
      calls.eval.push([script, keys, args]);
      const key = keys[0];
      if (args.length > 1) {
        const n = Number(args[0]);
        const sticky = Number(args[1]);
        const raw = store.get(key) || "0:0";
        const sep = raw.indexOf(":");
        let cur = Number(raw.slice(0, sep)) || 0;
        let count = Number(raw.slice(sep + 1)) || 0;
        if (n <= 0) return 0;
        const idx = cur % n;
        count += 1;
        if (count >= sticky) { cur = (cur + 1) % n; count = 0; }
        store.set(key, `${cur}:${count}`);
        return idx;
      }
      // plain rotation script
      const n = Number(args[0]);
      const cur = Number(store.get(key) || "0") || 0;
      if (n <= 0) return 0;
      store.set(key, String((cur + 1) % n));
      return cur;
    },
  };
  return redis;
}

test("rotate advances atomically among eligible IDs and resets at end", async () => {
  const redis = fakeRedis();
  const state = createRoutingState({ redis, namespace: "9router:test" });
  const ids = ["a", "b", "c"];
  assert.equal(await state.rotate("provider:openai", ids), 0);
  assert.equal(await state.rotate("provider:openai", ids), 1);
  assert.equal(await state.rotate("provider:openai", ids), 2);
  assert.equal(await state.rotate("provider:openai", ids), 0);
});

test("sticky rotation holds the same index for stickyLimit selections", async () => {
  const redis = fakeRedis();
  const state = createRoutingState({ redis, namespace: "9router:test" });
  const ids = ["a", "b"];
  const picks = [];
  for (let i = 0; i < 6; i++) picks.push(await state.rotateSticky("combo:code", ids, 2));
  assert.deepEqual(picks, [0, 0, 1, 1, 0, 0]);
});

test("selection keys are namespaced and never contain eligible-ID values", async () => {
  const redis = fakeRedis();
  const state = createRoutingState({ redis, namespace: "tenant-x" });
  await state.rotate("scope:y", ["secret-id-1", "secret-id-2"]);
  assert.ok(redis.store.has("tenant-x:routing:scope:y"));
  const [, keys] = redis.calls.eval[0];
  assert.equal(keys[0], "tenant-x:routing:scope:y");
  for (const v of redis.store.values()) assert.doesNotMatch(v, /secret-id/);
});

test("single eligible ID returns 0 without incrementing into empty set", async () => {
  const redis = fakeRedis();
  const state = createRoutingState({ redis, namespace: "n" });
  assert.equal(await state.rotate("solo", ["only"]), 0);
});

test("Redis failure rejects with a typed error and never falls back locally", async () => {
  const redis = { eval: async () => { throw new Error("down"); } };
  const state = createRoutingState({ redis, namespace: "n" });
  await assert.rejects(state.rotate("scope", ["a", "b"]), (e) => e.code === ROUTING_ERROR.REDIS_UNAVAILABLE);
});
