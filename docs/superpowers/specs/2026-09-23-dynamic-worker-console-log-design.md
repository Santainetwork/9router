# Dynamic Worker Console Log Aggregation Design

**Date:** 2026-09-23  
**Status:** Approved design, pending implementation plan

## Goal

Make `/dashboard/console-log` show logs from the control process and every active native API worker without maintaining a manual worker list.

Every displayed line must identify its source:

```text
[CONTROL] [20:32:19] ...
[WORKER-1] [20:32:19] ...
[WORKER-2] [20:32:20] ...
```

Changing `API_WORKERS` and reconciling systemd instances must automatically change which worker logs appear. The Console Log API and SSE contract remain backward-compatible: clients still receive arrays of strings.

## Non-goals

- No SQLite/PostgreSQL log table.
- No Redis, message broker, or new network listener.
- No worker-to-control HTTP log POSTs.
- No manual worker port or unit list.
- No historical log search beyond the existing bounded buffer.
- No log aggregation on non-systemd platforms in this iteration.

## Runtime Evidence

Production already exposes reliable structured identities in journald:

- Control: `_SYSTEMD_UNIT=9router.service`, `SYSLOG_IDENTIFIER=9router-backend`.
- Worker N: `_SYSTEMD_UNIT=9router-worker@N.service`, `SYSLOG_IDENTIFIER=9router-worker-N`.
- `systemctl list-units '9router-worker@*.service'` currently discovers worker instances `1` and `2` without a hard-coded count.
- systemd 257 supports `journalctl --follow --output=json` and journal cursors.
- The journal is persistent under `/var/log/journal`.
- Existing Console Log memory is bounded by `CONSOLE_LOG_CONFIG.maxLines = 200` and SSE already batches appended lines.

## Options Considered

### A. Control-side journald collector, recommended

The control process starts one `journalctl --follow --output=json` child for `9router-worker@*.service`. It parses unit metadata, prefixes each message, then appends it to the existing Console Log ring buffer.

**Advantages**

- Dynamic worker discovery through the systemd wildcard.
- No worker code or network protocol.
- Survives worker restarts and topology changes.
- Preserves logs produced before the browser opens.
- Smallest operational surface on the deployed native topology.

**Trade-offs**

- Linux/systemd specific.
- Requires safe child lifecycle and restart handling.
- Collector must avoid replay duplicates after its own restart.

### B. Worker-to-control IPC/HTTP

Each worker pushes logs to a private control endpoint or Unix socket.

**Advantages:** portable, live, independent of journald.  
**Rejected:** adds authentication, backpressure, reconnect, request amplification, and new failure paths to inference workers.

### C. Browser polls each worker

The browser discovers worker ports and queries worker-local log APIs.

**Advantages:** little server aggregation state.  
**Rejected:** exposes internal topology, complicates authentication/CORS, misses worker restarts, duplicates polling, and requires manual/derived port knowledge in the UI.

## Architecture

```mermaid
graph LR
    C[Control console.*] --> B[Bounded Console Log Buffer]
    J[systemd journal] --> P[journalctl JSON follower]
    W1[9router-worker@1] --> J
    W2[9router-worker@2] --> J
    WN[9router-worker@N] --> J
    P --> N[Normalize + prefix]
    N --> B
    B --> A[Snapshot API]
    B --> S[SSE stream]
    A --> U[Console Log UI]
    S --> U
```

### Ownership

Only the control process may start the collector. `isApiWorkerRole()` is the ownership gate. API workers keep their existing local console patch because journald must still receive their output, but they never spawn collectors.

The collector starts from Node instrumentation after `initConsoleLogCapture()`. It is skipped during build/export phases, API-worker role, non-Linux platforms, and when `journalctl` is unavailable.

### Dynamic discovery

No explicit `API_WORKERS` loop is needed. The follower subscribes to the systemd wildcard:

```text
journalctl --follow --output=json --unit=9router-worker@*.service
```

New instances matching the template are included by journald. Worker index comes from `_SYSTEMD_UNIT` using the strict pattern:

```text
^9router-worker@([1-8])\.service$
```

Unexpected units or malformed indices are discarded. The supported maximum remains aligned with `WORKER_MAX=8`.

### Source labels

- Local control `console.*` lines receive `[CONTROL]` at capture time.
- Journal worker lines receive `[WORKER-N]` after metadata validation.
- A line already prefixed with the same source is not prefixed twice.
- Worker message text is treated as data. It cannot choose its source label.

The label precedes the existing timestamp/level text. Existing string-based API/SSE payloads remain unchanged structurally.

## Components

### `src/lib/consoleLogBuffer.js`

Add a public append function that:

1. accepts a trusted source enum/index plus an untrusted message string,
2. strips ANSI/control sequences,
3. enforces a per-line byte/character ceiling,
4. adds `[CONTROL]` or `[WORKER-N]`,
5. appends to the existing 200-line ring buffer,
6. uses the existing 100 ms / 50-line SSE batcher.

`initConsoleLogCapture()` routes local control console calls through this append function.

### New server-only journal collector module

Responsibilities:

- spawn one journal follower,
- parse newline-delimited JSON incrementally,
- extract and validate `_SYSTEMD_UNIT`, `MESSAGE`, and `__CURSOR`,
- split multiline `MESSAGE` values into individually prefixed lines,
- suppress exact replay duplicates by cursor,
- restart with bounded exponential backoff after unexpected exit,
- stop and remove listeners on SIGTERM/SIGINT,
- expose small dependency-injected parser/lifecycle functions for tests.

The collector must never call patched `console.*` for ordinary child output, which would create recursion. Its own lifecycle diagnostics use the saved original console or a one-shot buffer append marked `[CONTROL]`.

### `src/instrumentation.js`

After installing local console capture:

```text
if Node runtime and control role:
    start journal collector
```

Both functions are idempotent under HMR/module re-import.

### Console Log UI

Keep the existing text stream and rendering. Add only source-aware coloring if desired:

- `[CONTROL]`: muted cyan
- `[WORKER-N]`: distinct amber/purple family

Source labels remain visible as text, not color-only, preserving accessibility and copy/paste usefulness.

## Cursor and replay policy

Startup behavior must avoid flooding the 200-line buffer with old history while still showing recent worker context:

1. On first control startup, request a bounded backlog, recommended `--lines=50`, then follow.
2. Record `__CURSOR` in process memory after every accepted journal entry.
3. On collector child restart within the same control process, resume with `--after-cursor=<lastCursor>`.
4. On control process restart, begin with the bounded backlog again. Duplicate recent lines are acceptable across a full control restart; unlimited journal replay is not.

No cursor is persisted to the application DB.

## Clear semantics

`DELETE /api/translator/console-logs` clears only the application ring buffer and emits the existing SSE `clear` event. It does not delete journald history.

To prevent immediate refill from historical replay:

- a running follower continues from its current cursor,
- clear does not restart the collector,
- only new journal entries appear afterward.

## Failure handling

- `journalctl` missing or permission denied: control logging continues; append one bounded `[CONTROL] Worker log collector unavailable` diagnostic.
- Invalid JSON entry: discard it, increment an in-memory counter, do not crash.
- Oversized/multiline message: split, prefix, and truncate per line.
- Child unexpected exit: restart with capped backoff, for example 1s, 2s, 5s, then 10s max.
- Repeated failure: remain degraded without affecting readiness or inference traffic.
- Backpressure: use existing ring and batched emitter; never block workers or request handling.
- Shutdown: terminate child, clear retry timer, detach signal listeners exactly once.

Collector health is intentionally not part of `/api/ready`: logging failure must not remove API capacity.

## Security

- Collector command and unit selector are constants, never user input.
- Only accepted worker unit pattern determines labels.
- Raw journal metadata is not sent to the browser.
- Existing dashboard/CLI-token protection on Console Log API remains unchanged.
- Existing secrets can already appear in application logs; this feature does not weaken route authorization. A later redaction layer is separate work.
- Do not invoke a shell. Use `spawn("journalctl", args, { shell: false })`.

## Testing and Acceptance

### Unit tests

1. Unit metadata maps to `[WORKER-1]` through `[WORKER-7]`.
2. Malformed/non-worker units are rejected.
3. Control lines receive `[CONTROL]` once.
4. ANSI stripping, multiline splitting, and truncation work.
5. Cursor dedupe drops replayed entries.
6. Parser handles chunk-split JSON lines.
7. Collector singleton survives repeated initialization.
8. Unexpected exit restarts with capped backoff.
9. SIGTERM cleanup kills child and clears timers.
10. `clearConsoleLogs()` does not restart or replay the follower.
11. API-worker role and non-systemd environments do not spawn a collector.

### Isolated integration

Use a fake journal child stream to emit interleaved units 1, 2, and dynamically introduced 3. Verify the existing snapshot API and SSE preserve arrival order and labels without changing their JSON shape.

### Production acceptance

1. Start with `API_WORKERS=3`; produce one request per worker.
2. `/dashboard/console-log` shows `[WORKER-1]` and `[WORKER-2]` live.
3. Increase topology in a disposable/approved rollout; new `[WORKER-3]` appears without source changes or manual configuration.
4. Restart one worker; collector continues and labels remain correct.
5. Clear UI; historical lines do not immediately repopulate.
6. Stop collector child; inference/readiness stay healthy and collector recovers.
7. Confirm ring remains at or below 200 lines and control RSS does not grow under burst logging.

## Rollout and rollback

1. Land collector behind default-on native-systemd detection, not a user-managed worker list.
2. Build and test isolated standalone.
3. Deploy with the existing atomic release/rollback process.
4. Validate Console Log before running provider canaries.
5. Rollback is application release rollback; no DB/schema migration exists.

## Deliberate ceiling

`ponytail:` this design supports native Linux/systemd worker aggregation only. If Docker/multi-host aggregation becomes necessary, replace the journal source behind the same append API with a structured collector or broker; do not add platform branching to the browser.
