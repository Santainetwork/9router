#!/usr/bin/env node
// soak-queue-leases.mjs
// Queue/lease soak-and-stress harness for the 9Router hybrid engine.
// Dependency-free Node >=22 (uses stdlib fetch, AbortController, readline).
// Exercises the Go master gateway + limiter, then gates on concurrency/queue
// leaks after the load settles.
//
// ponytail: heuristic only (sampling, /proc RSS, p95/p99 via sort). No
// causal proof of leaks; reports are signals for a human to interpret.

import { readFileSync, readdirSync } from 'node:fs';

const HELP = `soak-queue-leases.mjs — queue/lease soak-and-stress harness for 9Router

USAGE
  node scripts/soak-queue-leases.mjs [flags]

FLAGS
  --help                print this help and exit 0
  --dry-run             validate config, print the plan, make only read-only
                        GET calls, generate no load, exit 0
  --reset               OPT-IN: POST /v1/limiter/reset before load
  --phases=a,b,c        comma list: abort,queue,saturation (default abort,queue,saturation)

ENV
  SOAK_BASE_URL         gateway base   (default http://127.0.0.1:20128)
  SOAK_LIMITER_URL      limiter base   (default http://127.0.0.1:20129)
  SOAK_API_KEY          API key for chat tests; chat phase SKIPPED if unset
  SOAK_MODEL            model          (default auto)
  SOAK_CONCURRENCY      workers        (default 6)
  SOAK_DURATION_S       phase seconds  (default 60)
  SOAK_ABORT_RATE       abort fraction (default 0.35)
  SOAK_QUEUE_TARGET     queue depth    (default: detected concurrency + 4)
  SOAK_ALLOW_RESET      must be "1" for --reset to take effect

EXIT CODES
  0  no leak (or chat phase skipped because SOAK_API_KEY unset)
  1  leak detected
  2  config error
`;

const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:20128',
  limiterUrl: 'http://127.0.0.1:20129',
  model: 'auto',
  concurrency: 6,
  durationS: 60,
  abortRate: 0.35,
  queueTarget: null,
  phases: 'abort,queue,saturation',
};

// ---------------- helpers ----------------

const log = (...a) => console.error(...a);

function progress(pct, msg) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  console.log(`JCODE_PROGRESS ${JSON.stringify({ percent: p, message: msg })}`);
}

function parseArgs(argv) {
  const opts = {
    help: false,
    dryRun: false,
    reset: false,
    phases: null,
  };
  for (const a of argv) {
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--reset') opts.reset = true;
    else if (a.startsWith('--phases=')) opts.phases = a.slice('--phases='.length);
    else throw new Error(`unknown flag: ${a}`);
  }
  return opts;
}

function loadConfig(argv) {
  const opts = parseArgs(argv);
  if (opts.help) return { help: true };

  const num = (v, d, name, min, max) => {
    if (v === undefined || v === '') return d;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`env ${name} is not a number: ${v}`);
    if (min !== undefined && n < min) throw new Error(`env ${name} below min ${min}: ${n}`);
    if (max !== undefined && n > max) throw new Error(`env ${name} above max ${max}: ${n}`);
    return n;
  };

  const abortRate = num(process.env.SOAK_ABORT_RATE, DEFAULTS.abortRate, 'SOAK_ABORT_RATE', 0, 1);

  const phasesRaw = opts.phases ?? process.env.SOAK_PHASES ?? DEFAULTS.phases;
  const valid = new Set(['abort', 'queue', 'saturation']);
  const phases = [];
  for (const p of phasesRaw.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!valid.has(p)) throw new Error(`unknown phase: ${p}`);
    if (!phases.includes(p)) phases.push(p);
  }
  if (phases.length === 0) throw new Error('no phases selected');

  const queueTargetEnv = process.env.SOAK_QUEUE_TARGET;
  const queueTarget = queueTargetEnv ? num(queueTargetEnv, null, 'SOAK_QUEUE_TARGET', 1) : null;

  return {
    help: false,
    dryRun: opts.dryRun,
    reset: opts.reset,
    phases,
    apiKey: process.env.SOAK_API_KEY ?? process.env.NINEROUTER_TEST_API_KEY ?? process.env.TEST_API_KEY ?? '',
    baseUrl: process.env.SOAK_BASE_URL ?? DEFAULTS.baseUrl,
    limiterUrl: process.env.SOAK_LIMITER_URL ?? DEFAULTS.limiterUrl,
    model: process.env.SOAK_MODEL ?? DEFAULTS.model,
    concurrency: num(process.env.SOAK_CONCURRENCY, DEFAULTS.concurrency, 'SOAK_CONCURRENCY', 1, 1024),
    durationS: num(process.env.SOAK_DURATION_S, DEFAULTS.durationS, 'SOAK_DURATION_S', 1, 86400),
    abortRate,
    queueTarget,
    allowReset: process.env.SOAK_ALLOW_RESET === '1',
  };
}

async function postJSON(url, body, timeoutMs = 3000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    return { status: res.status, data: parsed };
  } finally {
    clearTimeout(t);
  }
}

async function getJSON(url, timeoutMs = 3000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    const body = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error(`non-JSON response (HTTP ${res.status}): ${body.slice(0, 200)}`);
    }
    return { status: res.status, data: parsed };
  } finally {
    clearTimeout(t);
  }
}

async function snapshot() {
  const { status, data } = await getJSON(`${cfg.limiterUrl}/v1/limiter/snapshot`);
  if (status !== 200) throw new Error(`snapshot HTTP ${status}`);
  return data;
}

function sumBucketActive(snap) {
  return (snap.buckets ?? []).reduce((s, b) => s + (b.activeConcurrency ?? 0), 0);
}

async function baseline() {
  const snap = await snapshot();
  return {
    totalActive: snap.totalActiveConcurrent ?? 0,
    totalQueued: snap.totalQueued ?? 0,
    bucketActive: sumBucketActive(snap),
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------- chat request ----------------

// Fire one streaming chat request. Mode 'abort' cancels after 1..5 SSE chunks,
// mode 'full' reads to completion. Returns a result record; never throws.
async function oneChat(mode, nonce, maxTokens = 32) {
  const startedAt = Date.now();
  let aborted = false;
  let errored = false;
  let status = 0;
  let chunks = 0;
  let bytes = 0;

  const body = JSON.stringify({
    model: cfg.model,
    stream: true,
    messages: [
      { role: 'user', content: `soak nonce ${nonce}. Reply with one short sentence.` },
    ],
    max_tokens: maxTokens,
  });

  const ctl = new AbortController();
  try {
    const res = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: ctl.signal,
    });
    status = res.status;

    if (!res.ok || !res.body) {
      // Consume/drain the body so the socket does not leak.
      try {
        await res.arrayBuffer();
      } catch {}
      return { startedAt, status, chunks, bytes, aborted: false, errored: status >= 500, error: `HTTP ${status}` };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const abortAfter = 1 + Math.floor(Math.random() * 5); // 1..5 chunks
    let done = false;

    while (!done) {
      const { value, done: rd } = await reader.read();
      if (rd) break;
      bytes += value.length;
      buf += decoder.decode(value, { stream: true });
      // Count complete SSE events ("data: ...\n\n" or "[DONE]").
      let idx;
      while ((idx = buf.search(/\n\n|\r\n\r\n/)) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + (buf[idx] === '\r' ? 4 : 2));
        const line = frame.split(/\r?\n/).find((l) => l.startsWith('data:'));
        if (line) {
          chunks++;
          if (mode === 'abort' && chunks >= abortAfter) {
            aborted = true;
            done = true;
            break;
          }
        }
      }
    }

    if (aborted) {
      ctl.abort();
      try {
        await reader.cancel();
      } catch {}
    } else {
      try {
        await reader.cancel();
      } catch {}
    }
  } catch (e) {
    errored = true;
    if (e.name === 'AbortError') {
      aborted = true;
    } else {
      errored = true;
      aborted = false;
    }
    // Best-effort: AbortController already cancels fetch on abort.
  }

  const latency = Date.now() - startedAt;
  return { startedAt, latency, status, chunks, bytes, aborted, errored, error: errored ? 'network/stream error' : undefined };
}

// ---------------- phase drivers ----------------

// PHASE abort: fire `concurrency` workers in a loop until duration elapses.
async function phaseAbort() {
  log(`\n=== PHASE abort ===  workers=${cfg.concurrency} duration=${cfg.durationS}s abortRate=${cfg.abortRate}`);
  const deadline = Date.now() + cfg.durationS * 1000;
  const workers = cfg.concurrency;
  let done = false;

  const counter = {
    started: 0,
    completed: 0,
    aborted: 0,
    errored: 0,
    statusClasses: {},
  };
  const latencies = [];

  async function worker() {
    while (!done) {
      const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
      const mode = Math.random() < cfg.abortRate ? 'abort' : 'full';
      counter.started++;
      const r = await oneChat(mode, nonce);
      const cls = Math.floor(r.status / 100) * 100;
      counter.statusClasses[cls] = (counter.statusClasses[cls] ?? 0) + 1;
      if (r.errored) counter.errored++;
      else if (r.aborted) counter.aborted++;
      else if (r.status >= 200 && r.status < 300) {
        counter.completed++;
        if (!r.aborted) latencies.push(r.latency);
      } else if (r.status === 429) {
        counter.completed++; // acceptable, expected queue outcome
      }
    }
  }

  const workerPromises = [];
  for (let i = 0; i < workers; i++) workerPromises.push(worker());

  while (Date.now() < deadline) {
    await sleep(500);
    progress((Date.now() - (deadline - cfg.durationS * 1000)) / (cfg.durationS * 1000) * 100, `abort phase: ${counter.started} started`);
  }
  done = true;
  await Promise.all(workerPromises);

  return { counter, latencies };
}

// PHASE queue: exceed per-key concurrency so waiters queue; sample snapshot.
async function phaseQueue() {
  log(`\n=== PHASE queue ===`);
  // Detect the limit from bucket-detail for the raw key.
  let limit = null;
  try {
    const { status, data } = await getJSON(
      `${cfg.limiterUrl}/v1/limiter/bucket-detail?scope=apikey&key=${encodeURIComponent(cfg.apiKey)}`,
    );
    if (status === 200 && data && Number.isFinite(data.concurrency) && data.concurrency > 0) {
      limit = data.concurrency;
    }
  } catch {
    // fall through to target
  }
  const target = limit ? limit + 4 : (cfg.queueTarget ?? cfg.concurrency + 4);
  const fireCount = target;
  log(`  detected limit=${limit ?? 'n/a'}  firing=${fireCount} in-flight requests`);

  const deadline = Date.now() + cfg.durationS * 1000;
  let done = false;
  let maxTotalQueued = 0;
  let maxBucketQueued = 0;
  let started = 0;
  let completed = 0;
  let errored = 0;
  let got429 = 0;
  let other = 0;

  const reqs = [];
  for (let i = 0; i < fireCount; i++) {
    reqs.push(
      oneChat('full', `queue-${Date.now()}-${i}-${Math.random().toString(36).slice(2)}`, 64).then((r) => {
        if (r.errored) errored++;
        else if (r.status === 429) got429++;
        else if (r.status >= 200 && r.status < 300) completed++;
        else other++;
        return r;
      }),
    );
    started++;
  }

  const sampler = (async () => {
    while (!done) {
      await sleep(500);
      try {
        const snap = await snapshot();
        const tq = snap.totalQueued ?? 0;
        let bq = 0;
        for (const b of snap.buckets ?? []) {
          // Only count the apikey bucket for our key (snapshot reports sha256).
          // We track the max per-bucket queued across all buckets; label clearly.
          bq = Math.max(bq, b.queued ?? 0);
        }
        maxTotalQueued = Math.max(maxTotalQueued, tq);
        maxBucketQueued = Math.max(maxBucketQueued, bq);
      } catch {
        // sampler failure is non-fatal
      }
    }
  })();

  while (Date.now() < deadline) {
    await sleep(500);
  }
  done = true;
  await Promise.all(reqs);
  await sampler;

  return { fireCount, started, completed, errored, got429, other, maxTotalQueued, maxBucketQueued };
}

// PHASE saturation: hold long-lived streaming requests open, sample every 500ms.
async function phaseSaturation() {
  log(`\n=== PHASE saturation ===  holding=${cfg.concurrency} open streams`);
  const deadline = Date.now() + cfg.durationS * 1000;
  let peakTotalActive = 0;
  let peakBucketActive = 0;
  let exceeded = false;
  let done = false;

  // Long-lived requests: use a larger max_tokens so upstream streams longer.
  const held = [];
  for (let i = 0; i < cfg.concurrency; i++) {
    held.push(holdOpen(`sat-${Date.now()}-${i}`));
  }

  const sampler = (async () => {
    while (!done) {
      await sleep(500);
      try {
        const snap = await snapshot();
        peakTotalActive = Math.max(peakTotalActive, snap.totalActiveConcurrent ?? 0);
        const buckets = snap.buckets ?? [];
        peakBucketActive = Math.max(peakBucketActive, sumBucketActive(snap));
        for (const b of buckets) {
          if ((b.activeConcurrency ?? 0) > (b.concurrency ?? 0)) {
            exceeded = true;
          }
        }
      } catch {
        // non-fatal
      }
    }
  })();

  while (Date.now() < deadline) {
    await sleep(500);
    try {
      const snap = await snapshot();
      progress(((Date.now() - (deadline - cfg.durationS * 1000)) / (cfg.durationS * 1000)) * 100, `saturation: active=${snap.totalActiveConcurrent}`);
    } catch {}
  }
  done = true;
  const results = await Promise.all(held);
  await sampler;

  return { peakTotalActive, peakBucketActive, exceeded, completed: results.filter((r) => !r.errored).length, errored: results.filter((r) => r.errored).length };
}

// Hold a request open for the full phase duration (no mid-stream abort).
async function holdOpen(nonce) {
  const ctl = new AbortController();
  try {
    const res = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: cfg.model,
        stream: true,
        messages: [{ role: 'user', content: `soak nonce ${nonce}. Keep talking, long answer please.` }],
        max_tokens: 512,
      }),
      signal: ctl.signal,
    });
    if (!res.ok || !res.body) {
      try { await res.arrayBuffer(); } catch {}
      return { errored: res.status >= 500, status: res.status };
    }
    // We must not read to completion immediately: hold it open.
    // Sample-read slowly so the stream stays alive for the phase duration.
    const reader = res.body.getReader();
    const stopAt = Date.now() + cfg.durationS * 1000;
    try {
      while (Date.now() < stopAt) {
        const { value, done } = await reader.read();
        if (done) break;
        void value;
        await sleep(300);
      }
    } catch {}
    try { await reader.cancel(); } catch {}
    return { errored: false, status: res.status };
  } catch {
    return { errored: true, status: 0 };
  }
}

// ---------------- settle / leak gate ----------------

async function settle(baseline, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const snap = await snapshot();
      last = snap;
      const activeOk = (snap.totalActiveConcurrent ?? 0) <= baseline.totalActive;
      const queuedOk = (snap.totalQueued ?? 0) <= baseline.totalQueued;
      if (activeOk && queuedOk) return { snap, settled: true };
    } catch {}
    await sleep(1000);
  }
  return { snap: last, settled: false };
}

function leakVerdict(baseline, final) {
  const buckets = final?.buckets ?? [];
  const offenders = [];
  let activeAbove = ((final?.totalActiveConcurrent ?? 0) > baseline.totalActive);
  let queuedNonZero = ((final?.totalQueued ?? 0) > baseline.totalQueued);
  let bucketOver = false;
  for (const b of buckets) {
    if ((b.activeConcurrency ?? 0) > (b.concurrency ?? 0)) {
      bucketOver = true;
      offenders.push(`bucket ${b.scope}:${b.key} active=${b.activeConcurrency} > concurrency=${b.concurrency}`);
    }
  }
  if (activeAbove) offenders.push(`totalActiveConcurrent=${final.totalActiveConcurrent} > baseline=${baseline.totalActive}`);
  if (queuedNonZero) offenders.push(`totalQueued=${final.totalQueued} > baseline=${baseline.totalQueued}`);
  const leak = activeAbove || queuedNonZero || bucketOver;
  return { leak, offenders, activeAbove, queuedNonZero, bucketOver };
}

// ---------------- /proc RSS ----------------

function readRss(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
    if (!m) return null;
    return Number(m[1]) * 1024; // bytes
  } catch {
    return null;
  }
}

function findPidsByComm(pattern) {
  const out = [];
  let entries;
  try {
    entries = readdirSync('/proc');
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    try {
      const comm = readFileSync(`/proc/${e}/comm`, 'utf8').trim();
      if (pattern.test(comm)) out.push({ pid: Number(e), comm });
    } catch {}
  }
  return out;
}

function measureRss() {
  // Heuristic: router-engine (Go) and next-server (Node) comm names.
  const engine = findPidsByComm(/router-engine/);
  const next = findPidsByComm(/next-server/);
  const out = {};
  if (engine.length) out.routerEngineRssBytes = Math.max(...engine.map((p) => readRss(p.pid) ?? 0));
  if (next.length) out.nextServerRssBytes = Math.max(...next.map((p) => readRss(p.pid) ?? 0));
  return out;
}

function fmtBytes(b) {
  if (b == null) return 'n/a';
  const mib = b / (1024 * 1024);
  return `${mib.toFixed(1)} MiB`;
}

function percentile(sorted, q) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[i];
}

// ---------------- main ----------------

let cfg;

async function readOnlyChecks() {
  // For --dry-run: only GET calls.
  const results = {};
  try {
    const h = await getJSON(`${cfg.limiterUrl}/health`);
    results.limiterHealth = h.data;
  } catch (e) {
    results.limiterHealth = { error: String(e.message) };
  }
  try {
    const s = await getJSON(`${cfg.limiterUrl}/v1/limiter/snapshot`);
    results.snapshot = s.data;
  } catch (e) {
    results.snapshot = { error: String(e.message) };
  }
  try {
    const b = await getJSON(`${cfg.baseUrl}/api/health`);
    results.backendHealth = b.data;
  } catch (e) {
    results.backendHealth = { error: String(e.message) };
  }
  if (cfg.apiKey) {
    try {
      const d = await getJSON(`${cfg.limiterUrl}/v1/limiter/bucket-detail?scope=apikey&key=${encodeURIComponent(cfg.apiKey)}`);
      results.bucketDetail = d.data;
    } catch (e) {
      results.bucketDetail = { error: String(e.message) };
    }
  }
  return results;
}

async function main() {
  cfg = loadConfig(process.argv.slice(2));
  if (cfg.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  if (cfg.reset && !cfg.allowReset) {
    log('ERROR: --reset requires SOAK_ALLOW_RESET=1 (refusing to wipe live counters)');
    process.exit(2);
  }

  const rssPre = measureRss();

  if (cfg.dryRun) {
    log('=== DRY RUN (no load, read-only GET only) ===');
    log(`baseUrl=${cfg.baseUrl}`);
    log(`limiterUrl=${cfg.limiterUrl}`);
    log(`model=${cfg.model}`);
    log(`concurrency=${cfg.concurrency}`);
    log(`durationS=${cfg.durationS}`);
    log(`abortRate=${cfg.abortRate}`);
    log(`phases=${cfg.phases.join(',')}`);
    log(`apiKey=${cfg.apiKey ? 'present' : 'UNSET -> chat phase SKIPPED'}`);
    log(`reset=${cfg.reset} (allowed=${cfg.allowReset})`);
    log(`queueTarget=${cfg.queueTarget ?? 'auto (detected concurrency + 4)'}`);

    const checks = await readOnlyChecks();
    log(`limiter health: ${JSON.stringify(checks.limiterHealth)}`);
    log(`backend health: ${JSON.stringify(checks.backendHealth)}`);
    log(`snapshot: totalActive=${checks.snapshot.totalActiveConcurrent ?? '?'} totalQueued=${checks.snapshot.totalQueued ?? '?'} buckets=${checks.snapshot.totalBuckets ?? '?'}`);
    if (cfg.apiKey) {
      const bd = checks.bucketDetail;
      log(`bucket-detail(apikey): concurrency=${bd.concurrency ?? 'n/a'} active=${bd.activeConcurrency ?? 'n/a'} queued=${bd.queued ?? 'n/a'} rpm=${bd.rpm ?? 'n/a'}`);
    }
    log(`RSS (heuristic): router-engine=${fmtBytes(rssPre.routerEngineRssBytes)} next-server=${fmtBytes(rssPre.nextServerRssBytes)}`);
    log('\n=== PLAN ===');
    for (const p of cfg.phases) {
      log(`  - phase ${p}`);
    }
    log('  - settle (poll snapshot until baseline, 90s deadline)');
    log('  - leak gate + summary + JSON verdict');
    log('\nDRY RUN OK');
    process.exit(0);
  }

  if (!cfg.apiKey) {
    log('SKIPPED: SOAK_API_KEY unset. Chat phases require a real key; no load generated.');
    log('Set SOAK_API_KEY (or NINEROUTER_TEST_API_KEY / TEST_API_KEY) to run the soak.');
    log('SKIPPED BANNER — exit 0');
    progress(100, 'skipped: SOAK_API_KEY unset');
    process.exit(0);
  }

  // Baseline (settle first, no reset by default).
  log('=== BASELINE ===');
  log('  waiting 3s settle before baseline (no reset)');
  await sleep(3000);

  if (cfg.reset) {
    const { status, data } = await postJSON(`${cfg.limiterUrl}/v1/limiter/reset`, { all: true });
    if (status !== 200) {
      log(`ERROR: limiter reset failed with HTTP ${status}: ${JSON.stringify(data)}`);
      process.exit(2);
    }
    log(`  RESET cleared=${data.cleared} (opt-in --reset, SOAK_ALLOW_RESET=1)`);
  }

  const base = await baseline();
  log(`  baseline: totalActive=${base.totalActive} totalQueued=${base.totalQueued} bucketActive=${base.bucketActive}`);

  const phaseResults = {};
  const allLatencies = [];

  for (const p of cfg.phases) {
    if (p === 'abort') {
      const r = await phaseAbort();
      phaseResults.abort = r;
      allLatencies.push(...r.latencies);
      log(`  abort: started=${r.counter.started} completed=${r.counter.completed} aborted=${r.counter.aborted} errored=${r.counter.errored} statusClasses=${JSON.stringify(r.counter.statusClasses)}`);
    } else if (p === 'queue') {
      const r = await phaseQueue();
      phaseResults.queue = r;
      log(`  queue: fired=${r.fireCount} completed=${r.completed} errored=${r.errored} got429=${r.got429} other=${r.other} maxTotalQueued=${r.maxTotalQueued} maxBucketQueued=${r.maxBucketQueued}`);
    } else if (p === 'saturation') {
      const r = await phaseSaturation();
      phaseResults.saturation = r;
      log(`  saturation: peakTotalActive=${r.peakTotalActive} peakBucketActive=${r.peakBucketActive} exceeded=${r.exceeded} completed=${r.completed} errored=${r.errored}`);
    }
  }

  progress(85, 'settling for leak gate');
  const settleRes = await settle(base, 90000);
  const rssPost = measureRss();

  // Leak gate
  const verdict = leakVerdict(base, settleRes.snap);
  const sortedLat = allLatencies.slice().sort((a, b) => a - b);
  const p95 = percentile(sortedLat, 0.95);
  const p99 = percentile(sortedLat, 0.99);

  // Summary table
  log('\n=== SUMMARY ===');
  log(`baseline             totalActive=${base.totalActive} totalQueued=${base.totalQueued}`);
  if (phaseResults.abort) log(`phase abort          started=${phaseResults.abort.counter.started} completed=${phaseResults.abort.counter.completed} aborted=${phaseResults.abort.counter.aborted} errored=${phaseResults.abort.counter.errored}`);
  if (phaseResults.queue) log(`phase queue          fired=${phaseResults.queue.fireCount} completed=${phaseResults.queue.completed} 429=${phaseResults.queue.got429} maxTotalQueued=${phaseResults.queue.maxTotalQueued} maxBucketQueued=${phaseResults.queue.maxBucketQueued}`);
  if (phaseResults.saturation) log(`phase saturation     peakTotalActive=${phaseResults.saturation.peakTotalActive} peakBucketActive=${phaseResults.saturation.peakBucketActive} exceeded=${phaseResults.saturation.exceeded}`);
  log(`settle               settled=${settleRes.settled} finalTotalActive=${settleRes.snap?.totalActiveConcurrent ?? 'n/a'} finalTotalQueued=${settleRes.snap?.totalQueued ?? 'n/a'}`);
  log(`latency (heuristic)  p95=${p95 ?? 'n/a'}ms p99=${p99 ?? 'n/a'}ms n=${sortedLat.length}`);
  log(`RSS (heuristic)      router-engine=${fmtBytes(rssPost.routerEngineRssBytes)} (pre ${fmtBytes(rssPre.routerEngineRssBytes)})  next-server=${fmtBytes(rssPost.nextServerRssBytes)} (pre ${fmtBytes(rssPre.nextServerRssBytes)})`);

  log(`\nVERDICT: ${verdict.leak ? 'LEAK' : 'NO-LEAK'}`);
  if (verdict.leak) {
    for (const o of verdict.offenders) log(`  LEAK: ${o}`);
  }

  const jsonOut = {
    verdict: verdict.leak ? 'LEAK' : 'NO-LEAK',
    baseline: base,
    settled: settleRes.settled,
    final: {
      totalActive: settleRes.snap?.totalActiveConcurrent ?? null,
      totalQueued: settleRes.snap?.totalQueued ?? null,
    },
    offenders: verdict.offenders,
    phases: phaseResults,
    latency: { p95, p99, n: sortedLat.length },
    rss: { routerEngine: rssPost.routerEngineRssBytes ?? null, nextServer: rssPost.nextServerRssBytes ?? null },
  };
  console.log(`SOAK_RESULT ${JSON.stringify(jsonOut)}`);

  process.exit(verdict.leak ? 1 : 0);
}

main().catch((e) => {
  log(`FATAL: ${e.stack ?? e}`);
  process.exit(2);
});
