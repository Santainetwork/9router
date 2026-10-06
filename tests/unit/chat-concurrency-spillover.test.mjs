// Regression: provider-connection concurrency spillover in src/sse/handlers/chat.js.
//
// The provider-scope acquire() in chat.js probes each candidate connection with
// timeoutMs=0 while another connection may still have a free concurrency slot.
// A connection whose slot is full must spill over to the next account instead
// of queueing on the busy one. When *every* account is busy (or the remaining
// ones are model-locked for the requested model) the request must queue on a
// busy account and succeed once a slot frees — never 429/503.
//
// These tests drive the REAL handleChat + REAL open-sse/services/rateLimiter.js
// through helpers/chat-spillover-loader.mjs (registered after
// helpers/alias-loader.mjs, which it layers on top of). The loader stubs the
// upstream chatCore and records the connectionId each attempt was served with.
//
// Scenarios:
//   (a) busy A + free B        -> 200 served by B, no wait on A (fails pre-fix)
//   (b) A and B both full      -> request queues, succeeds after a slot frees
//   (c) busy A + model-locked B -> request queues on A, succeeds after release
//   (d) RPM-blocked A + free B -> request queues on A (preservation test: the
//       fix's RPM branch must NOT be treated as concurrency-full)
//   (e) busy A + RPM-blocked B  -> request still queues on A. This is the mixed
//       case where the RPM branch must un-exclude the busy account it already
//       skipped; without that, A stays excluded and the request 503s.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("./helpers/alias-loader.mjs", import.meta.url));
register(new URL("./helpers/chat-spillover-loader.mjs", import.meta.url));

const { handleChat } = await import("../../src/sse/handlers/chat.js");
const { acquire, _reset, _stats } = await import("open-sse/services/rateLimiter.js");
const { buildModelLockUpdate } = await import("open-sse/services/accountFallback.js");

const PROVIDER = "openai";
const MODEL_ID = "gpt-4o-mini";
const REQUEST_MODEL = `${PROVIDER}/${MODEL_ID}`;
const QUEUE_TIMEOUT_MS = 5000;
// Pre-fix, a request with A busy would wait out QUEUE_TIMEOUT_MS on A and then
// fail with 429. The spill path resolves in tens of milliseconds; this bound is
// generous for CI while still far below the queue timeout.
const MAX_SPILL_MS = 1500;
const PENDING = Symbol("still-pending");

function makeConn(id, overrides = {}) {
  return {
    id,
    provider: PROVIDER,
    name: id,
    displayName: id,
    isActive: true,
    apiKey: `sk-${id}`,
    accessToken: `tok-${id}`,
    rpm: 0,
    concurrency: 1,
    queueTimeoutMs: QUEUE_TIMEOUT_MS,
    providerSpecificData: {},
    ...overrides,
  };
}

function setFixtures(connections) {
  _reset();
  globalThis.__TEST_SETTINGS__ = { requireApiKey: false };
  globalThis.__TEST_CONNS__ = connections;
  globalThis.__TEST_CORE_CALLS__ = [];
}

function resetFixtures() {
  _reset();
  globalThis.__TEST_CONNS__ = [];
  globalThis.__TEST_CORE_CALLS__ = [];
}

function makeRequest(signal) {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: REQUEST_MODEL,
      messages: [{ role: "user", content: "hi" }],
    }),
    signal,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Race a request against a short timer. Resolves PENDING while the request is
// still queued; resolves with the request's outcome object otherwise so a
// fast 429/503 can be reported by the assertion instead of throwing.
function racePending(promise, ms) {
  let timer;
  const timerPromise = new Promise((resolve) => {
    timer = setTimeout(() => resolve(PENDING), ms);
  });
  const observed = promise.then(
    (res) => ({ settled: "fulfilled", res }),
    (err) => ({ settled: "rejected", err }),
  );
  return Promise.race([observed, timerPromise]).finally(() => clearTimeout(timer));
}

function withTimeout(promise, ms, label) {
  let timer;
  const timerPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
  });
  return Promise.race([promise, timerPromise]).finally(() => clearTimeout(timer));
}

async function waitFor(predicate, label, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

function assertStillPending(early) {
  if (early === PENDING) return;
  const detail = early?.settled === "rejected"
    ? `rejected with ${early.err?.name || "Error"}: ${early.err?.message}`
    : `settled with status=${early?.res?.status}`;
  assert.fail(
    `request ${detail} while no slot was free; it must queue instead of failing fast (429/503)`,
  );
}

// Bounded cleanup so a failed assertion cannot leak a still-queued request
// into the next test.
async function settleQuietly(promise, ms = 500) {
  if (!promise) return;
  await Promise.race([promise.then(() => {}, () => {}), sleep(ms)]);
}

test("(a) busy A + free B: request spills to B immediately instead of queueing on A", async () => {
  setFixtures([makeConn("conn-A"), makeConn("conn-B")]);
  let relA = null;
  try {
    // A's single concurrency slot is held by a real lease.
    relA = await acquire("provider", "conn-A", { rpm: 0, concurrency: 1, timeoutMs: 0 });
    assert.equal(_stats("provider", "conn-A").activeConcurrency, 1);

    const startedAt = Date.now();
    const res = await handleChat(makeRequest());
    const elapsed = Date.now() - startedAt;

    // The request must succeed via the free account, not wait on busy A.
    assert.equal(res.status, 200, "request must succeed via the free account B");
    assert.notEqual(res.status, 429);
    assert.notEqual(res.status, 503);
    assert.ok(
      elapsed < MAX_SPILL_MS,
      `spillover must not wait on busy A (elapsed=${elapsed}ms, queueTimeout=${QUEUE_TIMEOUT_MS}ms)`,
    );

    const calls = globalThis.__TEST_CORE_CALLS__;
    assert.equal(calls.length, 1, "exactly one upstream attempt");
    assert.equal(calls[0].connectionId, "conn-B", "upstream must be served by the free connection B");

    assert.equal(_stats("provider", "conn-A").queued, 0, "nothing may queue on busy A");
    assert.equal(_stats("provider", "conn-B").activeConcurrency, 1, "B's real limiter slot was granted");
  } finally {
    try { relA?.(); } catch {}
    resetFixtures();
  }
});

test("(b) all accounts at max concurrency: request queues, then succeeds when a slot frees", async () => {
  setFixtures([makeConn("conn-A"), makeConn("conn-B")]);
  const ac = new AbortController();
  let relA = null;
  let relB = null;
  let reqPromise = null;
  try {
    relA = await acquire("provider", "conn-A", { rpm: 0, concurrency: 1, timeoutMs: 0 });
    relB = await acquire("provider", "conn-B", { rpm: 0, concurrency: 1, timeoutMs: 0 });

    reqPromise = handleChat(makeRequest(ac.signal));

    // With both slots busy the request must stay pending (queue), not fail fast.
    const early = await racePending(reqPromise, 200);
    assertStillPending(early);
    await waitFor(
      () => _stats("provider", "conn-A").queued === 1,
      "the request to appear as a waiter on conn-A",
    );

    // Free A; the queued request must take the handoff and succeed.
    await sleep(100);
    relA();
    relA = null;

    const res = await withTimeout(reqPromise, 2000, "queued request after slot release");
    assert.equal(res.status, 200, "queued request must succeed once a slot frees");
    assert.notEqual(res.status, 429);
    assert.notEqual(res.status, 503);

    const calls = globalThis.__TEST_CORE_CALLS__;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].connectionId, "conn-A", "the queue handoff must dispatch on A");
    assert.equal(_stats("provider", "conn-A").queued, 0, "waiter must be dequeued after the grant");
  } finally {
    ac.abort();
    try { relA?.(); } catch {}
    try { relB?.(); } catch {}
    await settleQuietly(reqPromise);
    resetFixtures();
  }
});

test("(c) busy A + model-locked B: request queues on A and succeeds when A frees", async () => {
  // B is free at the limiter level but locked for this model (real flat
  // modelLock_${model} shape), so A is the only candidate and it is full.
  const lock = buildModelLockUpdate(MODEL_ID, 60_000);
  setFixtures([makeConn("conn-A"), makeConn("conn-B", lock)]);
  const ac = new AbortController();
  let relA = null;
  let reqPromise = null;
  try {
    relA = await acquire("provider", "conn-A", { rpm: 0, concurrency: 1, timeoutMs: 0 });

    reqPromise = handleChat(makeRequest(ac.signal));

    // Must not fail with 429/503 even though the only non-busy account is locked.
    const early = await racePending(reqPromise, 200);
    assertStillPending(early);
    await waitFor(
      () => _stats("provider", "conn-A").queued === 1,
      "the request to queue on busy conn-A",
    );

    await sleep(100);
    relA();
    relA = null;

    const res = await withTimeout(reqPromise, 2000, "queued request after slot release");
    assert.equal(res.status, 200, "request must succeed on A after its slot frees");
    assert.notEqual(res.status, 429);
    assert.notEqual(res.status, 503);

    const calls = globalThis.__TEST_CORE_CALLS__;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].connectionId, "conn-A", "model-locked B must not serve the request");
    assert.equal(_stats("provider", "conn-A").queued, 0, "waiter must be dequeued after the grant");
    assert.equal(
      _stats("provider", "conn-B")?.activeConcurrency ?? 0,
      0,
      "model-locked B must never take a limiter slot",
    );
  } finally {
    ac.abort();
    try { relA?.(); } catch {}
    await settleQuietly(reqPromise);
    resetFixtures();
  }
});

// (d) PRESERVATION test: passes both pre- and post-fix. Its job is to pin the
// fix's RPM branch — when RPM (not concurrency) blocks the priority account, the
// request must still wait in that account's queue instead of spilling to the
// next account. Removing the RPM branch makes (d) fail: A would be pushed onto
// concurrencyFullCandidates, excluded, and the request would dispatch on B.
test("(d) RPM-blocked A + free B: request queues on A instead of spilling", async () => {
  setFixtures([makeConn("conn-A", { rpm: 1 }), makeConn("conn-B")]);
  const ac = new AbortController();
  let reqPromise = null;
  try {
    // Burn A's only RPM slot for this 60s window. Concurrency stays free, so the
    // probe's immediate acquire fails on RPM and not on the concurrency slot.
    await acquire("provider", "conn-A", { rpm: 1, concurrency: 0, timeoutMs: 0 });
    assert.equal(_stats("provider", "conn-A").count, 1, "A's RPM window must be exhausted");
    assert.equal(_stats("provider", "conn-A").activeConcurrency, 0, "no concurrency slot held");

    reqPromise = handleChat(makeRequest(ac.signal));

    // Must not fail fast and must not be dispatched to B: RPM is not a
    // concurrency block, so the request waits in A's queue (previous behavior).
    const early = await racePending(reqPromise, 200);
    assertStillPending(early);
    await waitFor(
      () => _stats("provider", "conn-A").queued === 1,
      "the request to queue on RPM-blocked conn-A",
    );

    assert.equal(globalThis.__TEST_CORE_CALLS__.length, 0, "no upstream attempt may run yet");
    // B was never touched, so its bucket may not exist at all.
    assert.equal(_stats("provider", "conn-B")?.queued ?? 0, 0, "free B must not receive the request");
    assert.equal(_stats("provider", "conn-B")?.activeConcurrency ?? 0, 0, "B must not take a limiter slot");
  } finally {
    ac.abort();
    await settleQuietly(reqPromise);
    resetFixtures();
  }
});

// (e) Mixed case: A is concurrency-full (already pushed onto
// concurrencyFullCandidates and excluded), then B is reached and turns out to be
// RPM-blocked. The RPM branch must un-exclude A so the request queues on it —
// the loop that re-admits skipped accounts is only reachable here.
test("(e) busy A + RPM-blocked B: request queues on A, not 503", async () => {
  setFixtures([makeConn("conn-A"), makeConn("conn-B", { rpm: 1, concurrency: 0 })]);
  const ac = new AbortController();
  let relA = null;
  let reqPromise = null;
  try {
    // Burn B's only RPM slot for the window; keep A's single slot held.
    await acquire("provider", "conn-B", { rpm: 1, concurrency: 0, timeoutMs: 0 });
    relA = await acquire("provider", "conn-A", { rpm: 0, concurrency: 1, timeoutMs: 0 });

    reqPromise = handleChat(makeRequest(ac.signal));

    // Must queue (on A) rather than fail: A was skipped for concurrency, B is
    // RPM-blocked, and the request must not be dispatched anywhere yet.
    const early = await racePending(reqPromise, 200);
    assertStillPending(early);
    await waitFor(
      () => _stats("provider", "conn-A").queued === 1,
      "the request to queue on conn-A after the RPM branch re-admits it",
    );
    assert.equal(globalThis.__TEST_CORE_CALLS__.length, 0, "no upstream attempt may run yet");
    assert.equal(_stats("provider", "conn-B")?.queued ?? 0, 0, "RPM-blocked B must not receive the queue");

    // Free A: the queued request must take the handoff and succeed on A.
    await sleep(100);
    relA();
    relA = null;

    const res = await withTimeout(reqPromise, 2000, "queued request after slot release");
    assert.equal(res.status, 200, "mixed case must succeed on A, not 503");
    assert.notEqual(res.status, 503);
    const calls = globalThis.__TEST_CORE_CALLS__;
    assert.equal(calls.length, 1, "exactly one upstream attempt");
    assert.equal(calls[0].connectionId, "conn-A", "the queue handoff must dispatch on A");
  } finally {
    ac.abort();
    try { relA?.(); } catch {}
    await settleQuietly(reqPromise);
    resetFixtures();
  }
});
