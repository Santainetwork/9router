# Settings Worker Topology Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the configured Node process and API worker counts in Settings without exposing internal URLs or adding runtime controls.

**Architecture:** Add a pure environment-to-metadata helper in the existing system-health utility. Include its sanitized output only in the admin-protected `GET /api/settings`, pass it into the existing `SystemHealthPanel`, then render it there. Do not persist topology in DB or expose it through public liveness.

**Tech Stack:** Next.js App Router, React, Node.js built-in test runner.

---

### Task 1: Define worker topology metadata with TDD

**Files:**
- Modify: `tests/unit/system-health.test.mjs`
- Modify: `src/shared/utils/systemHealth.js`
- Modify: `src/app/api/settings/route.js`

- [ ] Add failing tests for `getWorkerTopology(env)`:
  - default gives `{ role: "control", totalProcesses: 1, apiWorkers: 0, mode: "single-process" }`
  - PostgreSQL plus `API_WORKERS=4` gives three API workers and `postgres-multicore`
  - SQLite plus `API_WORKERS=4` fails closed to one total process and `single-process`
  - invalid, zero, negative, or above-eight values fail closed to one
  - no returned key contains `URL`, password, or credential values.
- [ ] Run `node --test tests/unit/system-health.test.mjs`; confirm RED because helper is absent.
- [ ] Implement and export `getWorkerTopology(env = process.env)` in `src/shared/utils/systemHealth.js` using no new dependency.
- [ ] Add `workerTopology: getWorkerTopology()` only to the safe response object returned by `GET /api/settings`.
- [ ] Strip `workerTopology` from PATCH request bodies before `updateSettings`, keeping it read-only.
- [ ] Re-run test; expect PASS.

### Task 2: Render metadata in Settings

**Files:**
- Modify: `tests/unit/system-health.test.mjs`
- Modify: `src/app/(dashboard)/dashboard/profile/page.js`
- Modify: `src/shared/components/SystemHealthPanel.js`

- [ ] Add failing source assertions for labels `Node processes`, `API workers`, `Topology`, and `Configured at startup`.
- [ ] Run focused test; confirm RED.
- [ ] Pass `settings.workerTopology` into `<SystemHealthPanel workerTopology={settings.workerTopology} />`.
- [ ] Read the `workerTopology` prop, defaulting presentation to one total process, zero API workers, and `single-process`.
- [ ] Add three rows to the existing Next Backend card. Add a short `Configured at startup` note. Keep health polling unchanged.
- [ ] Re-run focused test; expect PASS.

### Task 3: Verification and commit

**Files:**
- Verify: `src/app/api/settings/route.js`
- Verify: `src/app/(dashboard)/dashboard/profile/page.js`
- Verify: `src/shared/utils/systemHealth.js`
- Verify: `src/shared/components/SystemHealthPanel.js`
- Verify: `tests/unit/system-health.test.mjs`

- [ ] Run:

```bash
node --test tests/unit/system-health.test.mjs tests/unit/systemd-worker-topology.test.mjs
npm run verify
npm run build
git diff --check
```

- [ ] Confirm `/api/health` public and detail bodies both exclude `workerTopology`; admin `GET /api/settings` includes it.
- [ ] Commit:

```bash
git add src/app/api/settings/route.js 'src/app/(dashboard)/dashboard/profile/page.js' src/shared/utils/systemHealth.js src/shared/components/SystemHealthPanel.js tests/unit/system-health.test.mjs
git commit -m "feat(settings): show configured worker topology"
```

- [ ] Independent spec review, then code-quality review. Resolve all findings.
- [ ] Do not deploy, restart, push, or edit systemd state.
