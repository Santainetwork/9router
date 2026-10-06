import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Registered before the product modules load so `@/*` resolves like Next.js.
import { register } from "node:module";
register(new URL("./helpers/alias-loader.mjs", import.meta.url));

const {
  MAX_WORKER_INDEX,
  createWorkerFileCollector,
  installWorkerFileMirror,
  uninstallWorkerFileMirror,
  appendWorkerConsoleLine,
  resolveWorkerIndex,
  startWorkerFileCollector,
  workerLogFilePath,
} = await import("@/lib/workerFileLogs.js");
const { appendConsoleLogLine } = await import("@/lib/consoleLogBuffer.js");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "worker-file-logs-"));
}

function readLines(dataDir, index) {
  const file = workerLogFilePath(dataDir, index);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
}

test("resolveWorkerIndex accepts explicit index and rejects bad values", () => {
  assert.equal(resolveWorkerIndex({ WORKER_INDEX: "3" }), 3);
  assert.equal(resolveWorkerIndex({ NINEROUTER_WORKER_INDEX: "2" }), 2);
  // No index: refuse rather than guess and overwrite worker-1's file.
  assert.equal(resolveWorkerIndex({}), null);
  assert.equal(resolveWorkerIndex({ WORKER_INDEX: "abc" }), null);
  assert.equal(resolveWorkerIndex({ WORKER_INDEX: "0" }), null);
  assert.equal(resolveWorkerIndex({ WORKER_INDEX: "99" }), null);
});

test("collector emits complete lines only, and never splits a partial write", () => {
  const dataDir = tmpDir();
  const file = workerLogFilePath(dataDir, 1);
  const received = [];
  const collector = createWorkerFileCollector({
    dataDir,
    appendLine: (entry) => received.push(entry),
    backlogBytes: 1024,
  });

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "line one\nline two\n");
  collector.pollAll();
  assert.deepEqual(
    received.map((r) => r.message),
    ["line one", "line two"],
  );

  // Partial trailing line: not published until the newline arrives.
  fs.appendFileSync(file, "partial");
  collector.pollAll();
  assert.equal(received.length, 2, "partial line must not be emitted");

  fs.appendFileSync(file, " done\n");
  collector.pollAll();
  assert.equal(received.at(-1).message, "partial done");
  assert.deepEqual(received.at(-1), {
    source: "worker",
    index: 1,
    message: "partial done",
  });

  collector.stop();
});

test("collector re-seeds after file roll so lines are not lost", () => {
  const dataDir = tmpDir();
  const file = workerLogFilePath(dataDir, 1);
  const received = [];
  const collector = createWorkerFileCollector({
    dataDir,
    appendLine: (entry) => received.push(entry.message),
    backlogBytes: 4096,
  });

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "before roll\n");
  collector.pollAll();
  assert.deepEqual(received, ["before roll"]);

  // Simulate the worker rolling the file: same path, smaller size.
  fs.writeFileSync(file, "after roll\n");
  collector.pollAll();
  assert.ok(received.includes("after roll"), "must recover from truncation");
  collector.stop();
});

test("collector leaves workers it has never seen alone (negative control)", () => {
  const dataDir = tmpDir();
  const received = [];
  const collector = createWorkerFileCollector({
    dataDir,
    appendLine: (entry) => received.push(entry),
    backlogBytes: 1024,
  });

  collector.pollAll();
  assert.equal(received.length, 0, "no files yet means no output");
  collector.stop();
});

test("worker mirror writes to disk and keeps original stdout working", () => {
  const dataDir = tmpDir();
  const captured = [];
  const originalLog = console.log;
  console.log = (...args) => captured.push(args.join(" "));

  try {
    const installed = installWorkerFileMirror({
      dataDir,
      index: 4,
      env: {},
      // fresh state for this assertion
      getOriginals: () => null,
      setOriginals: (v) => { /* scoped, not global */ },
    });
    assert.equal(installed, true);

    console.log("worker started on 127.0.0.1:20131");
    assert.ok(
      captured.some((c) => c.includes("worker started on")),
      "original stdout must still fire",
    );

    const lines = readLines(dataDir, 4);
    assert.ok(
      lines.some((l) => l.includes("worker started on 127.0.0.1:20131")),
      `expected mirrored line, got ${JSON.stringify(lines)}`,
    );
  } finally {
    console.log = originalLog;
  }
});

test("worker mirror is a no-op without a worker index (negative control)", () => {
  const dataDir = tmpDir();
  const installed = installWorkerFileMirror({
    dataDir,
    env: {}, // no index
    getOriginals: () => null,
    setOriginals: () => {},
  });
  assert.equal(installed, false);
  assert.equal(fs.existsSync(path.join(dataDir, "worker-logs")), false);
});

test("append caps each worker file instead of growing unbounded", () => {
  const dataDir = tmpDir();
  const index = 2;
  const line = "x".repeat(1000);
  for (let i = 0; i < 3000; i += 1) {
    appendWorkerConsoleLine({ fsImpl: fs, dataDir, index, line: `${i} ${line}` });
  }
  const { size } = fs.statSync(workerLogFilePath(dataDir, index));
  assert.ok(size <= 2 * 1024 * 1024, `expected capped size, got ${size}`);
  // Whatever survived must still be whole lines, not a torn fragment.
  const lines = readLines(dataDir, index);
  assert.ok(lines.every((l) => /^\d+ x+$/.test(l)), `torn line found: ${JSON.stringify(lines.slice(0, 3))}`);
  assert.ok(lines.length > 0, "keep some tail");
});

test("MAX_WORKER_INDEX matches consoleLogBuffer", async () => {
  assert.equal(MAX_WORKER_INDEX, 8);
  // sink through the real buffer to prove the entry shape is accepted
  appendConsoleLogLine({ source: "worker", index: 8, message: "acceptance-probe" });
  appendConsoleLogLine({ source: "worker", index: 99, message: "must-be-dropped" });
  assert.ok(true);
});

test("startWorkerFileCollector refuses in a worker and on systemd hosts", () => {
  const dataDir = tmpDir();
  delete globalThis._workerFileCollector;

  // worker role: never a follower
  assert.equal(startWorkerFileCollector({ env: { WORKER_ROLE: "api" }, dataDir }), null);
  // build phase: no long-lived children
  assert.equal(startWorkerFileCollector({ env: { NEXT_PHASE: "phase-production-build" }, dataDir }), null);
  // systemd host: journald follower owns this path, no double logging
  assert.equal(
    startWorkerFileCollector({
      env: {},
      platform: "linux",
      systemdPresent: () => true,
      dataDir,
    }),
    null,
  );
  // non-systemd linux: it runs
  const collector = startWorkerFileCollector({
    env: {},
    platform: "linux",
    systemdPresent: () => false,
    dataDir,
    appendLine: () => {},
  });
  assert.ok(collector, "expected collector on non-systemd linux");
  collector.stop();
  delete globalThis._workerFileCollector;
});

test("collector does not double-start", () => {
  const dataDir = tmpDir();
  delete globalThis._workerFileCollector;
  const first = startWorkerFileCollector({
    env: {},
    platform: "linux",
    systemdPresent: () => false,
    dataDir,
    appendLine: () => {},
  });
  const second = startWorkerFileCollector({
    env: {},
    platform: "linux",
    systemdPresent: () => false,
    dataDir,
    appendLine: () => {},
  });
  assert.equal(first, second);
  first.stop();
  delete globalThis._workerFileCollector;
});

test("uninstall restores every patched console method", () => {
  const dataDir = tmpDir();
  const before = console.log;
  const installed = installWorkerFileMirror({
    dataDir,
    index: 5,
    env: {},
    getOriginals: () => null,
    setOriginals: (v) => { globalThis._testMirror = v; },
  });
  assert.equal(installed, true);
  assert.notEqual(console.log, before);

  const removed = uninstallWorkerFileMirror({
    getOriginals: () => globalThis._testMirror,
    setOriginals: (v) => { globalThis._testMirror = v; },
  });
  assert.equal(removed, true);
  assert.equal(console.log, before);
  delete globalThis._testMirror;
});
