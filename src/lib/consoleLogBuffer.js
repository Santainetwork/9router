import { EventEmitter } from "events";
import { stripVTControlCharacters } from "node:util";
import { CONSOLE_LOG_CONFIG } from "@/shared/constants/consoleLog.js";

const consoleLevels = ["log", "info", "warn", "error", "debug"];

// Matches WORKER_MAX in scripts/systemd-worker-topology.sh and the collector's
// `^9router-worker@([1-8])\.service$` unit pattern.
export const MAX_WORKER_INDEX = 8;
export const MAX_LOG_LINE_CHARS = 4000;

if (!global._consoleLogBufferState) {
  global._consoleLogBufferState = {
    logs: [],
    patched: false,
    originals: {},
    emitter: new EventEmitter(),
  };
  global._consoleLogBufferState.emitter.setMaxListeners(50);
}

const state = global._consoleLogBufferState;

// Ensure emitter exists (handles hot reload with stale global)
if (!state.emitter) {
  state.emitter = new EventEmitter();
  state.emitter.setMaxListeners(50);
}

if (!state.pendingLines) state.pendingLines = [];
if (!state.flushTimer) state.flushTimer = null;

const FLUSH_INTERVAL_MS = 100;
const MAX_BATCH_LINES = 50;

function flushPendingLines() {
  state.flushTimer = null;
  if (!state.pendingLines.length) return;

  const lines = state.pendingLines.splice(0, state.pendingLines.length);
  state.emitter.emit("lines", lines);
}

function scheduleFlush() {
  if (state.flushTimer) return;
  state.flushTimer = setTimeout(flushPendingLines, FLUSH_INTERVAL_MS);
  state.flushTimer?.unref?.();
}

function toLogLine(level, args) {
  return args.map(formatArg).join(" ");
}

function stripAnsi(str) {
  return stripVTControlCharacters(str).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function formatArg(arg) {
  if (typeof arg === "string") return stripAnsi(arg);
  if (arg instanceof Error) return stripAnsi(arg.stack || arg.message || String(arg));
  try {
    return stripAnsi(JSON.stringify(arg));
  } catch {
    return stripAnsi(String(arg));
  }
}

function appendLine(line) {
  state.logs.push(line);
  const maxLines = CONSOLE_LOG_CONFIG.maxLines;
  if (state.logs.length > maxLines) {
    state.logs = state.logs.slice(-maxLines);
  }
  state.pendingLines.push(line);
  if (state.pendingLines.length >= MAX_BATCH_LINES) {
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
    flushPendingLines();
  } else {
    scheduleFlush();
  }
}

export function appendConsoleLogLine({ source, index, message }) {
  let label;
  if (source === "control") {
    label = "[CONTROL]";
  } else if (source === "worker" && Number.isInteger(index) && index >= 1 && index <= MAX_WORKER_INDEX) {
    label = `[WORKER-${index}]`;
  } else {
    return false;
  }

  const lines = String(message ?? "").split(/\r?\n/);
  for (let text of lines) {
    text = stripAnsi(text);
    if (text.startsWith(`${label} `) || text === label) {
      text = text.slice(label.length).trimStart();
    }
    appendLine(`${label}${text ? ` ${text}` : ""}`.slice(0, MAX_LOG_LINE_CHARS));
  }
  return true;
}

export function initConsoleLogCapture() {
  if (state.patched) return;

  for (const level of consoleLevels) {
    state.originals[level] = console[level];
    console[level] = (...args) => {
      appendConsoleLogLine({ source: "control", message: toLogLine(level, args) });
      state.originals[level](...args);
    };
  }

  state.patched = true;
}

export function getConsoleLogs() {
  return state.logs;
}

export function clearConsoleLogs() {
  state.logs = [];
  state.pendingLines = [];
  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
  state.emitter.emit("clear");
}

export function getConsoleEmitter() {
  return state.emitter;
}
