# Redis Single-Writer Bridge for SQLite API Workers

## Goal

Allow multiple API worker processes while SQLite remains the primary persistent database. Preserve one control process, one SQLite writer, shared limiter correctness, stream cancellation, durable usage records, credential safety, and conservative single-process defaults.

## Approved Interpretation and Verification Status

The original request asked whether adding a Redis module could make SQLite multicore. Before the design was approved, the following details required interpretation:

- SQLite remains the primary database; Redis is supporting coordination and transport, not a replacement database.
- "Redis module" means an optional Redis service/client integration, supporting bundled Docker and external `REDIS_URL` deployments.
- Initial scope is Docker. Native systemd remains single-process.
- Existing Go limiter remains authoritative; Redis does not duplicate request concurrency control.
- Safety takes priority over availability: failed Redis/writer dependencies remove API workers from readiness and route eligible new traffic to control.
- Redis durability permits explicitly measured best-effort telemetry loss, but never silent loss of credential/routing correctness mutations.

The user approved the design with those interpretations. This document is still a specification, not an implemented feature. Fresh baseline checks on 2026-09-24 observed:

- SQLite with `API_WORKERS=2` exits `1` and reports that PostgreSQL is required.
- SQLite with `API_WORKERS=1` passes configuration validation.
- Compose currently contains only the `9router` default service; no Redis client dependency or `REDIS_URL` implementation exists.
- Current real interfaces remain healthy: health `200`, models `200`, limiter readiness `200`, usage without a key `401`, malformed chat `400`, and public `/ready` `404`.

Therefore the current application has not gained SQLite multicore capability. The design improves requirement clarity and provides testable acceptance gates. End-to-end Redis/SQLite multicore acceptance remains blocked until implementation, disposable Redis integration tests, and the specified canary are completed.

## Current Constraints

- `custom-server.js` and `deploy/docker-entrypoint.sh` reject `API_WORKERS>1` unless PostgreSQL is selected.
- API workers execute request-side writes through `saveRequestUsage`, `saveRequestDetail`, and provider footer logging.
- `usageRepo.js` updates history, daily aggregate JSON, and lifetime counters in one read-modify-write transaction. Concurrent SQLite writers can lose aggregate updates even when WAL reduces lock contention.
- `requestDetailsRepo.js` owns a process-local write buffer. Multiple processes would create independent buffers and competing SQLite writes.
- Provider token refresh and health updates call `updateProviderConnection`. OAuth refresh locks are process-local, so two workers can rotate the same single-use refresh token concurrently.
- Pending request state, connection caches, model/provider rotation, and several executor session caches are process-local.
- The `sql.js` fallback loads the entire database into each process and rewrites the database file after mutations. It cannot safely participate in multi-process SQLite mode.
- The Go limiter already owns cross-process RPM, concurrency, queueing, and leases. Redis must not replace or duplicate it.

## Considered Approaches

### 1. PostgreSQL-only multicore

Keep current implementation. Lowest engineering and recovery risk because PostgreSQL already provides concurrent transactions and shared visibility. This remains the recommended production path for operators able to run PostgreSQL.

### 2. Redis Streams plus one SQLite writer

API workers enqueue mutation commands. The control process is the only SQLite writer and acknowledges commands after commit. This satisfies the SQLite requirement but adds Redis durability, replay, backpressure, and cache-coherence responsibilities.

Selected for the optional SQLite multicore mode.

### 3. Internal HTTP or Unix-socket DB broker

API workers send mutations directly to the control process. Less infrastructure, but no durable queue across a control crash unless another write-ahead log is built. Building that log would recreate a weaker Redis Streams implementation. Rejected.

## Selected Architecture

### Topology

- One control Next.js process owns migrations, SQLite writes, dashboard, schedulers, tunnel, MITM, MCP, catalog sync, and background token refresh.
- One or more API worker processes serve only API routes already allowed by the worker-role boundary.
- API workers open SQLite in read-only mode using `better-sqlite3`, `node:sqlite`, or `bun:sqlite`.
- `sql.js` is forbidden when `API_WORKERS>1` because each process would hold a stale private database image.
- Redis is private infrastructure. Supported deployment modes:
  - bundled Docker sidecar under an explicit `sqlite-multicore` profile;
  - external Redis selected with `REDIS_URL`.
- Redis receives no public host port in the bundled profile.
- The Go limiter remains authoritative for RPM, concurrency, leases, queue telemetry, and cancellation.

### Activation Contract

SQLite multicore activates only when all conditions hold:

1. database type is SQLite;
2. `API_WORKERS>1`;
3. `SQLITE_MULTICORE=redis` is explicitly set;
4. `REDIS_URL` is configured and reachable;
5. Redis persistence policy passes startup validation;
6. a native SQLite adapter with read-only worker support is available;
7. control migration and writer readiness barriers pass;
8. Go limiter readiness passes.

Otherwise startup fails closed. Existing SQLite installations remain `API_WORKERS=1` by default. PostgreSQL multicore behavior remains unchanged.

### Mutation Stream

Use one ordered Redis Stream per installation, namespaced by a non-secret deployment ID. Use one consumer group with exactly one active writer consumer.

Each command contains:

- schema version;
- mutation type;
- globally unique receipt ID;
- originating worker ID;
- creation timestamp;
- bounded JSON payload;
- optional consistency requirement.

Sensitive payload fields use a dedicated authenticated-encryption key shared by control and API workers. Existing `API_KEY_SECRET` is currently used for HMAC integrity, not credential encryption, and must not be silently repurposed. Redis TLS/ACL is additionally required for non-loopback deployments. Until the dedicated encryption primitive and key lifecycle exist, OAuth credential mutation remains control-only rather than entering Redis. Never enqueue raw authorization headers, cookies, or request/response bodies. Encrypted credential payloads remain excluded from logs/traces.

The control writer performs:

1. validate schema, type, size, and payload;
2. begin SQLite transaction;
3. insert receipt ID into a dedicated processed-command table with a unique constraint;
4. apply mutation using existing repository logic adapted behind a command handler;
5. increment a monotonic database version inside the same SQLite transaction when the mutation affects shared configuration or credentials;
6. commit SQLite transaction;
7. publish the committed version as a best-effort wake-up hint;
8. `XACK` only after commit.

Workers compare critical-cache versions against the SQLite version row. Pub/Sub only wakes the check sooner. This avoids a stale-cache window if the writer crashes after SQLite commit but before publishing to Redis.

A replayed command whose receipt already exists becomes a successful no-op, then is acknowledged. Retries retain the same receipt ID. This gives at-least-once transport with idempotent database effects. A caller that loses its acknowledgement queries the durable receipt/version from SQLite or retries the same receipt ID; it must not create a new command ID for the same logical mutation.

### Mutation Classes

#### Durable asynchronous telemetry

The following may return before SQLite commit:

- request usage history and daily/lifetime aggregates;
- request details;
- provider footer logs.

Workers enqueue with a bounded timeout. If Redis rejects the command or backlog exceeds the safety ceiling, the request response may still complete, but telemetry loss is explicitly counted and logged. This policy matches current best-effort request-detail behavior while making loss observable.

#### Synchronous correctness mutations

The following require an acknowledged SQLite commit before request processing continues:

- OAuth access/refresh token updates;
- provider health, cooldown, model-lock, and credential state used by routing;
- any API-side mutation that changes authorization or provider selection.

The worker sends the command, waits on a receipt-specific response channel with a bounded deadline, then rereads SQLite after receiving the committed version. Timeout or Redis failure fails the affected provider operation closed. It must never fall back to direct SQLite writing.

Dashboard and control-only routes continue calling repositories directly because they execute inside the sole writer process.

### OAuth Refresh Ownership

Redis provides a lease-based lock per provider connection for request-triggered token refresh.

- Acquire uses a unique owner token and bounded TTL.
- Release verifies the owner token with an atomic compare-and-delete script.
- Lock renewal is bounded and stops on request termination.
- After acquiring, the worker rereads the latest connection version before refreshing.
- The committed token update is synchronous through the mutation stream.
- Lock loss aborts persistence and forces a fresh credential read.

Background refresh remains control-only. A request worker and background refresh use the same Redis lock contract.

### Reads and Cache Coherence

Workers use read-only SQLite connections. After the writer commits a configuration or credential mutation, it increments a monotonic database version in Redis and publishes an invalidation message.

- Workers clear affected connection, API-key, model, pricing, alias, and settings caches.
- Every critical read cache also checks the monotonic version before reuse. Pub/Sub is only a latency optimization because messages can be lost during disconnect.
- Usage/dashboard reads may be eventually consistent by one writer batch.
- Credential and routing mutations use synchronous commit plus version confirmation.
- Process-local request execution state may remain local when it does not affect cross-worker correctness.
- Dashboard active-request totals continue using the shared Go limiter snapshot rather than Redis duplication.

### Shared Routing State

The current provider-selection mutex, sticky round-robin counters, combo rotation, and proxy-pool rotation are process-local. SQLite single-writer alone does not make those decisions consistent across workers.

- Redis atomic operations own provider-account round-robin, sticky-use counters, combo rotation, and proxy-pool rotation in multicore mode.
- Selection keys are namespaced by deployment, provider/combo/pool ID, and relevant model scope. They contain no credentials.
- Connection availability, model locks, cooldowns, and enabled state still come from version-checked SQLite reads.
- Selection uses an atomic Redis script that advances only among caller-supplied eligible IDs. The returned ID is revalidated against the current SQLite version before upstream dispatch.
- Redis selection failure makes the API worker unready and falls back to control. A worker never silently reverts to its process-local mutex/counter in multicore mode.
- The Go limiter remains the authority after selection for per-connection concurrency and queueing.

### Stateful Executor Eligibility

Some executors keep session continuity or protocol state only in process memory. Before a route/provider enters the worker pool, it must pass an explicit state audit.

- Stateless request/response providers may use normal round-robin workers.
- Providers whose continuity is fully carried in the client request may use normal workers after tests prove worker switching is safe.
- Providers requiring worker-local sessions must either move that state to a bounded shared store with expiry, receive stable gateway affinity with a defined worker-loss behavior, or remain routed to control.
- Unknown providers default to control-only. The implementation must not assume every `/v1` or `/v2` provider is worker-safe.
- Session payloads containing credentials or private conversation data are not added to Redis under this design. Such providers remain control-only unless separately designed.

### Writer Ownership

The deployment starts exactly one control process per SQLite file. API workers never promote themselves to writer. In the initial release there is no automatic control-process failover or active-active writer election. The supervisor must stop API workers before starting a replacement control process; startup refuses readiness until SQLite ownership, migration, and writer health are established. A Redis lease may be used for observability/coordination, but is not treated as a fencing mechanism for SQLite and cannot authorize two writers.

This is not a general high-availability SQLite design. The SQLite file remains single-host storage.

## Redis Durability and Retention

Bundled Redis uses append-only persistence, `appendfsync everysec`, a persistent volume, no eviction, and memory limits sized for the bounded stream. External Redis must pass connectivity, persistence, and eviction-policy preflight. There is no production `unsafe` override for Redis durability in the initial release.

- Stream length and bytes are capped by backpressure, not silent trimming of unacknowledged entries.
- Acknowledged entries are trimmed only after a retention margin.
- Pending entries are reclaimed after writer restart using consumer-group recovery.
- Poison commands move to a dead-letter stream after a bounded retry count. Synchronous callers receive failure.
- Payload size, stream lag, oldest pending age, retry count, and dead-letter count have hard limits and telemetry.

## Failure Semantics

### Redis unavailable

- API workers become unready.
- The Go gateway routes new requests to control only when control reports healthy direct-write mode.
- Control continues single-process SQLite operation.
- Existing worker requests may finish provider streaming but cannot write SQLite directly.
- Correctness mutations fail closed. Best-effort telemetry commands that cannot be enqueued increment explicit loss counters; no acknowledgement or persistence claim is made for them.

### Writer unavailable or stalled

- API workers become unready when writer heartbeat, lag, or oldest-pending thresholds fail.
- Gateway falls back to control only if control reports healthy direct-write mode.
- Redis commands remain pending for recovery. No worker promotes itself to SQLite writer.
- A replacement control starts only after the supervisor confirms the prior control exited and SQLite writer ownership is released.

### SQLite busy, full, or corrupt

- Writer retries only transient busy errors with bounded jitter.
- Disk-full, integrity, migration, or persistent I/O errors mark writer unready and preserve pending Redis commands.
- No acknowledgment occurs before successful commit.

### Worker crash

- Requests release Go limiter leases through normal cancellation or lease TTL.
- Already-enqueued mutation commands survive.
- Commands not accepted by Redis are treated according to synchronous or telemetry policy above.

### Redis data loss

Redis persistence is not equivalent to SQLite durability. Up to the Redis persistence window can be lost before SQLite commit. Production documentation must state this explicitly. Operators requiring stronger durability should use PostgreSQL rather than SQLite multicore.

## Backpressure

Worker enqueue operations have bounded payload and timeout limits. Readiness fails before Redis memory exhaustion. Telemetry loss is explicitly best-effort when enqueue is impossible; synchronous correctness mutations never silently drop.

Minimum signals:

- stream length and approximate bytes;
- pending command count;
- oldest uncommitted age;
- enqueue latency and failures;
- commit latency by mutation type;
- replay, duplicate, retry, dead-letter, and telemetry-loss counters;
- writer leadership and heartbeat;
- worker cache version lag.

Safety thresholds are configurable within documented bounds. Defaults favor fallback to control before user-visible queue growth.

## Security

- Bundled Redis listens only on the Compose network and has no host port.
- External Redis requires `rediss://` unless explicitly loopback/private development mode.
- Redis ACL credentials come from secrets/environment, never dashboard responses or logs.
- The queue-encryption key is separate from Redis ACL credentials and API-key HMAC material, supports rotation, and is never persisted inside Redis.
- Stream keys include deployment namespace, never API keys or connection tokens.
- Payload logging records mutation type and receipt hash only.
- Queue inspection endpoints are admin-only and redact payloads.
- Existing header sanitization and request-detail truncation run before enqueue.

## Deployment

### Client Library

Use the official maintained Node Redis client as the single new runtime dependency. Do not implement RESP, pooling, reconnect, Streams, or TLS manually. Create one bounded client module for commands and one blocking consumer connection owned only by control. Connection retries, command timeouts, and offline queue behavior are explicit and fail closed for API-worker readiness.

### Docker

Add an opt-in `sqlite-multicore` Compose profile containing Redis with health check, AOF volume, no public port, and no-eviction policy. Installer configuration generates a strong Redis credential and sets the explicit activation variables. Redis failure must not block ordinary single-process SQLite startup when the profile is disabled.

### External Redis

Accept `REDIS_URL`, deployment namespace, TLS/ACL settings, and bounded queue thresholds. Preflight checks connectivity, server mode, persistence, eviction, and required command support.

### Native systemd

Remain `API_WORKERS=1` initially. Native Redis-supervised multicore requires a separate design covering service dependencies, Redis lifecycle, secrets, and rollback. No implicit local Redis installation.

## Rollout

1. Add command schemas, in-process writer abstraction, receipt table, and tests while retaining direct writes.
2. Route telemetry mutations through the abstraction in one process and prove exact database parity.
3. Add Redis transport, replay, dead-letter, backpressure, and readiness tests.
4. Add read-only API-worker adapter and cache versioning.
5. Add synchronous provider-state mutations and shared OAuth refresh locks.
6. Move routing counters to atomic Redis state and create a provider eligibility registry; unsafe stateful executors stay control-only.
7. Enable two workers only in isolated Docker acceptance using disposable SQLite and Redis volumes.
8. Exercise normal requests, streaming aborts, Redis restart, writer restart, worker kill, duplicate delivery, poison commands, disk-full simulation, backlog recovery, routing fairness, and control-only stateful providers.
9. Canary `API_WORKERS=2` with bounded traffic for 24 hours. Compare error rate, p95 latency, event-loop lag, CPU, RSS, queue age, telemetry loss, and SQLite integrity.
10. Keep production default at one worker until canary and soak criteria pass.

Rollback sets `API_WORKERS=1` and disables `SQLITE_MULTICORE`. Stop API workers only after streams drain. The control writer drains accepted commands before Redis shutdown. PostgreSQL rollback path is unchanged.

## Acceptance Criteria

- SQLite without explicit Redis mode rejects `API_WORKERS>1`.
- `sql.js` rejects SQLite multicore startup.
- Exactly one process opens SQLite read-write; workers demonstrably open read-only.
- Dashboard, scheduler, tunnel, MITM, MCP, migrations, catalog sync, and background refresh remain control-only.
- The supervisor starts one control process per SQLite file and never elects an API worker as replacement writer.
- Duplicate command delivery changes SQLite exactly once.
- Writer crash after commit but before `XACK` replays safely; lost caller acknowledgements resolve through durable receipt lookup or same-ID retry.
- A commit followed by writer crash before Redis publish still invalidates caches through SQLite version polling.
- Redis restart recovers pending commands without duplicate aggregates.
- OAuth refresh races produce one token rotation and one committed connection version.
- Provider-account, combo, and proxy rotation remain globally consistent across workers; Redis failure never falls back to local rotation state.
- Every provider is classified as worker-safe or control-only, and stateful-provider requests preserve continuity or stay on control.
- Redis or writer failure removes workers from readiness and routes new traffic to control without direct worker writes.
- Client abort returns Go limiter state to baseline and does not strand Redis commands.
- Usage totals, request details, footer logs, provider health, and recent-request upstream model data match single-process SQLite results.
- Public `/ready` remains unavailable; internal readiness reports Redis, writer, SQLite, limiter, worker, and backlog states.
- A 24-hour canary completes with zero SQLite integrity errors, zero unauthorized direct writes, zero lost correctness mutations, zero stuck Go leases, no unresolved cache-version lag, and telemetry loss within the explicitly approved best-effort threshold.

## Non-goals

- Redis does not replace SQLite as the primary database.
- Redis does not replace the Go limiter.
- No generic distributed transaction across Redis and SQLite.
- No multi-host shared SQLite file.
- No automatic control-process failover or active-active SQLite writers.
- No automatic worker-count increase based only on CPU count.
- No promise of PostgreSQL-equivalent durability or operational simplicity.
- No native systemd Redis orchestration in the first release.
