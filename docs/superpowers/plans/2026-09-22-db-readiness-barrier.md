# Database-Ready Barrier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make control, workers, and the Go gateway become ready only after their configured database and required schema are usable, without changing public `/api/health`.

**Architecture:** Add a small DB readiness probe plus `GET /api/ready`. Keep the endpoint loopback-only in middleware and explicitly return 404 at the public Go gateway. Change worker monitoring, Go readiness, and installer startup checks from liveness to readiness.

**Tech Stack:** Next.js route handlers, existing DB adapter, Bash/systemd installer, Go reverse proxy, Node test runner, Go testing.

---

### Task 1: Database readiness probe and internal endpoint

**Files:**
- Create: `src/lib/db/readiness.js`
- Create: `src/app/api/ready/route.js`
- Create: `tests/unit/db-readiness.test.mjs`
- Modify: `src/lib/db/driver.js`

- [ ] Write failing tests for: current schema returns ready, missing/old/invalid schema returns not ready, adapter failure returns not ready without leaking error text, and failed adapter initialization can retry.
- [ ] Run `node --test tests/unit/db-readiness.test.mjs`; expect failure because the probe does not exist.
- [ ] Implement `checkDatabaseReady()` using `getAdapter()`, `_meta.schemaVersion`, `SCHEMA_VERSION`, stable reason strings, database type only, and latency.
- [ ] Make `getAdapter()` clear a rejected `initPromise`, allowing a later readiness probe to recover without restarting the process.
- [ ] Add `GET /api/ready`: 200 for ready, 503 otherwise, `Cache-Control: no-store`.
- [ ] Re-run the focused test; expect all pass.

### Task 2: Keep readiness internal

**Files:**
- Modify: `src/dashboardGuard.js`
- Modify: `hybrid-engine/pkg/proxy/proxy.go`
- Modify: `tests/unit/dashboard-guard.test.js`
- Modify: `hybrid-engine/pkg/proxy/proxy_test.go`

- [ ] Write failing tests: direct trusted-loopback `/api/ready` passes middleware; remote request receives 404; gateway mode `/api/ready` returns 404 without contacting upstream.
- [ ] Run the Node and Go focused tests; expect failure.
- [ ] Add `/api/ready` as an explicit middleware local-only branch returning 404 remotely.
- [ ] Add an explicit master-gateway deny for `/api/ready` before forwarding.
- [ ] Re-run focused tests; expect all pass.

### Task 3: Route dependency health through DB readiness

**Files:**
- Modify: `hybrid-engine/cmd/engine/main.go`
- Modify: `hybrid-engine/cmd/engine/readiness_test.go`
- Modify: `hybrid-engine/pkg/proxy/proxy.go`
- Modify: `hybrid-engine/pkg/proxy/proxy_test.go`
- Modify: `scripts/install.sh`
- Modify: `tests/unit/install-script-safety.test.mjs`

- [ ] Change Go tests to require `/api/ready` for the upstream readiness handler and worker health monitor, including 503 rejection.
- [ ] Change installer tests to require `/api/ready` for control, each worker, and final engine readiness; retain `/api/health` as the public liveness smoke check.
- [ ] Run focused tests; expect failure.
- [ ] Switch the Go probe paths and installer readiness loops to `/api/ready`.
- [ ] Re-run focused tests; expect all pass.

### Task 4: Whole-result verification

**Files:**
- Modify: `docs/superpowers/specs/2026-09-22-db-readiness-barrier-design.md`

- [ ] Run focused Node and Go tests.
- [ ] Run `npm run verify`, `npm run build`, `go test ./... -race`, `go vet ./...`, `bash -n`, and `systemd-analyze verify`.
- [ ] Build the tracked Go binary and assert it matches a fresh source build.
- [ ] Run an isolated PostgreSQL stack through transient systemd. Observe `/api/ready` 200, public gateway `/api/ready` 404, workers excluded while schema/DB is unavailable, routing enabled after readiness, and clean shutdown.
- [ ] Verify production remains active single-control and untouched.
- [ ] Record evidence in the design document, request independent review, commit the verified diff.
