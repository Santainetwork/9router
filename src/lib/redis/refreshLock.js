// Task 5: Redis refresh ownership lock. Unique owner token, atomic
// compare-and-delete release, bounded TTL/renewal, AbortSignal cancellation.
// Multicore mode never falls back to a local mutex: the Redis lock is the only
// arbiter, and losing it aborts persistence and forces a fresh credential read.
const DEFAULT_TTL_MS = 10_000;
const DEFAULT_RENEW_MS = 2_000;
const MAX_TTL_MS = 120_000;

const COMPARE_DELETE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end
`;

export const ReleaseResult = Object.freeze({
  RELEASED: "released",
  NOT_OWNER: "not_owner",
});

export function newOwnerToken() {
  return crypto.randomUUID();
}

export function refreshLockKey(namespace, connectionId) {
  return `${namespace}:refresh:${connectionId}`;
}

export function createRefreshLock({
  redis,
  key,
  ownerToken = newOwnerToken(),
  ttlMs = DEFAULT_TTL_MS,
  renewMs = DEFAULT_RENEW_MS,
  signal,
  now = Date.now,
} = {}) {
  if (!redis || typeof redis.set !== "function" || typeof redis.eval !== "function") {
    throw new TypeError("redis manager with set and eval is required");
  }
  if (!key || typeof key !== "string") throw new TypeError("lock key is required");
  if (!Number.isFinite(ttlMs) || ttlMs < 1 || ttlMs > MAX_TTL_MS) {
    throw new TypeError(`ttlMs must be 1..${MAX_TTL_MS}`);
  }
  const renewInterval = renewMs > 0 && renewMs < ttlMs ? renewMs : Math.max(1, Math.floor(ttlMs / 3));

  let locked = false;
  let renewTimer = null;
  let released = null;

  const handle = {
    acquire: null,
    release: null,
    renew: null,
    readLatest: null,
    wait: null,
    get locked() { return locked; },
    get ownerToken() { return ownerToken; },
  };

  async function acquire() {
    // SET key token NX PX ttl — atomic single-owner acquisition.
    const reply = await redis.set(key, ownerToken, { NX: true, PX: ttlMs });
    locked = reply === "OK";
    if (locked && signal) {
      if (signal.aborted) {
        await release();
        return handle;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      renewTimer = setInterval(() => { renew().catch(() => {}); }, renewInterval);
      renewTimer.unref?.();
    }
    return handle;
  }

  async function renew() {
    if (!locked) return;
    // Compare-and-swap renewal: only extend if we still own it.
    const ok = await redis.eval(
      `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end`,
      { keys: [key], arguments: [ownerToken, String(ttlMs)] },
    );
    if (Number(ok) !== 1) {
      locked = false;
      stopRenewal();
    }
  }

  function stopRenewal() {
    if (renewTimer) {
      clearInterval(renewTimer);
      renewTimer = null;
    }
  }

  async function release() {
    stopRenewal();
    if (signal) signal.removeEventListener("abort", onAbort);
    // Atomic compare-and-delete: only the current owner may delete.
    const deleted = await redis.eval(COMPARE_DELETE_SCRIPT, {
      keys: [key],
      arguments: [ownerToken],
    });
    const result = Number(deleted) === 1 ? ReleaseResult.RELEASED : ReleaseResult.NOT_OWNER;
    if (result === ReleaseResult.RELEASED) locked = false;
    return result;
  }

  function onAbort() {
    if (released) return released;
    released = (async () => {
      stopRenewal();
      await redis.eval(COMPARE_DELETE_SCRIPT, { keys: [key], arguments: [ownerToken] });
      locked = false;
      return { aborted: true };
    })();
  }

  async function readLatest(readFn) {
    if (!locked) return null;
    return await readFn();
  }

  async function wait() {
    if (released) return released;
    if (!signal) return { aborted: false };
    if (signal.aborted) return onAbort();
    return new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve(onAbort()), { once: true });
    });
  }

  handle.acquire = acquire;
  handle.release = release;
  handle.renew = renew;
  handle.readLatest = readLatest;
  handle.wait = wait;
  return handle;
}
