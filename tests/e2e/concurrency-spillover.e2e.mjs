#!/usr/bin/env node
// E2E: concurrency-slot spillover across provider accounts.
//
// Real boot of the .next-e2e build + real HTTP through /api/v1/chat/completions.
// The only fake is the *upstream* provider (a local HTTP server), which is exactly
// the boundary under test: 9router itself runs unmodified.
//
// Proves, with HTTP-level evidence:
//   (a) account A at max concurrency + B free  -> request spills to B (200 from B)
//   (b) every account at max concurrency       -> request queues, then hands off on release
//   (c) mixed: A busy + B model-locked         -> request queues on A, then 200 from A
//
// Requires a build containing the spillover fix:
//   NEXT_DIST_DIR=.next-e2e npx next build --webpack
// Run:
//   node tests/e2e/concurrency-spillover.e2e.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DIST_DIR = process.env.E2E_DIST_DIR || ".next-e2e";
const PREFIX = "e2eprobe";
const MODEL_NAME = "e2e-model";
const MODEL_REF = `${PREFIX}/${MODEL_NAME}`;
const LOCK_KEY = `modelLock_${MODEL_NAME}`;
const KEY_A = "sk-e2e-account-a";
const KEY_B = "sk-e2e-account-b";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(desc, fn, { timeoutMs = 10000, intervalMs = 40 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timeout after ${timeoutMs}ms waiting for ${desc}`);
    await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------------------
// Fake upstream provider (the boundary under test, not a 9router mock).
// Modes are per upstream API key: "ok" | "hold" | "429".
//   ok   -> 200 JSON immediately
//   hold -> send 200 headers, then keep the body open. 9router's non-stream path
//           awaits response.json(), so the provider concurrency slot stays held
//           until release. Holds are bounded well below the 60s connect timeout.
//   429  -> 429 whose message contains "no credentials" -> organic model lock.
// ---------------------------------------------------------------------------
function createFakeUpstream() {
  const modes = new Map();
  const holds = [];
  const seen = [];

  const payload = (key) => ({
    id: "chatcmpl-e2e",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: MODEL_NAME,
    choices: [{ index: 0, message: { role: "assistant", content: `served-by:${key}` }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });

  const writeOk = (res, key) => {
    const body = JSON.stringify(payload(key));
    // Held responses already flushed their headers; writeHead would throw there.
    if (!res.headersSent) {
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    }
    res.end(body);
  };

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const url = req.url || "/";

      if (url.startsWith("/__")) {
        const json = (code, obj) => {
          const body = JSON.stringify(obj);
          res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
          res.end(body);
        };
        if (url === "/__state") {
          return json(200, {
            holds: holds.length,
            heldKeys: holds.map((h) => h.key),
            seen,
            modes: Object.fromEntries(modes),
          });
        }
        if (url === "/__mode") {
          const { key, mode } = JSON.parse(raw || "{}");
          modes.set(key, mode);
          return json(200, { ok: true });
        }
        if (url === "/__release") {
          const released = holds.splice(0, holds.length);
          for (const h of released) writeOk(h.res, h.key);
          return json(200, { released: released.length });
        }
        return json(404, { error: "unknown control path" });
      }

      const key = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      let model = null;
      try { model = JSON.parse(raw || "{}")?.model ?? null; } catch {}
      seen.push({ key, model, path: url });

      const mode = modes.get(key) || "ok";
      if (mode === "429") {
        const body = JSON.stringify({ error: { message: "no credentials available for this provider account" } });
        res.writeHead(429, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
        return res.end(body);
      }
      if (mode === "hold") {
        // Headers first: this clears 9router's connect timeout while the body
        // stays open, so the slot is held by the pending body read.
        res.writeHead(200, { "content-type": "application/json" });
        res.flushHeaders?.();
        holds.push({ key, res });
        return;
      }
      writeOk(res, key);
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, modes, holds, seen }));
  });
}

// ---------------------------------------------------------------------------
// Boot / teardown
// ---------------------------------------------------------------------------
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-spillover-"));
let child = null;
let upstream = null;
let out = "";
const evidence = {};

function logOffset() { return out.length; }
function logSince(offset, needle) { return out.slice(offset).includes(needle); }

function serverTail(n = 30) {
  return out.split("\n").filter(Boolean).slice(-n).join("\n");
}

try {
  if (!fs.existsSync(path.join(REPO, DIST_DIR, "BUILD_ID"))) {
    throw new Error(`build ${DIST_DIR} missing — run: NEXT_DIST_DIR=${DIST_DIR} npx next build --webpack`);
  }

  const [appPort, upstreamPort] = [await freePort(), await freePort()];
  const base = `http://127.0.0.1:${appPort}`;

  // Deterministic CLI token: pre-seed identity files before boot.
  const RAW_ID = "e2e-spillover-machine-id";
  const CLI_SECRET = "b".repeat(64);
  fs.mkdirSync(path.join(dataDir, "auth"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "machine-id"), RAW_ID, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, "auth", "cli-secret"), CLI_SECRET, { mode: 0o600 });
  const CLI_TOKEN = crypto.createHash("sha256").update(RAW_ID + "9r-cli-auth" + CLI_SECRET).digest("hex").substring(0, 16);
  const cliHeaders = { "x-9r-cli-token": CLI_TOKEN, "content-type": "application/json" };

  upstream = await createFakeUpstream();
  const upstreamBase = `http://127.0.0.1:${upstream.port}`;

  child = spawn(process.execPath, ["custom-server.js"], {
    cwd: REPO,
    env: {
      ...process.env,
      PORT: String(appPort),
      NEXT_DIST_DIR: DIST_DIR,
      DATA_DIR: dataDir,
      LOG_LEVEL: "INFO",
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });

  await waitFor("9router health", async () => {
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch { return false; }
  }, { timeoutMs: 90000, intervalMs: 300 });

  // ---- seed: node -> 2 accounts (concurrency 1, queue 5s) -> api key --------
  const keyRes = await fetch(`${base}/api/keys`, {
    method: "POST", headers: cliHeaders, body: JSON.stringify({ name: "e2e-spillover" }),
  });
  assert.equal(keyRes.status, 201, `POST /api/keys -> ${keyRes.status}`);
  const apiKey = (await keyRes.json()).key;

  const nodeRes = await fetch(`${base}/api/provider-nodes`, {
    method: "POST",
    headers: cliHeaders,
    body: JSON.stringify({ name: PREFIX, prefix: PREFIX, apiType: "chat", baseUrl: `${upstreamBase}/v1` }),
  });
  assert.equal(nodeRes.status, 201, `POST /api/provider-nodes -> ${nodeRes.status}`);
  const nodeId = (await nodeRes.json()).node.id;

  const accounts = {};
  for (const [name, upstreamKey, priority] of [["acctA", KEY_A, 1], ["acctB", KEY_B, 2]]) {
    const r = await fetch(`${base}/api/providers`, {
      method: "POST",
      headers: cliHeaders,
      body: JSON.stringify({ provider: nodeId, apiKey: upstreamKey, name, priority }),
    });
    assert.equal(r.status, 201, `POST /api/providers(${name}) -> ${r.status}`);
    const id = (await r.json()).connection.id;
    const put = await fetch(`${base}/api/providers/${id}`, {
      method: "PUT",
      headers: cliHeaders,
      body: JSON.stringify({ concurrency: 1, queueTimeoutMs: 5000 }),
    });
    assert.equal(put.status, 200, `PUT limits(${name}) -> ${put.status}`);
    accounts[name] = id;
  }

  const listConnections = async () => {
    const r = await fetch(`${base}/api/providers`, { headers: { "x-9r-cli-token": CLI_TOKEN } });
    assert.equal(r.status, 200, `GET /api/providers -> ${r.status}`);
    return (await r.json()).connections || [];
  };
  const seeded = await listConnections();
  assert.equal(seeded.length, 2, "expected exactly 2 seeded accounts");
  for (const c of seeded) {
    assert.equal(c.concurrency, 1, `${c.name} concurrency`);
    assert.equal(c.queueTimeoutMs, 5000, `${c.name} queueTimeoutMs`);
  }
  evidence.seed = { node: nodeId, accounts, apiKeyPrefix: apiKey.slice(0, 12) };

  // ---- helpers -------------------------------------------------------------
  const setMode = async (key, mode) => {
    const r = await fetch(`${upstreamBase}/__mode`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, mode }),
    });
    assert.equal(r.status, 200, `__mode(${mode}) -> ${r.status}`);
  };
  const upstreamState = async () => (await fetch(`${upstreamBase}/__state`)).json();
  const releaseHolds = async () => {
    const r = await fetch(`${upstreamBase}/__release`, { method: "POST" });
    return (await r.json()).released;
  };

  const chat = async ({ timeoutMs = 30000 } = {}) => {
    const t0 = Date.now();
    const res = await fetch(`${base}/api/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
        "x-9router-basic-chat": "1",
      },
      body: JSON.stringify({ model: MODEL_REF, messages: [{ role: "user", content: "ping" }], stream: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return {
      status: res.status,
      providerName: res.headers.get("x-9router-provider-name"),
      provider: res.headers.get("x-9router-provider"),
      queueMs: res.headers.get("x-9router-queue-provider-ms"),
      content: json?.choices?.[0]?.message?.content ?? null,
      text,
      ms: Date.now() - t0,
    };
  };

  // ==== (a) A busy + B free -> spill to B ===================================
  {
    await setMode(KEY_A, "hold");
    await setMode(KEY_B, "ok");
    const off = logOffset();

    let aSettled = false;
    const heldA = chat().then((r) => { aSettled = true; return r; });
    await waitFor("account A to hold a request", async () => (await upstreamState()).holds >= 1);

    const spilled = await chat();
    evidence.spillToFree = {
      status: spilled.status,
      providerName: spilled.providerName,
      queueMs: spilled.queueMs,
      ms: spilled.ms,
      content: spilled.content,
      heldStillPending: !aSettled,
    };
    assert.equal(spilled.status, 200, `(a) spill response status (body: ${spilled.text.slice(0, 200)})`);
    assert.equal(spilled.providerName, "acctB", "(a) request must be served by the free account B");
    assert.ok(!spilled.queueMs, "(a) a free account must be used without queueing");
    assert.match(String(spilled.content), /served-by:sk-e2e-account-b/, "(a) body must come from B's upstream key");
    assert.equal(aSettled, false, "(a) the spill must complete while A is still busy");
    assert.ok(
      logSince(off, "acctA at max concurrency (1) → trying next account"),
      "(a) expected the spillover log line for acctA",
    );

    await releaseHolds();
    const a = await heldA;
    assert.equal(a.status, 200, "(a) the held request on A must complete after release");
    assert.equal(a.providerName, "acctA", "(a) held request must be served by A");
  }

  // ==== (b) all accounts busy -> queue, then hand off =======================
  {
    await setMode(KEY_A, "hold");
    await setMode(KEY_B, "hold");
    const off = logOffset();

    const heldA = chat();
    await waitFor("A hold", async () => (await upstreamState()).heldKeys.includes(KEY_A));
    const heldB = chat();
    await waitFor("B hold", async () => (await upstreamState()).heldKeys.includes(KEY_B));

    const queued = chat();
    await waitFor("queue log line", async () => logSince(off, "all 2 account(s) at max concurrency → waiting in queue on acctA"), { timeoutMs: 15000 });
    await sleep(300);
    // The queued request will acquire a freed slot and issue a *new* upstream
    // call, so both accounts must serve normally from here on.
    await setMode(KEY_A, "ok");
    await setMode(KEY_B, "ok");
    const released = await releaseHolds();
    assert.ok(released >= 2, `(b) expected >=2 held upstream responses, released ${released}`);

    const q = await queued;
    evidence.queueWhenAllBusy = {
      status: q.status,
      providerName: q.providerName,
      queueMs: q.queueMs,
      ms: q.ms,
      content: q.content,
    };
    assert.equal(q.status, 200, `(b) queued request status (body: ${q.text.slice(0, 200)})`);
    assert.ok(q.queueMs !== null && Number(q.queueMs) >= 100, `(b) expected a real queue wait, got ${q.queueMs}`);
    assert.equal(q.providerName, "acctA", "(b) handoff must land on the first queued account");
    assert.match(String(q.content), /served-by:sk-e2e-account-a/, "(b) body must come from A's upstream key");
    assert.ok(
      logSince(off, "acctA at max concurrency (1) → trying next account") &&
      logSince(off, "acctB at max concurrency (1) → trying next account"),
      "(b) both busy accounts must be probed before queueing",
    );

    const [a, b] = await Promise.all([heldA, heldB]);
    assert.equal(a.status, 200, "(b) held A request must complete");
    assert.equal(b.status, 200, "(b) held B request must complete");
  }

  // ==== (c) A busy + B model-locked -> queue on A, then 200 =================
  {
    await setMode(KEY_A, "hold");
    await setMode(KEY_B, "429");
    const off = logOffset();

    const heldA = chat();
    await waitFor("A hold", async () => (await upstreamState()).heldKeys.includes(KEY_A));

    // Organic lock: this request skips busy A, hits B's 429 ("no credentials"),
    // which locks modelLock_e2e-model on B, then queues on A and succeeds.
    const mixed = chat({ timeoutMs: 25000 });
    await waitFor("B model lock to be persisted", async () => {
      const conns = await listConnections();
      const b = conns.find((c) => c.id === accounts.acctB);
      const until = b?.[LOCK_KEY];
      return typeof until === "string" && new Date(until).getTime() > Date.now();
    }, { timeoutMs: 15000 });
    await waitFor("queue-on-A log line", async () => logSince(off, "all 1 account(s) at max concurrency → waiting in queue on acctA"), { timeoutMs: 15000 });

    const lockedConn = (await listConnections()).find((c) => c.id === accounts.acctB);
    evidence.modelLockedFallback = {
      bLockUntil: lockedConn?.[LOCK_KEY] ?? null,
      bLastError: lockedConn?.lastError ?? null,
    };

    await sleep(300);
    // Same as (b): the queued request re-issues upstream after acquiring the slot.
    await setMode(KEY_A, "ok");
    await releaseHolds();

    const m = await mixed;
    evidence.modelLockedFallback = {
      ...evidence.modelLockedFallback,
      status: m.status,
      providerName: m.providerName,
      queueMs: m.queueMs,
      ms: m.ms,
      content: m.content,
    };
    assert.equal(m.status, 200, `(c) mixed-case status (body: ${m.text.slice(0, 200)})`);
    assert.equal(m.providerName, "acctA", "(c) must queue on the busy account, not fail");
    assert.ok(m.queueMs !== null && Number(m.queueMs) >= 100, `(c) expected a real queue wait, got ${m.queueMs}`);
    assert.match(String(m.content), /served-by:sk-e2e-account-a/, "(c) body must come from A's upstream key");
    assert.ok(
      logSince(off, "acctA at max concurrency (1) → trying next account"),
      "(c) busy A must be probed before B",
    );
    assert.ok(
      logSince(off, `locked ${LOCK_KEY} for`),
      "(c) B's 429 must lock the model organically",
    );

    const a = await heldA;
    assert.equal(a.status, 200, "(c) held A request must complete after release");
  }

  evidence.logEvidence = out
    .split("\n")
    .filter((l) => l.includes("RATELIMIT") || l.includes("locked modelLock_"))
    .slice(-12);

  console.log("\n=== E2E concurrency-spillover: PASS ===");
  console.log(JSON.stringify(evidence, null, 2));
} catch (err) {
  console.error("\n=== E2E concurrency-spillover: FAIL ===");
  console.error(err?.stack || String(err));
  if (evidence && Object.keys(evidence).length) console.error(JSON.stringify(evidence, null, 2));
  console.error("--- server log tail ---");
  console.error(serverTail(40));
  process.exitCode = 1;
} finally {
  try { if (upstream) await fetch(`http://127.0.0.1:${upstream.port}/__release`, { method: "POST" }); } catch {}
  try { upstream?.server.close(); } catch {}
  try {
    if (child) {
      // subprocess.killed only reports that a signal was SENT, not that the
      // process exited — waiting on 'exit' is the only reliable liveness check.
      const exited = new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
        child.once("exit", () => resolve(true));
        setTimeout(() => resolve(false), 1200).unref?.();
      });
      child.kill("SIGTERM");
      if (!(await exited)) {
        child.kill("SIGKILL");
        await Promise.race([
          new Promise((r) => child.once("exit", r)),
          sleep(1500),
        ]);
      }
    }
  } catch {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
