// Task 6: version-checked critical cache. The committed SQLite dbVersion is the
// correctness arbiter; Pub/Sub is only a wake-up hint and can be lost on
// reconnect, so a cache must re-read the committed version before reuse.
//
// ponytail: single-value cache, one inflight load. Extend to multi-key shards
// only when a hot path shows contention on the inflight promise.

const DEFAULT_TTL_MS = 5000;

export async function readCommittedDbVersion(db) {
  if (!db || typeof db.get !== "function") return 0;
  try {
    const row = db.get("SELECT version FROM dbVersion WHERE id = 1");
    const n = Number(row?.version);
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function createVersionedCache({
  load,
  readVersion = readCommittedDbVersion,
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now,
} = {}) {
  if (typeof readVersion !== "function") throw new TypeError("readVersion is required");

  let state = { value: undefined, version: -1, expiresAt: 0, promise: null };

  function invalidate() {
    state = { value: undefined, version: -1, expiresAt: 0, promise: null };
  }

  async function get(db, overrideLoad) {
    const version = await readVersion(db);
    if (state.promise) return state.promise;

    if (
      state.value !== undefined
      && state.version === version
      && state.expiresAt > now()
    ) {
      return state.value;
    }

    const loader = typeof overrideLoad === "function" ? overrideLoad : load;
    if (typeof loader !== "function") throw new TypeError("load is required");
    const promise = Promise.resolve(loader())
      .then((value) => {
        state = { value, version, expiresAt: now() + ttlMs, promise: null };
        return value;
      });
    // Identity check: a settled earlier load must never clear a newer
    // in-flight promise a concurrent get() installed in the meantime.
    promise.finally(() => { if (state.promise === promise) state.promise = null; });
    state.promise = promise;
    return state.promise;
  }

  return { get, invalidate };
}
