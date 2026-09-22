# Database-Ready Barrier Design

## Problem

`/api/health` is a pure liveness probe: the route always returns HTTP 200 and its
public shape never touches the database adapter (`collectSystemHealth` reports
`database: { type }` from env only). The Go engine's `/ready` probes
`<upstream>/api/health`, and the worker health monitor probes `<worker>/api/health`.

Consequences in multi-process PostgreSQL mode:

- A control process that is up but has not finished migrations (or cannot reach
  PostgreSQL at all) still reports healthy.
- API workers start as soon as the control *unit* starts (`Requires=`, not
  health-gated) and then report healthy even though `_meta`/schema may be absent.
- The gateway therefore routes `/v1` traffic to workers that cannot serve it.

## Decision

Add one DB-backed readiness endpoint and make every dependency probe use it, while
leaving the public liveness contract untouched.

1. **`GET /api/ready`** (Next app, loopback listener `:20127`):
   - `await getAdapter()` bounded by a timeout, then read
     `SELECT value FROM _meta WHERE key = 'schemaVersion'`.
   - `200 {"ready":true,"database":...,"schemaVersion":N,"latencyMs":N}` when the
     adapter initialized and the schema marker exists.
   - `503 {"ready":false,"reason":"..."}` for adapter failure, timeout, or a
     missing schema marker (API worker whose control has not migrated yet).
   - Never reports the connection string; `database` stays the driver type only.
2. **`/api/health` is unchanged** (liveness, `ok: true`, component summary).
3. **Gateway front door denies `/api/ready`**: public `:20128/api/ready` returns
   404 even though the Next middleware allow-lists the path, so the endpoint stays
   internal. The public proxy `:20140` already 404s it (not in the allowed
   prefixes).
4. **Dependency probes switch to readiness**:
   - Go `readyHandler` probes `<upstream>/api/ready` instead of `/api/health`.
   - Go API-worker health monitor (`workerHealthURL`) probes `/api/ready`, so an
     unready worker is excluded from routing exactly like a dead one.
   - Installer control/worker waits and the final `check_http` readiness check use
     `/api/ready`.

## Why not reuse `isLocalRequest`

Route-level loopback checks depend on the peer-IP stamp, which already treats a
loopback hop as local in some configurations. The gateway deny is a positional
guarantee: the readiness payload can never be read from a public socket, no matter
who forged a forwarding header. The middleware allow-list entry is what lets the
loopback probes reach the handler.

## Ordering guarantee (barrier)

1. Control starts, migrates, writes `_meta.schemaVersion`.
2. `/api/ready` on `:20127` returns 200.
3. Workers start and each reports 200 only once it can see that schema.
4. Gateway's worker monitor probes `/api/ready` and only then routes `/v1` to them.
5. Installer fails the install (and rolls back on upgrade) if any step stays 503.

## Ceilings

- `adapter.get` runs through the synchronous `Atomics.wait` dispatch, so a query
  that hangs after the adapter exists blocks the event loop regardless of the
  readiness timeout. The timeout bounds adapter *initialization* only. Fixing the
  sync dispatch is out of scope here.
- Deployment topology: the guarantee holds while the Next server stays on
  loopback. Exposing `:20127` directly would re-expose `/api/ready`.

## Verification

| Check | Evidence |
|---|---|
| `/api/ready` pure probe truth table (ready, missing schema, adapter throw, timeout) | unit test with injected driver |
| `/api/health` public shape unchanged | existing `system-health` test still passes |
| `/api/ready` allow-listed in middleware | guard/locality unit test |
| Gateway 404s `/api/ready` publicly | Go proxy test |
| Go `/ready` probes `/api/ready`; worker monitor probes `/api/ready` | Go engine + proxy tests |
| Installer waits on `/api/ready` | `install-script-safety` assertions |
| Real PostgreSQL: ready 200; DB down: 503; worker not routed until ready | isolated acceptance rerun |
