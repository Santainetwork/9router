# Queue Leases and PostgreSQL API Workers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove long-lived limiter leaks, harden stream cancellation, then add opt-in PostgreSQL-only API workers.

**Architecture:** First make Go limiter ownership explicit with opaque lease IDs. Next centralize stream finalization so every terminal path releases leases exactly once. Only then add separate API workers, keeping one control-plane process and SQLite single-process.

**Tech Stack:** Go HTTP server, Go mutexes/channels, Node.js Web Streams, Next.js standalone, systemd, Docker Compose, PostgreSQL/SQLite.

---

## Task 1: Lease protocol model and tests

**Files:**
- Modify: `hybrid-engine/pkg/limiter/limiter.go`
- Test: `hybrid-engine/pkg/limiter/limiter_test.go`

- [ ] Add failing tests for lease ownership, duplicate release, grant-vs-timeout, grant-vs-cancel, reset waiters, and mixed-age watchdog leases. Tests must assert `activeConcurrency` never exceeds the number of owned leases and queued waiters never retain a granted slot.
- [ ] Run `cd hybrid-engine && go test ./pkg/limiter`; confirm the new tests fail against anonymous `Release(scope,key)` behavior.
- [ ] Change `Waiter` to carry an ownership result and explicit state protected by `Bucket.mu`. Add an opaque lease ID type/string and `activeLeases map[string]time.Time` to `Bucket`.
- [ ] Make grant transition remove the waiter, create one lease, then signal the waiter. Make timeout/cancel transition the waiter under the same lock. If grant won before timeout/cancel observes it, return the lease to the caller; otherwise no lease is created.
- [ ] Change the internal release path to `Release(scope, key, leaseID string)`. Make unknown and duplicate lease IDs no-ops with a metric counter. Keep a short compatibility method only if current callers require it, and never use it for new code.
- [ ] Make watchdog expire lease IDs individually. Make `Reset` clear leases and cancel waiters without granting new ownership to disconnected callers.
- [ ] Run `cd hybrid-engine && go test ./pkg/limiter && go test -race ./pkg/limiter`.
- [ ] Commit: `git commit -m "fix(limiter): make concurrency slots lease-owned"`.

## Task 2: Propagate leases through Go HTTP and Node client

**Files:**
- Modify: `hybrid-engine/cmd/engine/main.go`
- Modify: `open-sse/services/hybrid/goLimiterClient.js`
- Modify: `open-sse/services/rateLimiter.js`
- Test: `hybrid-engine/pkg/limiter/limiter_test.go`
- Test: `tests/unit/abort-concurrency-leak.test.mjs`

- [ ] Add a failing HTTP-level test or handler test asserting `/v1/limiter/acquire` returns a lease ID and `/v1/limiter/release` requires that lease ID.
- [ ] Run the focused test and observe failure because acquire currently returns only `{allowed:true}`.
- [ ] Return `{allowed:true, leaseId}` for concurrency grants. Accept `leaseId` in release requests and pass it to the engine. Do not expose raw API keys or lease IDs in logs or dashboard snapshots.
- [ ] Update `goAcquire` to return a release callback that sends the captured lease ID. Ensure callback idempotence remains local and network errors are retried once with a short timeout.
- [ ] Update JS fallback release callbacks to use equivalent unique lease ownership within the process. Keep Go as the shared limiter when hybrid mode is enabled.
- [ ] Run `node --test tests/unit/abort-concurrency-leak.test.mjs` and `cd hybrid-engine && go test -race ./...`.
- [ ] Commit: `git commit -m "feat(limiter): propagate lease ids through bridge"`.

## Task 3: Harden stream finalization

**Files:**
- Modify: `open-sse/utils/streamHandler.js`
- Modify: `open-sse/handlers/chatCore.js`
- Modify: `src/sse/handlers/chat.js`
- Test: `tests/unit/abort-concurrency-leak.test.mjs`
- Test: `tests/unit/responses-abort-terminal.test.js`

- [ ] Add failing tests for client abort before first byte, mid-stream cancellation, terminal-frame cancellation, and repeated cancellation. Assert API-key and provider release callbacks each run once and no unhandled rejection is emitted.
- [ ] Run the focused tests and confirm the locked-reader failure or missing release is observable.
- [ ] Implement one idempotent finalizer in `chatCore.js` covering complete, error, disconnect, and cancellation. Call it before asynchronous usage persistence.
- [ ] In `createDisconnectAwareStream`, guard reader cancellation and writer abort against already-locked/closed states. Attach rejection handlers to every cancellation promise. Clear stall timers from `pull`, `cancel`, `close`, and error paths.
- [ ] Preserve terminal SSE behavior. Never replay a streaming POST after headers are sent.
- [ ] Run `node --test tests/unit/abort-concurrency-leak.test.mjs tests/unit/responses-abort-terminal.test.js`.
- [ ] Commit: `git commit -m "fix(stream): finalize cancelled requests safely"`.

## Task 4: Add limiter and stream telemetry

**Files:**
- Modify: `hybrid-engine/pkg/limiter/limiter.go`
- Modify: `hybrid-engine/cmd/engine/main.go`
- Modify: `src/app/api/v1/usage/route.js`
- Test: `hybrid-engine/pkg/limiter/limiter_test.go`

- [ ] Add counters for grants, releases, expiries, timeouts, cancellations, unknown releases, oldest waiter age, and active lease count.
- [ ] Add a test proving snapshot identifiers remain hashed and counters do not include raw keys or lease IDs.
- [ ] Expose counters in internal health/snapshot only. Keep public usage response limited to existing live concurrency fields plus safe queue age/count.
- [ ] Run `cd hybrid-engine && go test -race ./...` and the focused usage route tests.
- [ ] Commit: `git commit -m "feat(telemetry): expose limiter lease health"`.

## Task 5: Introduce API worker role without enabling it

**Files:**
- Modify: `custom-server.js`
- Modify: `deploy/docker-entrypoint.sh`
- Modify: `hybrid-engine/pkg/proxy/proxy.go`
- Modify: `hybrid-engine/cmd/engine/main.go`
- Test: `tests/unit/install-docker-safety.test.mjs`
- Test: `hybrid-engine/pkg/proxy/proxy_test.go`

- [ ] Add failing configuration tests: SQLite with `API_WORKERS>1` must refuse startup; PostgreSQL with `WORKER_ROLE=api` must disable control-plane startup hooks.
- [ ] Run the tests and confirm no worker-role guard exists.
- [ ] Add `WORKER_ROLE=control|api`, default `control`, and `API_WORKERS=1`, default one. Require `DATABASE_URL` or `DB_TYPE=postgres` for API worker role/count above one. Fail closed with an actionable error.
- [ ] Add loopback backend registration/health checks in Go. Keep dashboard/admin routes on control. Route only `/v1/`, `/v2/`, `/api/v1/`, and `/api/v2/` to healthy API workers. Do not retry an already-started stream.
- [ ] Keep Go limiter single/shared. Do not add Node `cluster` or `worker_threads`.
- [ ] Run `cd hybrid-engine && go test -race ./...` and installer safety tests.
- [ ] Commit: `git commit -m "feat(worker): add PostgreSQL-only API worker role"`.

## Task 6: Wire deployment and singleton safeguards

**Files:**
- Modify: `deploy/docker-entrypoint.sh`
- Modify: `docker-compose.yml`
- Modify: `scripts/install-docker.sh`
- Modify: `systemd/9router.service` or the repository's generated service template
- Modify: `DOCKER.md`
- Test: `tests/unit/install-docker-safety.test.mjs`

- [ ] Add failing deployment tests for `WORKER_ROLE`, `API_WORKERS`, SQLite default, and one control worker.
- [ ] Add environment propagation. Control starts dashboard, auth, tunnel, MITM, MCP, quota auto-ping, and token refresh. API workers start only request handling and shared DB access.
- [ ] Keep Docker SQLite default with one process. Add documented PostgreSQL worker example with two API workers and one control process. Document rollback by setting `API_WORKERS=1`.
- [ ] Run `node --test tests/unit/install-docker-safety.test.mjs`, `docker compose config --quiet`, and shell syntax checks.
- [ ] Commit: `git commit -m "docs(deploy): document PostgreSQL API workers"`.

## Task 7: Full verification and staged rollout

**Files:**
- Modify: `DOCKER.md` only if verification commands need correction.

- [ ] Run `npm run verify`.
- [ ] Run `cd hybrid-engine && go test -race ./... && go vet ./...`.
- [ ] Build Docker image and inspect `ENTRYPOINT`, worker role, and health endpoints.
- [ ] Run representative streaming abort load, queue stress, and a short soak. Verify no orphan leases, queue age remains bounded, RSS/event-loop lag are measured, and API workers distribute requests.
- [ ] For production, enable only on PostgreSQL canary, observe 24 hours, then expand from two to four workers only if CPU/event-loop data justifies it. Keep SQLite single-worker.
- [ ] Commit only verified changes and push to `origin/master`.
