# Queue Lease Hardening and PostgreSQL API Workers

## Goal

Eliminate limiter slots and waiters that can remain stuck after long uptime. Then use multiple CPU cores for `/v1` traffic without duplicating stateful control-plane jobs or weakening SQLite safety.

## Evidence

- Production showed one Next.js process on a 24-core host, about 40% CPU, 607 MiB RSS, and a previous 1 GiB peak.
- The Go limiter is shared, but `Acquire` returns no ownership token and `Release(scope,key)` removes the oldest timestamp.
- A timeout/cancel can race a queue grant. `pump` increments concurrency before closing the waiter channel. The timeout branch may return without releasing the granted slot.
- FIFO timestamp deletion does not identify the caller. A watchdog expiry or delayed release can free another request's slot.
- Production logged `TypeError: Invalid state: ReadableStream is locked` during cancellation.
- Next initialization owns process-local scheduler, tunnel, MITM, MCP, session, and provider caches. Blind clustering duplicates those responsibilities.

## Selected Architecture

Deliver in three gated phases. A later phase starts only after the preceding acceptance checks pass.

### Phase 1: Lease-owned Go limiter

Replace anonymous slot counts with opaque lease IDs.

- `Acquire` returns a lease ID only after ownership is committed.
- Queue waiter states are explicit: waiting, granted, cancelled.
- Grant and timeout/cancel transition under the bucket lock. Exactly one transition wins.
- `Release(scope,key,leaseId)` removes only that lease and is idempotent.
- RPM accounting remains per successful grant. RPM grants are not undone by release.
- Watchdog expires individual leases by acquisition timestamp.
- Reset cancels waiters or clears leases without pumping ownership to callers that cannot receive it.
- Compatibility: release without a lease is temporarily accepted only for old clients, logged/telemetried, then removed after rollout.

Invariants:

1. `activeConcurrency == len(activeLeases)`.
2. Every granted concurrency slot has one lease owner.
3. Every lease is released or expires once.
4. Timeout/cancel never returns while retaining a lease.
5. Queue length counts only waiting waiters.

### Phase 2: Stream termination hardening

Use one idempotent finalizer for complete, error, cancel, and downstream disconnect.

- Finalizer releases API-key and provider leases first.
- Reader/writer cancellation checks lock/closed state and absorbs expected cancellation rejections.
- No detached `reader.cancel()` promise may produce an unhandled rejection.
- Stall timers are cleared by every terminal path.
- Stream completion persists usage asynchronously after slot release.

### Phase 3: PostgreSQL-only API worker pool

Do not cluster the current full Next server.

- Keep one control-plane Next process for dashboard, auth, settings, OAuth callbacks, tunnel, MITM, MCP, quota auto-ping, and token refresh.
- Add opt-in stateless API workers for `/v1/*`, `/v2/*`, `/api/v1/*`, and `/api/v2/*`.
- Go gateway round-robins API requests across healthy API worker loopback ports. Non-API routes stay on the control process.
- API workers require PostgreSQL and `WORKER_ROLE=api`. Startup refuses worker count above one for SQLite.
- API role disables scheduler, tunnel, MITM, MCP child ownership, migrations, and other singleton jobs.
- Shared secrets come from environment or the shared data directory. No per-worker generated auth material.
- Default worker count remains one. Recommended initial production value: two, then four only after measurement.

## Failure Handling

- Worker health failure removes it from selection. Retry only before response headers and only for idempotent requests. Never replay an in-progress streamed POST.
- A worker crash leaves Go leases recoverable by lease TTL. The normal disconnect path releases immediately.
- If Go limiter is unavailable, JS fallback remains single-process only. API worker mode fails closed unless the shared Go limiter is healthy.
- Control process remains independently restartable.

## Telemetry

Expose:

- active lease count, queued waiter count, oldest waiter age;
- grant, release, expiry, timeout, cancellation, unknown-release counters;
- worker PID, role, event-loop lag, RSS, active requests;
- per-worker health and selected backend port.

No raw API keys or lease IDs appear in dashboard output. Hash identifiers as today.

## Testing

### Limiter

- Deterministic grant-vs-timeout and grant-vs-cancel tests.
- Release-order test proving one lease cannot release another.
- Idempotent duplicate/unknown release tests.
- Reset-with-waiters test.
- Watchdog mixed-age lease test.
- `go test -race ./...` plus sustained queue stress.

### Streaming

- Client abort before first byte, mid-stream, after terminal frame.
- Locked/closed reader cancellation produces no unhandled rejection.
- Each path releases both leases exactly once.

### Workers

- SQLite rejects `API_WORKERS>1`.
- PostgreSQL routes API traffic across workers while dashboard remains on control.
- Only control starts singleton jobs.
- Kill one API worker during load. Existing stream may fail cleanly; new requests continue; leases recover.

## Rollout

1. Ship lease protocol with compatibility release support. Deploy Go engine and Node together.
2. Observe zero orphan grants and unknown releases during a 24-hour single-worker soak.
3. Ship stream finalizer. Repeat abort/stall load and 24-hour soak.
4. Enable two API workers on PostgreSQL canary. Compare queue age, event-loop lag, CPU, RSS, errors, and p95 latency.
5. Expand to four only when CPU saturation or event-loop lag justifies it.

Rollback disables API workers and returns Go routing to the control backend. Lease protocol remains backward compatible during rollout.

## Non-goals

- No Node `worker_threads` for Next request handling.
- No multi-process SQLite.
- No blind retry of streaming POST requests.
- No new external process manager. systemd and the Go gateway remain the supervisors.
