# SQLite Redis Multicore Implementation Plan

> **For agentic workers:** Use task-oriented subagents with review checkpoints. Keep SQLite multicore disabled until every safety gate is implemented and accepted.

**Goal:** Add opt-in Docker SQLite multicore using Redis as a durable mutation broker, preserving a single SQLite writer and current PostgreSQL behavior.

**Architecture:** A single control process remains the sole SQLite writer and Redis Streams consumer. API workers open native read-only SQLite connections and enqueue bounded typed mutations with stable receipt IDs. Synchronous credential/routing mutations wait for SQLite commit; best-effort telemetry may return after durable Redis enqueue and reports loss on enqueue failure. Redis does not replace the Go limiter. Unknown/stateful providers remain control-only. Existing SQLite remains single-process unless all checks pass.

**Tech Stack:** Node.js ESM, official `redis` npm client, Redis Streams, SQLite WAL with `better-sqlite3`/`node:sqlite`/`bun:sqlite`, Docker Compose, Go gateway readiness/routing, Node built-in test runner.

**Source spec:** `docs/superpowers/specs/2026-09-24-sqlite-redis-multicore-design.md`

---

## File Structure

- Create `src/lib/redis/client.js`: bounded command/blocking Redis clients, health, shutdown; no app logic.
- Create `src/lib/db/mutationProtocol.js`: versioned allowlisted command schemas, size limits, IDs, payload validation.
- Create `src/lib/db/sqliteMutationQueue.js`: producer enqueue, sync receipt wait, backpressure and telemetry-loss metrics.
- Create `src/lib/db/sqliteMutationWriter.js`: single control consumer, atomic receipt+mutation+version transaction, retries, dead-letter, recovery.
- Create `src/lib/db/sqliteMutationHandlers.js`: allowlisted repository mutations for telemetry and control updates.
- Create `src/lib/db/workerReadiness.js`: Redis, writer heartbeat, migration, native adapter and queue-lag gate.
- Modify `src/lib/db/schema.js`, `src/lib/db/driver.js`, SQLite adapters, `custom-server.js`, and `deploy/docker-entrypoint.sh`: migration tables, native read-only worker opens, fail-closed activation and boot barrier.
- Modify `src/lib/db/repos/usageRepo.js`, `requestDetailsRepo.js`, `providerFooterLogsRepo.js`, `connectionsRepo.js`, plus `open-sse` call sites: queue all worker-side writes. Control role retains direct writes.
- Create `src/lib/redis/cacheVersion.js`; add critical cache version checks and invalidation to provider/settings/API key/configuration caches.
- Create `src/lib/redis/routingState.js`; use atomic global account/combo/proxy rotation in enabled mode.
- Modify `src/sse/services/auth.js`, `src/sse/services/tokenRefresh.js`, `open-sse/services/combo.js`, and `src/lib/network/connectionProxy.js`: shared selection and refresh locking, with unsafe provider executors excluded from workers.
- Modify `hybrid-engine/pkg/proxy/proxy.go` and tests: route only eligible worker-safe APIs; honor readiness and preserve healthy-control fallback without retrying started streams.
- Modify `docker-compose.yml`, `scripts/install-docker.sh`, env examples/docs: optional private Redis profile, AOF volume, secrets, preflight, rollback.
- Add focused Node unit tests, disposable Redis/SQLite integration tests, gateway tests, and acceptance evidence under `tests/unit`, `tests/integration`, and `docs`.

## Task 1: Lock Down Opt-In Contract and Redis Runtime

- [ ] Add failing config tests: default SQLite permits only one worker; `API_WORKERS>1` requires `SQLITE_MULTICORE=redis`, valid `REDIS_URL`, native SQLite adapter capability, and `ENABLE_GO_HYBRID=true`; reject sql.js and malformed Redis URLs.
- [ ] Run `node --test tests/unit/sqlite-redis-config.test.mjs`; confirm these cases fail before implementation.
- [ ] Add `validateWorkerConfig()` checks in `custom-server.js` and matching fail-closed checks in `deploy/docker-entrypoint.sh`. Leave PostgreSQL config behavior unchanged.
- [ ] Add `redis` runtime dependency and update the canonical npm lock only. Do not touch pre-existing untracked `pnpm-lock.yaml` or `pnpm-workspace.yaml`.
- [ ] Create the Redis client module with explicit connect timeout, command timeout, `disableOfflineQueue`, no unbounded reconnect queue, TLS/ACL URL parsing, separate blocking connection, health state, and close hooks.
- [ ] Add tests with a real disposable Redis server when available; unit-test URL/config parsing without claiming this replaces integration acceptance.
- [ ] Commit `feat(redis): add fail-closed SQLite multicore config and Redis client`.

## Task 2: SQLite Read-Only Adapter and Migration Barrier

- [ ] Add failing adapter tests proving read-only worker opens can query but cannot mutate, control can open read-write, and sql.js is rejected for worker role.
- [ ] Add a shared adapter-open mode to better-sqlite3, node:sqlite, and bun:sqlite adapters. Read-only mode must not run write PRAGMAs, migrations, checkpoints, or writer shutdown hooks.
- [ ] Add `sqliteMutationReceipts` and a monotonic database version row/table to `src/lib/db/schema.js`; bump `SCHEMA_VERSION` exactly once.
- [ ] Ensure only control migrates and opens read-write. Worker readiness waits until control schema version, writer heartbeat, Redis health, and Go limiter health pass.
- [ ] Keep public `/ready` blocked. Extend only internal readiness; do not expose Redis status or secrets publicly.
- [ ] Run `node --test tests/unit/db-worker-migration-safety.test.mjs tests/unit/db-readonly-worker.test.mjs tests/unit/db-readiness*.test.mjs`.
- [ ] Commit `feat(db): add read-only SQLite worker adapter and readiness barrier`.

## Task 3: Mutation Protocol and Single-Writer Consumer

- [ ] Add protocol tests for known type only, schema version, stable receipt ID, payload byte cap, JSON shape, secret/header/body rejection, and receipt retention rules.
- [ ] Implement the smallest allowlisted typed command union. Initial types: `usage.save`, `requestDetail.save`, `footerLog.add`; do not accept arbitrary SQL or dynamic repo/function names.
- [ ] Implement `enqueueMutation(command, { consistency })`. `async` resolves only after Redis acknowledges `XADD`; `sync` waits for receipt result published after SQLite commit, with a bounded timeout and same-ID retry semantics.
- [ ] Implement one control-owned Streams consumer. In one SQLite transaction: insert unique receipt, apply mutation through handlers, increment DB version when needed, persist result. Only then `XACK`.
- [ ] On replay, duplicate receipt is a no-op with prior result. Reclaim pending work after restart. Retry transient SQLite busy only. Route invalid/exhausted messages to dead letter; never acknowledge uncommitted mutation.
- [ ] Add real Redis+SQLite integration checks for duplicate delivery, kill after DB commit/before XACK, Redis restart, poison command, bounded queue, and observable backpressure.
- [ ] Commit `feat(redis): add idempotent SQLite mutation stream writer`.

## Task 4: Move Request Telemetry Writes

- [ ] Add failing parity tests for usage history, daily aggregation, lifetime count, request details, footer logs; include duplicated delivery and same timestamp edge cases.
- [ ] Route worker-role `saveRequestUsage`, `saveRequestDetail`, provider footer persistence and API-generated request logs through typed async mutations. Keep direct write path for control/single-process mode.
- [ ] Do not enqueue raw request/response bodies, authorization data, API keys, cookies, or unredacted footer content. Preserve request detail truncation and sanitization before XADD.
- [ ] Add explicit telemetry-loss counters when enqueue is impossible. Correctness mutations must not use this best-effort policy.
- [ ] Compare output DB snapshots from single-process and Redis-worker modes on real SQLite integration fixture and report exact differences.
- [ ] Commit `feat(db): persist worker request telemetry through SQLite writer`.

## Task 5: Route Provider-State Mutations and OAuth Refresh Safely

- [ ] Add a mutation audit test that enumerates every `updateProviderConnection` call reachable from API-worker routes. Classify each as synchronous correctness or control-only; unknown mutation fails test.
- [ ] Add a dedicated authenticated encryption primitive and separate rotatable `SQLITE_QUEUE_ENCRYPTION_KEY`. Never reuse `API_KEY_SECRET` or Redis ACL password. Until available, keep token-bearing connection updates control-only and exclude providers requiring them from workers.
- [ ] Route provider health, cooldown, model-lock, credential changes, and API-side authorization changes synchronously: commit acknowledgement first, then re-read versioned SQLite data before continuing.
- [ ] Implement Redis lock via unique owner token and atomic compare-and-delete script for refresh ownership. Enforce TTL, bounded renewal, request cancellation, and read-after-lock; no local mutex fallback in multicore.
- [ ] Add concurrency tests with two worker processes racing a single-use refresh token. Assert one upstream refresh and one committed token version.
- [ ] Commit `feat(auth): serialize worker credential mutations and refresh locks`.

## Task 6: Cache Coherence and Global Routing State

- [ ] Inventory and test connection/settings/API-key/model/pricing/alias cache usage. Every correctness-critical cache must read committed SQLite version before reuse; Pub/Sub alone is insufficient.
- [ ] Increment database config version in the same SQLite mutation transaction; publish wake-up event after commit. Test crash between commit and publish, worker Redis reconnect, and missed invalidation.
- [ ] Move provider account sticky round-robin, combo rotation, and proxy-pool rotation to atomic Redis operations keyed by installation and logical scope. Redis failure must mark worker unready, never fall back to local maps/mutex.
- [ ] Revalidate selected account/model against current SQLite version before dispatch; Go limiter still enforces actual RPM/concurrency.
- [ ] Create explicit worker eligibility list. Unknown/stateful session-backed providers remain control-only. Test affinity/session continuity or ensure they bypass API worker routing.
- [ ] Commit `feat(redis): share routing state and version critical caches`.

## Task 7: Integrate Worker Readiness and Go Gateway Failover

- [ ] Add failing Go tests for eligible worker, unready worker, Redis/writer-down worker, healthy control fallback, and control-down 503 behavior.
- [ ] Expose readiness only over internal loopback worker probes. Report bounded booleans/counters only, no URLs with credentials, secrets, payloads, or token data.
- [ ] Gateway must stop sending new work to workers if Redis or writer barrier fails; fall back to control only when control is explicitly healthy in direct-write mode. Never replay a request after response headers or stream bytes started.
- [ ] Verify health/dashboard/control routes remain control-only; public `/ready` remains 404; stream abort still releases Go limiter leases.
- [ ] Run Go race tests and real multi-process integration with two native read-only SQLite API workers and one control writer.
- [ ] Commit `feat(gateway): gate SQLite API workers on writer readiness`.

## Task 8: Docker Deployment and Operator Controls

- [ ] Add Redis service only behind `sqlite-multicore` profile. No host port; ACL credential from Docker secret/env; AOF enabled, `appendfsync everysec`, persistent volume, no-eviction policy, memory cap, health check.
- [ ] Generate explicit `.env` activation settings in installer; profile disabled means current single-process SQLite default is unchanged. Validate bundled/external Redis modes and refuse unsafe persistence config.
- [ ] Ensure shutdown order: stop accepting worker requests, drain streams, stop workers, flush writer consumer, then stop Redis. Preserve 330-second app stream drain.
- [ ] Add docs for telemetry loss semantics, up to one-second Redis persistence loss window, backups, restore/replay, metrics, rollback to one worker, PostgreSQL alternative.
- [ ] Add rendered Compose and disposable container tests, installer regression tests, env-secret redaction checks.
- [ ] Commit `feat(docker): add opt-in private Redis for SQLite workers`.

## Task 9: End-to-End Acceptance and Hold Production Rollout

- [ ] `npm run verify`, production build, Docker Compose config, all focused unit/integration tests, `cd hybrid-engine && go test -race ./... && go vet ./...`.
- [ ] Exercise real SQLite + Redis + control + 2 API workers: requests, upstream model/recent request, usage aggregates, request details, queue/lease cancellation, refresh concurrency, provider/combo fairness, provider eligibility, Redis restart, writer restart, worker kill, duplicate receipt, backlog and recovery.
- [ ] Assert exactly one SQLite read-write handle; workers read-only; zero unauthorized writes; zero stuck Go leases; no unresolved version lag; exact correctness mutation parity; telemetry loss within declared threshold; SQLite integrity check passes.
- [ ] Recheck real public interfaces and security boundaries: health/models 200, usage unauthenticated 401, malformed request 400, internal readiness 200 only on loopback, public `/ready` 404, Redis port inaccessible externally.
- [ ] Record whole-result evidence and independent code review. If Docker/Redis or credentials unavailable, mark only affected acceptance blocked; do not substitute mock evidence.
- [ ] Keep production `API_WORKERS=1`; do not deploy/restart. Real canary requires dedicated bounded `SOAK_API_KEY`, separate operator approval, and 24-hour observation.
- [ ] Commit final test evidence/docs. Report implementation stage and explicit remaining gates.

## Self-Review

- No SQLite worker startup before explicit opt-in and healthy Redis, writer, migration, native adapter, and Go limiter.
- Every worker-side mutation is classified; arbitrary SQL is never sent over Redis.
- Receipt insertion, DB mutation, and version increment are one SQLite transaction. ACK follows commit only.
- Async telemetry policy is explicitly best-effort; credentials/routing changes wait for committed receipt.
- Cache invalidation survives missed Pub/Sub through SQLite version checks.
- Redis does not become a second limiter or distributed SQLite writer.
- Provider/session state not proven safe stays control-only.
- Production deployment is deliberately excluded from implementation task.
