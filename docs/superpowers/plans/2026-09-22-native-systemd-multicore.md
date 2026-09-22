# Native systemd Multi-Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Add safe PostgreSQL-only native systemd control plus API-worker supervision while preserving `API_WORKERS=1` defaults.

**Architecture:** Installer generates one control service, an instance worker template, a grouping target, per-instance runtime env files, and the Go gateway worker URL list. Control starts and becomes healthy before workers; workers become healthy before gateway restart.

**Tech Stack:** Bash, systemd, Node.js standalone Next.js, Go gateway, Node test runner.

---

### Task 1: Topology helper

**Files:** create `scripts/systemd-worker-topology.sh`; modify `tests/unit/install-script-safety.test.mjs`.

- [x] Add RED tests for PostgreSQL guard, ports 20131+, URL list, and max workers.
- [x] Implement pure validation/derivation and per-instance env generation.
- [x] Run focused topology and installer tests (43/43 pass).

### Task 2: Unit generation

**Files:** modify `scripts/install.sh`.

- [x] Preserve or accept `API_WORKERS`, default 1; validate before mutation.
- [x] Generate `9router-worker@.service`, `9router-worker-env@.service` (oneshot), `9router-workers.target`, engine `-api-workers` flag, and control singleton role.
- [x] Include worker template/target in backup, rollback, uninstall, dry-run, and management output.
- [x] Disable stale worker instances and enable exactly the desired instances.

### Task 3: Ordered health and failure behavior

**Files:** modify `scripts/install.sh`, tests.

- [x] Start control, verify `:20127`, start workers, verify each `/api/health`, restart engine.
- [x] Verify gateway, public portal, limiter, readiness and worker health; retain rollback gate.
- [x] Validate units using `systemd-analyze verify` with sandbox paths.

### Task 4: Whole-result acceptance

- [x] Focused Node tests pass (44/44).
- [x] Full Node verification (199 pass, 2 skip) and production build pass.
- [x] Go race/vet pass.
- [x] Isolated real control + 2 workers + gateway on disposable ports with local PostgreSQL and transient systemd: worker health, 6/6 API round-robin, dashboard control-only routing, failover, public proxy, limiter cancellation/release, and graceful shutdown passed.
- [x] Default SQLite/single-worker path remains unchanged (`API_WORKERS=1` default tested).
- [x] Independent safety/systemd reviews found no critical blocker; findings fixed and retested.
- [x] Commit changes and record evidence, without deploying production (`09e3fe5a`; acceptance follow-up separate).
