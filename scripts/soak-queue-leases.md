# soak-queue-leases

Queue/lease soak-and-stress harness for the 9Router hybrid engine. Exercises the
Go master gateway (`:20128`) and limiter (`:20129`), then gates on concurrency
and queue leaks after the load settles.

Dependency-free Node >=22: stdlib `fetch`, `AbortController`, `node:fs` only.

## Quick start

```bash
SOAK_API_KEY=sk-... node scripts/soak-queue-leases.mjs          # full soak
SOAK_API_KEY=sk-... SOAK_DURATION_S=15 SOAK_CONCURRENCY=3 \
  node scripts/soak-queue-leases.mjs --phases=abort             # short smoke
node scripts/soak-queue-leases.mjs --dry-run                    # plan, no load
```

Without `SOAK_API_KEY` the chat phases are skipped, exit 0, `SKIPPED` banner.
`NINEROUTER_TEST_API_KEY` and `TEST_API_KEY` are also honored.

## Phases

- `abort` - `SOAK_CONCURRENCY` workers until `SOAK_DURATION_S` elapses;
  `SOAK_ABORT_RATE` fraction abort mid-stream (1-5 SSE chunks) via
  `AbortController`, the rest read to completion. Unique nonce per body.
- `queue` - fires `limit + 4` in-flight requests (limit from
  `/v1/limiter/bucket-detail`, else `SOAK_QUEUE_TARGET`), samples the snapshot
  every 500ms, records max queued. A 429 is expected, counted separately.
- `saturation` - holds `SOAK_CONCURRENCY` long streams open, samples every
  500ms, records peak active and flags any bucket over its declared
  concurrency (leak signal).

## Leak gate

After all phases the harness settles (polls until `totalActiveConcurrent` and
`totalQueued` return to baseline, 90s deadline), then fails (exit 1) if active
stays above baseline, `totalQueued` is non-zero, or any bucket reports
`activeConcurrency > concurrency`.

## Env

| var | default |
| --- | --- |
| `SOAK_BASE_URL` | `http://127.0.0.1:20128` |
| `SOAK_LIMITER_URL` | `http://127.0.0.1:20129` |
| `SOAK_MODEL` | `auto` |
| `SOAK_CONCURRENCY` | `6` |
| `SOAK_DURATION_S` | `60` |
| `SOAK_ABORT_RATE` | `0.35` |
| `SOAK_QUEUE_TARGET` | detected concurrency + 4 |
| `SOAK_ALLOW_RESET` | unset |

`--reset` is OPT-IN, refuses unless `SOAK_ALLOW_RESET=1`, POSTs
`/v1/limiter/reset`, prints `cleared`.
## Output

Human summary to stderr, `JCODE_PROGRESS {"percent":N,"message":...}` lines to
stdout, and a final single-line `SOAK_RESULT {json}` verdict. RSS
(router-engine, next-server via `/proc/<pid>/status VmRSS`) and p95/p99
latency are heuristic and labelled as such.
