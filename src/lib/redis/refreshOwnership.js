// Task 5 (P4): distributed OAuth refresh ownership for SQLite Redis multicore
// API workers. The local Map in open-sse/services/oauthCredentialManager.js is
// process-local, so two workers could rotate the same single-use refresh token
// concurrently. In multicore this module owns the critical section via
// createRefreshLock (unique owner token, bounded TTL/renewal, cancellation,
// read-after-lock). Outside multicore it returns null and the caller keeps its
// existing local mutex, so PostgreSQL and single-process SQLite are unchanged.
import { createRefreshLock, refreshLockKey } from "./refreshLock.js";
import { getDatabaseType, isSqliteMulticoreWorker } from "../db/driver.js";

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_RENEW_MS = 5_000;
// A non-owner waits for the owner's synchronous committed version instead of
// starting a second upstream rotation. Bounded so a dead owner cannot hang it.
const DEFAULT_POLL_MS = 50;
const DEFAULT_DEADLINE_MS = 5_000;

// Test seam: deps are only consulted when a test installs them.
let testDeps = null;
export function setRefreshOwnershipDeps(deps) { testDeps = deps; }
export function resetRefreshOwnershipDeps() { testDeps = null; }

function currentDeps() {
  return globalThis.__refreshOwnershipTestDeps ?? testDeps ?? {};
}

// SQLite Redis multicore only. isSqliteMulticoreWorker ignores the database
// type, so the DB_TYPE check keeps PostgreSQL (single-process or multicore) on
// its existing path.
export function shouldUseDistributedRefreshLock(env = process.env) {
  return getDatabaseType(env) === "sqlite" && isSqliteMulticoreWorker(env);
}

async function defaultReadLatest(connectionId) {
  if (!connectionId) return null;
  const { getProviderConnectionById } = await import("../db/repos/connectionsRepo.js");
  return getProviderConnectionById(connectionId);
}

function identityOf(credentials) {
  return credentials?.accessToken ?? credentials?.refreshToken ?? null;
}

// Read-after-lock for the non-owner: wait (bounded) until the committed row
// carries a credential that differs from what this caller started with. On
// deadline the freshest committed read is returned rather than null, so the
// caller still gets real database state instead of no credentials at all.
async function waitForCommitted({ readLatest, connectionId, credentials, pollMs, deadlineMs, signal }) {
  const before = identityOf(credentials);
  const startedAt = Date.now();
  let latest = null;
  for (;;) {
    if (signal?.aborted) return latest;
    latest = await readLatest(connectionId);
    if (latest && identityOf(latest) !== before) return latest;
    if (Date.now() - startedAt >= deadlineMs) return latest;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

// Returns null when this process is not a multicore API worker, so the caller
// runs its unchanged local path. Otherwise returns { owner, result, lockLost }:
// `result` is the refresh outcome for the owner, or the committed row observed
// after the lock for a non-owner (never a second upstream rotation).
export async function withDistributedRefreshOwnership({ key, connectionId, credentials, refreshFn, persistFn }) {
  if (!shouldUseDistributedRefreshLock()) return null;

  const deps = currentDeps();
  const manager = deps.redis ?? (await import("./client.js")).getRedisManager();
  const redis = typeof manager?.command === "function" ? await manager.command() : manager;
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const deadlineMs = deps.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const readLatest = deps.readLatest ?? defaultReadLatest;

  // createRefreshLock only renews when it has a signal, so an internal one is
  // always supplied: without it a refresh longer than the TTL would silently
  // lose the key while `locked` stayed true, and a second worker could rotate
  // the same single-use token. A caller signal still cancels the request.
  const controller = new AbortController();
  const callerSignal = credentials?.signal;
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  const signal = controller.signal;

  const lock = createRefreshLock({
    redis,
    key: refreshLockKey(deps.namespace ?? "oauth", connectionId || key),
    ttlMs: deps.ttlMs ?? DEFAULT_TTL_MS,
    renewMs: deps.renewMs ?? DEFAULT_RENEW_MS,
    signal,
  });
  await lock.acquire();

  if (!lock.locked) {
    return {
      owner: false,
      lockLost: false,
      result: await waitForCommitted({ readLatest, connectionId, credentials, pollMs, deadlineMs, signal }),
    };
  }

  try {
    // Read-after-lock: a previous owner may have already committed a rotation
    // while we waited. Reusing the committed credentials avoids a second
    // rotation of the same single-use refresh token.
    const committed = await readLatest(connectionId);
    if (committed && identityOf(committed) !== identityOf(credentials)) {
      return { owner: false, lockLost: false, alreadyCommitted: true, result: committed };
    }

    const result = await refreshFn();
    // Renewal is a compare-and-swap: locked=false means another owner took over,
    // so our rotation may be superseded. Discard it and force a fresh read
    // instead of persisting a stale token version.
    if (!lock.locked) {
      return {
        owner: false,
        lockLost: true,
        result: await waitForCommitted({ readLatest, connectionId, credentials, pollMs, deadlineMs, signal }),
      };
    }
    // Persist inside the critical section: once the lock is released a second
    // worker would acquire, readLatest would still show the pre-rotation
    // identity, and it would rotate the same single-use refresh token again.
    // persistFn errors fail the refresh but still release the lock below.
    if (persistFn) await persistFn(result);
    return { owner: true, lockLost: false, result };
  } finally {
    await lock.release();
  }
}
