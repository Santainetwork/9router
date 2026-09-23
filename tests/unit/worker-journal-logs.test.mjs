import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readFileSync } from "node:fs";
import { register } from "node:module";

register(new URL("./helpers/alias-loader.mjs", import.meta.url));

delete globalThis._consoleLogBufferState;
const {
  createWorkerJournalCollector,
  startWorkerJournalCollector,
} = await import(`../../src/lib/workerJournalLogs.js?worker-logs=${Date.now()}`);
const {
  appendConsoleLogLine,
  clearConsoleLogs,
  getConsoleLogs,
  initConsoleLogCapture,
} = await import(`../../src/lib/consoleLogBuffer.js?worker-logs=${Date.now()}`);

const levels = ["log", "info", "warn", "error", "debug"];

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.killed = false;
  }

  kill() {
    this.killed = true;
    return true;
  }
}

class FakeProcess extends EventEmitter {}

function fakeTimers() {
  const scheduled = [];
  return {
    scheduled,
    setTimeoutImpl(fn, delay) {
      const timer = { fn, delay, cleared: false, unref() {} };
      scheduled.push(timer);
      return timer;
    },
    clearTimeoutImpl(timer) {
      timer.cleared = true;
    },
  };
}

function harness({ appendLine = () => {} } = {}) {
  const calls = [];
  const children = [];
  const timers = fakeTimers();
  const processImpl = new FakeProcess();
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  const collector = createWorkerJournalCollector({
    appendLine,
    spawnImpl,
    processImpl,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  collector.start();
  return { calls, children, collector, processImpl, timers };
}

function journalEntry(index, message, cursor) {
  return JSON.stringify({
    _SYSTEMD_UNIT: `9router-worker@${index}.service`,
    MESSAGE: message,
    __CURSOR: cursor,
  });
}

test("appendConsoleLogLine sanitizes, bounds, labels, and rings source lines", () => {
  clearConsoleLogs();
  assert.equal(appendConsoleLogLine({ source: "control", message: "\u001b[31mred\u001b[0m\u0007" }), true);
  assert.equal(appendConsoleLogLine({ source: "control", message: "[CONTROL] once" }), true);
  assert.equal(appendConsoleLogLine({ source: "worker", index: 1, message: "[WORKER-1] once" }), true);
  assert.equal(appendConsoleLogLine({ source: "worker", index: 1, message: "[WORKER-2] untrusted" }), true);
  assert.equal(appendConsoleLogLine({ source: "worker", index: 0, message: "bad" }), false);
  assert.deepEqual(getConsoleLogs(), [
    "[CONTROL] red",
    "[CONTROL] once",
    "[WORKER-1] once",
    "[WORKER-1] [WORKER-2] untrusted",
  ]);

  clearConsoleLogs();
  appendConsoleLogLine({ source: "worker", index: 8, message: "x".repeat(5000) });
  assert.equal(getConsoleLogs()[0].length, 4000);
  assert.ok(getConsoleLogs()[0].startsWith("[WORKER-8] "));

  clearConsoleLogs();
  for (let i = 0; i < 205; i++) {
    appendConsoleLogLine({ source: "control", message: `line-${i}` });
  }
  assert.equal(getConsoleLogs().length, 200);
  assert.equal(getConsoleLogs()[0], "[CONTROL] line-5");
  clearConsoleLogs();
});

test("initConsoleLogCapture labels local console output as CONTROL exactly once", () => {
  clearConsoleLogs();
  const originals = Object.fromEntries(levels.map((level) => [level, console[level]]));
  console.log = () => {};
  try {
    initConsoleLogCapture();
    console.log("[CONTROL] already");
    assert.deepEqual(getConsoleLogs(), ["[CONTROL] already"]);
  } finally {
    const state = globalThis._consoleLogBufferState;
    for (const level of levels) console[level] = state.originals[level] || originals[level];
    state.patched = false;
    clearConsoleLogs();
  }
});

test("collector parses split NDJSON, validates dynamic units, splits messages, and dedupes cursors", () => {
  clearConsoleLogs();
  const h = harness({ appendLine: appendConsoleLogLine });
  const child = h.children[0];
  const first = journalEntry(1, "\u001b[33mone\u001b[0m\n" + "x".repeat(5000), "c1");
  child.stdout.write(first.slice(0, 31));
  assert.deepEqual(getConsoleLogs(), []);
  child.stdout.write(`${first.slice(31)}\n`);
  child.stdout.write(`${first}\n`); // Same cursor: replay must be dropped.
  for (const index of [2, 3, 4, 5, 6, 7, 8]) {
    child.stdout.write(`${journalEntry(index, `worker-${index}`, `c${index}`)}\n`);
  }
  child.stdout.write(`${first}\n`); // Non-adjacent replay must also be dropped.
  child.stdout.write("not-json\n");
  child.stdout.write(`${JSON.stringify({ _SYSTEMD_UNIT: "9router-worker@9.service", MESSAGE: "bad", __CURSOR: "c9" })}\n`);
  child.stdout.write(`${JSON.stringify({ _SYSTEMD_UNIT: "9router.service", MESSAGE: "bad", __CURSOR: "c10" })}\n`);
  child.stdout.write(`${JSON.stringify({ _SYSTEMD_UNIT: "9router-worker@1.service", MESSAGE: 42, __CURSOR: "c11" })}\n`);

  const logs = getConsoleLogs();
  assert.equal(logs.length, 9);
  assert.equal(logs[0], "[WORKER-1] one");
  assert.equal(logs[1].length, 4000);
  assert.ok(logs[1].startsWith("[WORKER-1] "));
  assert.deepEqual(logs.slice(2), [2, 3, 4, 5, 6, 7, 8].map((i) => `[WORKER-${i}] worker-${i}`));

  child.emit("close", 1, null);
  const retry = h.timers.scheduled.at(-1);
  retry.fn();
  assert.deepEqual(h.calls[0], {
    command: "journalctl",
    args: [
      "--follow",
      "--output=json",
      ...Array.from({ length: 8 }, (_, i) => `--unit=9router-worker@${i + 1}.service`),
      "--lines=50",
    ],
    options: { shell: false, stdio: ["ignore", "pipe", "ignore"] },
  });
  assert.ok(h.calls[1].args.includes("--after-cursor=c8"));
  assert.ok(!h.calls[1].args.includes("--lines=50"));
  h.collector.stop();
  clearConsoleLogs();
});

test("a late close from an old journal child cannot replace its restarted child", () => {
  const h = harness();
  const first = h.children[0];
  first.emit("error", new Error("journal failed"));
  assert.equal(h.timers.scheduled.length, 1);

  h.timers.scheduled[0].fn();
  const restarted = h.children[1];
  assert.equal(h.collector.getChild(), restarted);

  first.emit("close", 1, null);
  assert.equal(h.collector.getChild(), restarted);
  assert.equal(h.timers.scheduled.length, 1);
  h.collector.stop();
});

test("child error is handled once and the failed child is terminated", () => {
  const h = harness();
  const child = h.children[0];
  child.emit("error", new Error("journal failed"));
  child.emit("close", 1, null);
  assert.equal(child.killed, true);
  assert.equal(h.timers.scheduled.length, 1);
  h.collector.stop();
});

test("collector serializes split chunks from different worker messages in arrival order", () => {
  const lines = [];
  const h = harness({ appendLine: (entry) => lines.push(entry) });
  const child = h.children[0];
  const first = `${journalEntry(1, "first", "c1")}\n`;
  const second = `${journalEntry(2, "second", "c2")}\n`;
  child.stdout.write(first.slice(0, 20));
  child.stdout.write(`${first.slice(20)}${second}`);
  assert.deepEqual(lines, [
    { source: "worker", index: 1, message: "first" },
    { source: "worker", index: 2, message: "second" },
  ]);
  h.collector.stop();
});

test("collector drops an oversized unterminated journal frame and resynchronizes", () => {
  const lines = [];
  const h = harness({ appendLine: (entry) => lines.push(entry) });
  const child = h.children[0];
  child.stdout.write("x".repeat(70000));
  child.stdout.write(`${journalEntry(5, "x".repeat(70000), "oversized-complete")}\n`);
  child.stdout.write(`${journalEntry(4, "recovered", "after-oversize")}\n`);
  assert.deepEqual(lines, [{ source: "worker", index: 4, message: "recovered" }]);
  h.collector.stop();
});

test("unexpected exits restart with 1s, 2s, 5s, then capped 10s backoff", () => {
  const diagnostics = [];
  const h = harness({ appendLine: (entry) => diagnostics.push(entry) });
  for (const expectedDelay of [1000, 2000, 5000, 10000, 10000]) {
    h.children.at(-1).emit("close", 1, null);
    const timer = h.timers.scheduled.at(-1);
    assert.equal(timer.delay, expectedDelay);
    timer.fn();
  }
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(diagnostics[0], { source: "control", message: "Worker log collector unavailable" });
  h.collector.stop();
});

test("SIGTERM stops child, clears retry work, and detaches signal listeners", () => {
  const h = harness();
  const child = h.children[0];
  assert.equal(h.processImpl.listenerCount("SIGTERM"), 1);
  assert.equal(h.processImpl.listenerCount("SIGINT"), 1);
  h.processImpl.emit("SIGTERM");
  assert.equal(child.killed, true);
  assert.equal(child.listenerCount("error"), 0);
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(h.processImpl.listenerCount("SIGTERM"), 0);
  assert.equal(h.processImpl.listenerCount("SIGINT"), 0);
  child.emit("close", 1, null);
  assert.equal(h.timers.scheduled.length, 0);

  const pending = harness();
  pending.children[0].emit("close", 1, null);
  const timer = pending.timers.scheduled[0];
  pending.collector.stop();
  assert.equal(timer.cleared, true);
});

test("clearConsoleLogs neither restarts nor replays queued or journal lines", async () => {
  clearConsoleLogs();
  const h = harness({ appendLine: appendConsoleLogLine });
  const batches = [];
  const emitter = globalThis._consoleLogBufferState.emitter;
  const onLines = (lines) => batches.push(...lines);
  emitter.on("lines", onLines);
  h.children[0].stdout.write(`${journalEntry(1, "before", "before") }\n`);
  assert.deepEqual(getConsoleLogs(), ["[WORKER-1] before"]);
  clearConsoleLogs();
  assert.deepEqual(getConsoleLogs(), []);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(batches, [], "clear must discard the pending pre-clear SSE batch");
  assert.equal(h.calls.length, 1);
  h.children[0].stdout.write(`${journalEntry(2, "after", "after")}\n`);
  assert.deepEqual(getConsoleLogs(), ["[WORKER-2] after"]);
  assert.equal(h.calls.length, 1);
  emitter.off("lines", onLines);
  h.collector.stop();
  clearConsoleLogs();
});

test("runtime guards skip API workers, builds, non-Linux, and non-systemd hosts", () => {
  const skipped = [
    { env: { WORKER_ROLE: "api" }, platform: "linux", systemdPresent: true },
    { env: { NEXT_PHASE: "phase-production-build" }, platform: "linux", systemdPresent: true },
    { env: {}, platform: "darwin", systemdPresent: true },
    { env: {}, platform: "linux", systemdPresent: false },
  ];
  for (const options of skipped) {
    let spawned = 0;
    const result = startWorkerJournalCollector({
      ...options,
      spawnImpl: () => { spawned++; return new FakeChild(); },
    });
    assert.equal(result, null);
    assert.equal(spawned, 0);
  }
});

test("startWorkerJournalCollector is singleton and fails open when journalctl is missing", () => {
  const processImpl = new FakeProcess();
  const diagnostics = [];
  let spawned = 0;
  const options = {
    env: {},
    platform: "linux",
    systemdPresent: true,
    processImpl,
    appendLine: (entry) => diagnostics.push(entry),
    spawnImpl: () => {
      spawned++;
      const error = new Error("missing");
      error.code = "ENOENT";
      throw error;
    },
  };
  const first = startWorkerJournalCollector(options);
  const second = startWorkerJournalCollector(options);
  assert.equal(first, second);
  assert.equal(spawned, 1);
  assert.deepEqual(diagnostics, [{ source: "control", message: "Worker log collector unavailable" }]);
  first.stop();
});

test("collector singleton survives module re-import", async () => {
  delete globalThis._workerJournalCollector;
  let spawned = 0;
  const options = {
    env: {},
    platform: "linux",
    systemdPresent: true,
    processImpl: new FakeProcess(),
    spawnImpl: () => { spawned++; return new FakeChild(); },
  };
  const firstModule = await import(`../../src/lib/workerJournalLogs.js?hmr-a=${Date.now()}`);
  const secondModule = await import(`../../src/lib/workerJournalLogs.js?hmr-b=${Date.now()}`);
  const first = firstModule.startWorkerJournalCollector(options);
  const second = secondModule.startWorkerJournalCollector(options);
  assert.equal(first, second);
  assert.equal(spawned, 1);
  first.stop();
  delete globalThis._workerJournalCollector;
});

test("instrumentation starts worker collection only after console capture", () => {
  const source = readFileSync(new URL("../../src/instrumentation.js", import.meta.url), "utf8");
  const capture = source.indexOf("initConsoleLogCapture()");
  const collect = source.indexOf("startWorkerJournalCollector()");
  assert.ok(capture >= 0 && collect > capture);
  assert.match(source, /if \(!isApiWorkerRole\(\) && !isBuildPhase\)/);
});

test("existing snapshot API and SSE keep string-array shape and arrival order", async () => {
  clearConsoleLogs();
  appendConsoleLogLine({ source: "control", message: "control" });
  appendConsoleLogLine({ source: "worker", index: 1, message: "one" });
  appendConsoleLogLine({ source: "worker", index: 2, message: "two" });
  appendConsoleLogLine({ source: "worker", index: 3, message: "three" });

  const snapshotRoute = await import(`../../src/app/api/translator/console-logs/route.js?worker-logs=${Date.now()}`);
  const snapshot = await (await snapshotRoute.GET()).json();
  assert.deepEqual(snapshot, {
    success: true,
    logs: ["[CONTROL] control", "[WORKER-1] one", "[WORKER-2] two", "[WORKER-3] three"],
  });

  const streamRoute = await import(`../../src/app/api/translator/console-logs/stream/route.js?worker-logs=${Date.now()}`);
  const abort = new AbortController();
  const response = await streamRoute.GET(new Request("http://localhost/api/translator/console-logs/stream", { signal: abort.signal }));
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  const event = JSON.parse(first.slice(6).trim());
  assert.equal(event.type, "init");
  assert.deepEqual(event.logs, snapshot.logs);
  abort.abort();
  await reader.cancel();
  clearConsoleLogs();
});
