// Dedicated follower for `9router-worker@N.service` journal entries.
//
// Only the control process starts this. Workers keep their local console patch
// (journald must still receive their output) but never spawn a follower, so the
// topology comes from the systemd wildcard instead of a manual worker list.
//
// Dependency-injected spawn/timers keep this testable without systemd. Nothing
// here calls console.* — those patched calls would recurse into the buffer this
// module writes to.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isApiWorkerRole } from "@/shared/utils/engineConfig.js";
import { appendConsoleLogLine } from "@/lib/consoleLogBuffer.js";

const JOURNAL_BACKLOG_LINES = 50;
const MAX_PENDING_CHARS = 65536;
const CURSOR_HISTORY_SIZE = 256;
const WORKER_MAX = 8;
const WORKER_UNIT = (index) => `9router-worker@${index}.service`;
const WORKER_UNIT_RE = /^9router-worker@([1-8])\.service$/;

// journalctl resolves a --unit= glob once at startup: a worker that systemd
// starts later is never followed (verified on systemd 257: a transient
// `--unit=x@*.service` follower missed `x@3.service`, while explicit
// `--unit=x@3.service` captured it). Subscribe to every supported index up
// front so raising API_WORKERS keeps working without a manual worker list.
const WORKER_UNITS = Array.from({ length: WORKER_MAX }, (_, i) => WORKER_UNIT(i + 1));
const RETRY_DELAYS_MS = [1000, 2000, 5000, 10000];
const UNAVAILABLE_MESSAGE = "Worker log collector unavailable";
const BUILD_PHASES = new Set(["phase-production-build", "phase-export", "phase-static"]);

function backoffDelay(attempt) {
  return RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
}

export function createWorkerJournalCollector({
  appendLine = appendConsoleLogLine,
  spawnImpl = spawn,
  processImpl = process,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  let child = null;
  let stopped = false;
  let started = false;
  let retryTimer = null;
  let attempts = 0;
  let pendingChunk = "";
  let detachChild = null;
  let lastCursor = null;
  const recentCursors = new Set();
  const cursorOrder = [];
  let unavailableReported = false;

  const reportUnavailable = () => {
    if (unavailableReported) return;
    unavailableReported = true;
    appendLine({ source: "control", message: UNAVAILABLE_MESSAGE });
  };

  const scheduleRetry = () => {
    if (stopped || child || retryTimer) return;
    const delay = backoffDelay(attempts);
    attempts += 1;
    retryTimer = setTimeoutImpl(() => {
      retryTimer = null;
      startChild();
    }, delay);
    retryTimer?.unref?.();
  };

  const acceptEntry = (raw) => {
    let entry;
    try {
      entry = JSON.parse(raw);
    } catch {
      return;
    }
    const match = WORKER_UNIT_RE.exec(String(entry?._SYSTEMD_UNIT ?? ""));
    if (!match) return;
    if (typeof entry.MESSAGE !== "string") return;

    const cursor = typeof entry.__CURSOR === "string" ? entry.__CURSOR : null;
    // Replayed entries after an in-process restart carry a cursor we already saw.
    if (cursor && recentCursors.has(cursor)) return;
    if (cursor) {
      lastCursor = cursor;
      recentCursors.add(cursor);
      cursorOrder.push(cursor);
      if (cursorOrder.length > CURSOR_HISTORY_SIZE) recentCursors.delete(cursorOrder.shift());
    }

    const index = Number(match[1]);
    for (const line of entry.MESSAGE.split("\n")) {
      appendLine({ source: "worker", index, message: line });
    }
  };

  const handleData = (chunk) => {
    pendingChunk += typeof chunk === "string" ? chunk : String(chunk);
    if (!pendingChunk.includes("\n") && pendingChunk.length > MAX_PENDING_CHARS) {
      pendingChunk = "";
      return;
    }
    let newline = pendingChunk.indexOf("\n");
    while (newline !== -1) {
      const raw = newline <= MAX_PENDING_CHARS ? pendingChunk.slice(0, newline).trim() : "";
      pendingChunk = pendingChunk.slice(newline + 1);
      if (raw) acceptEntry(raw);
      newline = pendingChunk.indexOf("\n");
    }
    if (pendingChunk.length > MAX_PENDING_CHARS) pendingChunk = "";
  };

  function startChild() {
    if (stopped || child) return;
    const args = ["--follow", "--output=json", ...WORKER_UNITS.map((unit) => `--unit=${unit}`)];
    if (lastCursor) args.push(`--after-cursor=${lastCursor}`);
    else args.push(`--lines=${JOURNAL_BACKLOG_LINES}`);

    try {
      child = spawnImpl("journalctl", args, { shell: false, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      child = null;
      reportUnavailable();
      scheduleRetry();
      return;
    }

    const activeChild = child;
    let exited = false;
    const detach = () => {
      activeChild.stdout?.off?.("data", handleData);
      activeChild.off?.("error", onError);
      activeChild.off?.("close", onExit);
      if (detachChild === detach) detachChild = null;
    };
    detachChild = detach;
    const onExit = () => {
      if (exited) return;
      exited = true;
      detach();
      if (child !== activeChild) return;
      child = null;
      pendingChunk = "";
      if (stopped) return;
      reportUnavailable();
      scheduleRetry();
    };
    const onError = () => {
      try { activeChild.kill(); } catch { /* close/error cleanup remains idempotent */ }
      onExit();
    };
    activeChild.stdout?.setEncoding?.("utf8");
    activeChild.stdout?.on("data", handleData);
    activeChild.on?.("error", onError);
    activeChild.on?.("close", onExit);
  }

  const onSignal = () => stop();

  function start() {
    if (started || stopped) return;
    started = true;
    processImpl.on("SIGTERM", onSignal);
    processImpl.on("SIGINT", onSignal);
    startChild();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (retryTimer) {
      clearTimeoutImpl(retryTimer);
      retryTimer = null;
    }
    processImpl.removeListener("SIGTERM", onSignal);
    processImpl.removeListener("SIGINT", onSignal);
    const active = child;
    child = null;
    detachChild?.();
    try {
      active?.kill();
    } catch {
      // A child that already exited needs no cleanup.
    }
  }

  return { start, stop, getChild: () => child };
}

export function startWorkerJournalCollector(options = {}) {
  if (globalThis._workerJournalCollector) return globalThis._workerJournalCollector;

  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const systemdPresent = options.systemdPresent ?? existsSync("/run/systemd/system");

  // Workers own no follower; builds must not spawn children; there is no
  // journald off Linux or on a host without systemd.
  if (isApiWorkerRole(env)) return null;
  if (BUILD_PHASES.has(env.NEXT_PHASE)) return null;
  if (platform !== "linux" || !systemdPresent) return null;

  const collector = createWorkerJournalCollector(options);
  const stop = collector.stop;
  collector.stop = () => {
    stop();
    if (globalThis._workerJournalCollector === collector) delete globalThis._workerJournalCollector;
  };
  globalThis._workerJournalCollector = collector;
  collector.start();
  return collector;
}
