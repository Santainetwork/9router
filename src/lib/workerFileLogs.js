// File-based log bridge for API workers in containerized runtimes (Docker) where
// systemd journald does not exist, so `workerJournalLogs.js` never runs.
//
// Two halves, one file each:
//   • worker side  — installWorkerFileMirror() mirrors this process's console.*
//                   lines into `$DATA_DIR/worker-logs/worker-<index>.log`.
//   • control side — createWorkerFileCollector() tails those files and feeds
//                   appendConsoleLogLine(), so `/dashboard/console-log` shows
//                   [WORKER-N] lines exactly like the native systemd topology.
//
// Only the control process tails files; only API workers write them. Both guard
// on that, so the two halves can never both write the same path.
//
// `docker logs` keeps working: mirroring is additive, the worker still writes
// its own stdout. The cost is that a worker dying before Next.js instrumentation
// runs has no file line for that crash, only container output.
import fs from "node:fs";
import path from "node:path";
import { isApiWorkerRole } from "@/shared/utils/engineConfig.js";
import { appendConsoleLogLine } from "@/lib/consoleLogBuffer.js";
import { getDataDir } from "@/lib/dataDir.js";

const BUILD_PHASES = new Set(["phase-production-build", "phase-export", "phase-static"]);

// Matches MAX_WORKER_INDEX in consoleLogBuffer.js and WORKER_MAX in
// scripts/systemd-worker-topology.sh / custom-server.js MAX_API_WORKERS.
export const MAX_WORKER_INDEX = 8;
export const POLL_INTERVAL_MS = 1000;
// A line with no newline is held in memory until its terminator arrives. Cap
// it the same way the journald follower does, so one pathological worker
// statement cannot grow the control process without bound.
const MAX_PENDING_CHARS = 65536;
// Per-file ceiling. The dashboard ring is CONSOLE_LOG_CONFIG.maxLines = 200, so a
// window this large is far more than the UI can ever show; it exists so a worker
// running for weeks does not fill the data volume.
const MAX_WORKER_LOG_BYTES = 2 * 1024 * 1024;
const KEEP_BYTES_ON_ROLL = 512 * 1024;

export function workerLogFilePath(dataDir, index) {
  return path.join(dataDir, "worker-logs", `worker-${index}.log`);
}

// Resolves the worker index from the environment. Container orchestration passes
// it explicitly; a worker started without it has no way to know which instance
// it is, so it must refuse rather than invent an index and write worker-1's file.
export function resolveWorkerIndex(env = process.env) {
  const raw = env.NINEROUTER_WORKER_INDEX ?? env.WORKER_INDEX;
  const index = Number.parseInt(raw, 10);
  if (!Number.isInteger(index) || index < 1 || index > MAX_WORKER_INDEX) return null;
  return index;
}

function writeAll(fsImpl, fd, text) {
  const buffer = Buffer.from(text, "utf8");
  let written = 0;
  while (written < buffer.length) {
    written += fsImpl.writeSync(fd, buffer, written, buffer.length - written);
  }
}

// Keeps the file bounded. On roll, the tail that survives is whatever ended with
// a newline, so the control-side reader never sees a torn first line.
function rollIfOversized(fsImpl, filePath, stat) {
  if (stat.size < MAX_WORKER_LOG_BYTES) return;
  const readFd = fsImpl.openSync(filePath, "r");
  try {
    const size = stat.size;
    const start = Math.max(0, size - KEEP_BYTES_ON_ROLL);
    const length = Math.min(size, KEEP_BYTES_ON_ROLL);
    const buffer = Buffer.alloc(length);
    const read = fsImpl.readSync(readFd, buffer, 0, length, start);
    // Align both ends to newline boundaries: the slice starts mid-line, so skip
    // to the first newline; then trim the tail back to the last complete line.
    let begin = buffer.subarray(0, read).indexOf(0x0a);
    if (begin === -1) return;
    begin += 1;
    let end = read;
    while (end > begin && buffer[end - 1] !== 0x0a) end -= 1;
    if (end <= begin) return;
    const writeFd = fsImpl.openSync(filePath, "r+");
    try {
      writeAll(fsImpl, writeFd, buffer.subarray(begin, end).toString("utf8"));
      fsImpl.ftruncateSync(writeFd, end - begin);
    } finally {
      fsImpl.closeSync(writeFd);
    }
  } finally {
    fsImpl.closeSync(readFd);
  }
}

export function appendWorkerConsoleLine({
  fsImpl = fs,
  dataDir,
  index,
  line,
}) {
  const filePath = workerLogFilePath(dataDir, index);
  try {
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
    const fd = fsImpl.openSync(filePath, "a");
    try {
      writeAll(fsImpl, fd, `${line}\n`);
      rollIfOversized(fsImpl, filePath, fsImpl.fstatSync(fd));
    } finally {
      fsImpl.closeSync(fd);
    }
    return true;
  } catch {
    // Never let an auxiliary log file take down a request-serving worker.
    return false;
  }
}

const consoleLevels = ["log", "info", "warn", "error", "debug"];

// Mirrors console.* into the worker's own file. Runs in the API worker process.
// Idempotent: a second call is a no-op, and stop() restores the originals.
export function installWorkerFileMirror({
  fsImpl = fs,
  dataDir,
  env = process.env,
  index = resolveWorkerIndex(env),
  getOriginals = () => globalThis._workerFileMirrorOriginals,
  setOriginals = (value) => { globalThis._workerFileMirrorOriginals = value; },
} = {}) {
  if (index === null) return false;
  if (getOriginals()) return false;

  const originals = {};
  const patched = (level) => (...args) => {
    const text = args
      .map((arg) => {
        if (typeof arg === "string") return arg;
        if (arg instanceof Error) return arg.stack || arg.message || String(arg);
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      })
      .join(" ");
    if (text) appendWorkerConsoleLine({ fsImpl, dataDir, index, line: text });
    originals[level](...args);
  };

  for (const level of consoleLevels) {
    originals[level] = console[level];
    console[level] = patched(level);
  }
  setOriginals(originals);
  return true;
}

export function uninstallWorkerFileMirror({
  getOriginals = () => globalThis._workerFileMirrorOriginals,
  setOriginals = (value) => { globalThis._workerFileMirrorOriginals = value; },
} = {}) {
  const originals = getOriginals();
  if (!originals) return false;
  for (const level of consoleLevels) {
    console[level] = originals[level];
  }
  setOriginals(null);
  return true;
}

// Control-side tailer. Byte offsets plus a per-worker pending buffer: a line is
// only published once its terminating newline has been read, so a partially
// flushed worker line is neither lost nor split.
export function createWorkerFileCollector({
  appendLine,
  fsImpl = fs,
  dataDir,
  maxWorkers = MAX_WORKER_INDEX,
  // Seed the first read with the tail of an existing file, mirroring the
  // journald follower's JOURNAL_BACKLOG_LINES. Fresh worker starts from 0.
  backlogBytes = 64 * 1024,
} = {}) {
  if (typeof appendLine !== "function") {
    throw new Error("createWorkerFileCollector requires appendLine");
  }

  const offsets = new Map();
  const pending = new Map();
  let timer = null;

  const consume = (index, chunk) => {
    if (!chunk) return;
    let text = (pending.get(index) ?? "") + chunk;
    if (!text.includes("\n") && text.length > MAX_PENDING_CHARS) {
      // Unterminated garbage, not a slow line. Drop it rather than buffer it.
      pending.set(index, "");
      return;
    }
    let newline = text.indexOf("\n");
    while (newline !== -1) {
      const line = newline <= MAX_PENDING_CHARS ? text.slice(0, newline).replace(/\r$/, "").trim() : "";
      if (line) appendLine({ source: "worker", index, message: line });
      text = text.slice(newline + 1);
      newline = text.indexOf("\n");
    }
    pending.set(index, text.length > MAX_PENDING_CHARS ? "" : text);
  };

  const pollWorker = (index) => {
    const filePath = workerLogFilePath(dataDir, index);
    let stat;
    try {
      stat = fsImpl.statSync(filePath);
    } catch {
      return; // worker not started yet, or removed on shutdown
    }

    let offset = offsets.get(index);
    if (offset === undefined) {
      offset = Math.max(0, stat.size - backlogBytes);
      offsets.set(index, offset);
    }
    if (stat.size < offset) {
      // Rolled/truncated under us. Re-seed then re-read the tail; duplicate lines
      // are acceptable because the UI ring is bounded and already lossy.
      offset = Math.max(0, stat.size - backlogBytes);
      offsets.set(index, offset);
      pending.set(index, "");
    }
    if (stat.size === offset) return;

    const length = Math.min(stat.size - offset, backlogBytes);
    const buffer = Buffer.alloc(length);
    const fd = fsImpl.openSync(filePath, "r");
    try {
      const read = fsImpl.readSync(fd, buffer, 0, length, offset);
      if (read > 0) consume(index, buffer.toString("utf8", 0, read));
      offsets.set(index, offset + read);
    } finally {
      fsImpl.closeSync(fd);
    }
  };

  const pollAll = () => {
    for (let i = 1; i <= maxWorkers; i++) pollWorker(i);
  };

  return {
    start() {
      if (timer) return;
      pollAll();
      timer = setInterval(pollAll, POLL_INTERVAL_MS);
      timer?.unref?.();
      return this;
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      return this;
    },
    pollAll,
    getOffsets: () => new Map(offsets),
  };
}

// Starts the control-side collector on non-systemd Linux (containers). On a
// systemd host the journald follower already covers workers, so this is a
// container-only path and must never double-append lines.
export function startWorkerFileCollector({
  env = process.env,
  platform = process.platform,
  systemdPresent = () => existsSyncSafe(),
  dataDir,
  appendLine = appendConsoleLogLine,
  fsImpl = fs,
} = {}) {
  if (globalThis._workerFileCollector) return globalThis._workerFileCollector;

  // Workers own no follower; builds must not spawn children; and on a host with
  // journald the journal follower already covers workers, so the file bridge
  // must stay off to avoid the same line appearing twice.
  if (isApiWorkerRole(env)) return null;
  if (BUILD_PHASES.has(env.NEXT_PHASE)) return null;
  if (platform === "linux" && systemdPresent()) return null;

  if (!dataDir) {
    dataDir = getDataDir();
  }

  const collector = createWorkerFileCollector({ appendLine, fsImpl, dataDir });
  globalThis._workerFileCollector = collector;
  collector.start();
  return collector;
}

function existsSyncSafe(p = "/run/systemd/system") {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

export { existsSyncSafe };
