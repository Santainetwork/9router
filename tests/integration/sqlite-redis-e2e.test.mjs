// Task 9 acceptance (native form): boot the real control + 2 real API-worker
// Node processes against a real Redis broker and a real SQLite file, then prove
// the mutation path end-to-end: readiness, encrypted sync mutation roundtrip,
// plaintext-free stream, and clean drain.
//
// Gated by E2E_REDIS_URL pointing at a disposable broker configured exactly
// like production (appendonly yes, appendfsync everysec, noeviction). Skipped
// when unset — no mock evidence is ever substituted.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "redis";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const url = process.env.E2E_REDIS_URL;
process.on("unhandledRejection", (e) => {
  process.stderr.write(`[e2e] UNHANDLED: ${e?.stack || e}\n`);
});
const run = url ? test : test.skip;

const BASE_PORT = 21300 + (process.pid % 500) * 8; // control=+0, workers=+4,+5

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(fn, { timeoutMs = 30_000, everyMs = 250, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { if (await fn()) return; } catch (e) { last = e; }
    await wait(everyMs);
  }
  throw new Error(`timeout waiting for ${label}${last ? `: ${last.message}` : ""}`);
}

async function httpOk(port, pathname) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { signal: AbortSignal.timeout(2000) });
  return res.status;
}

run("control + 2 API workers boot, pass readiness, and sync a mutation through the real stream", async () => {
  const work = mkdtempSync(path.join(tmpdir(), "9r-e2e-"));
  const queueKey = "b".repeat(64);
  const nsPrefix = `9router:e2e:${process.pid}`;
  const childEnv = {
    ...process.env,
    DATABASE_URL: "",
    DB_TYPE: "sqlite",
    SQLITE_MULTICORE: "redis",
    REDIS_URL: url,
    REDIS_KEY_PREFIX: nsPrefix,
    SQLITE_QUEUE_ENCRYPTION_KEY: queueKey,
    ENABLE_GO_HYBRID: "true",
    GO_LIMITER_PORT: "21399",
    DATA_DIR: work,
    NINEROUTER_SKIP_ENGINE: "1",
    NEXT_TELEMETRY_DISABLED: "1",
    NO_COLOR: "1",
  };

  const procs = [];
  const logDir = mkdtempSync(path.join(tmpdir(), "9r-e2e-logs-"));
  const spawnNode = (role, port) => {
    const logPath = path.join(logDir, `${role}-${port}.log`);
    const logFd = openSync(logPath, "a");
    const p = spawn(process.execPath, [path.join(REPO_ROOT, "custom-server.js")], {
      cwd: REPO_ROOT,
      env: {
        ...childEnv,
        WORKER_ROLE: role,
        API_WORKERS: "3",
        PORT: String(port),
        HOSTNAME: "127.0.0.1",
      },
      stdio: ["ignore", logFd, logFd],
    });
    p.on("exit", () => { try { closeSync(logFd); } catch {} });
    procs.push(p);
    return p;
  };

  // The preflight must accept this exact broker config before anything boots.
  const preflight = spawnSync(process.execPath, [path.join(REPO_ROOT, "custom-server.js"), "--check-config"], {
    cwd: REPO_ROOT, env: { ...childEnv, WORKER_ROLE: "control", API_WORKERS: "3" }, encoding: "utf8",
  });
  assert.equal(preflight.status, 0, `--check-config failed: ${preflight.stderr}`);

  const control = spawnNode("control", BASE_PORT);
  const w1 = spawnNode("api", BASE_PORT + 4);
  const w2 = spawnNode("api", BASE_PORT + 5);

  const cleanup = async () => {
    for (const p of procs) { try { p.kill("SIGTERM"); } catch {} }
    await wait(1500);
    for (const p of procs) { try { p.kill("SIGKILL"); } catch {} }
    const c = createClient({ url });
    await c.connect();
    try { for await (const k of c.scanIterator({ MATCH: `${nsPrefix}*` })) await c.del(k); } finally { await c.quit(); }
    rmSync(work, { recursive: true, force: true });
  };

  try {
    // 1. All three processes come up healthy on the Next runtime.
    await waitFor(async () => (await httpOk(BASE_PORT, "/api/health")) === 200, { label: "control /api/health" });
    await waitFor(async () => (await httpOk(BASE_PORT + 4, "/api/health")) === 200, { label: "worker1 /api/health" });
    await waitFor(async () => (await httpOk(BASE_PORT + 5, "/api/health")) === 200, { label: "worker2 /api/health" });

    // 2. The SQLite database file exists on real disk under DATA_DIR/db.
    await waitFor(() => existsSync(path.join(work, "db", "data.sqlite")), { label: "sqlite data file" });

    // 3. Enqueue a real sync mutation through the SAME namespace the control
    // writer consumes (REDIS_KEY_PREFIX), so the receipt comes back from the
    // real control process, not from anything this test owns.
    process.stderr.write("[e2e] step3: connecting redis\n");
    const { createMutationQueue } = await import("../../src/lib/db/sqliteMutationQueue.js");
    const command = createClient({ url, disableOfflineQueue: true });
    const blocking = command.duplicate();
    await Promise.all([command.connect(), blocking.connect()]);
    const manager = { command: async () => command, blocking: async () => blocking, dedicated: async () => blocking, release: async () => {} };
    const queue = createMutationQueue({ redis: manager, namespace: nsPrefix, maxQueued: 100, syncTimeoutMs: 10_000 });

    // 4. Sync mutation roundtrip: the control writer commits and answers.
    process.stderr.write(`[e2e] step4: enqueueing sync mutation ns=${nsPrefix}\n`);
    let result;
    try {
      result = await queue.enqueueMutation({
        type: "footerLog.add",
        payload: { provider: "e2e", model: "m", referralText: "e2e-probe" },
        consistency: "sync",
      });
    } catch (error) {
      process.stderr.write(`[e2e] step4 FAILED: ${error.stack}\n`);
      throw error;
    }
    assert.ok(result?.enqueued === true, "sync mutation must be acknowledged");

    // 5. Nothing plaintext-leaks into Redis: scan every key this namespace wrote.
    // node-redis v6 scanIterator yields a BATCH (array) of keys, not one key per
    // iteration like v4, so flatten each yield before use.
    let leaked = 0;
    const seen = new Set();
    for await (const batch of command.scanIterator({ MATCH: `${nsPrefix}*` })) {
      for (const key of [].concat(batch)) {
        if (seen.has(key)) continue;
        seen.add(key);
      const type = await command.type(key);
      let sample = "";
      if (type === "string") sample = String(await command.get(key) ?? "");
      else if (type === "list") { const items = await command.lRange(key, 0, 4); sample = items.join(" "); }
      else if (type === "stream") { const entries = await command.xRange(key, "-", "+", { COUNT: 20 }); sample = entries.map((e) => JSON.stringify(e.message)).join(" "); }
      const isLeak = sample.includes("SQLITE_QUEUE_ENCRYPTION_KEY") || sample.includes("b".repeat(64)) || (/accessToken|refreshToken|apiKey/.test(sample) && !sample.includes("ciphertext"));
      if (isLeak) leaked++;
      }
    }
    assert.equal(leaked, 0, `plaintext leak in Redis under ${nsPrefix}*`);
    await command.quit();
    await blocking.quit();

    // 6. Graceful drain of all three real processes.
    for (const p of procs) p.kill("SIGTERM");
    await waitFor(() => Promise.all(procs.map(async (p) => {
      try { process.kill(p.pid, 0); return false; } catch { return true; }
    })).then((arr) => arr.every(Boolean)), { timeoutMs: 45_000, label: "process drain" });
  } finally {
    await cleanup();
  }
}, { timeout: 180_000 });
