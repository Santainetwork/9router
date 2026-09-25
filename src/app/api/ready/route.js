import { NextResponse } from "next/server";
import { checkWorkerReady } from "@/lib/db/workerReadiness.js";
import { isSqliteMulticoreWorker } from "@/lib/db/driver.js";
import { getRedisManager } from "@/lib/redis/client.js";
import { isGoLimiterActive } from "open-sse/services/hybrid/goLimiterClient.js";
import { buildWorkerReadyDeps } from "@/lib/db/workerReadinessDeps.js";

export const dynamic = "force-dynamic";

// GET /api/ready -> 200 once the adapter is up and _meta.schemaVersion matches
// this build's SCHEMA_VERSION, 503 otherwise. Internal probe: the public Go
// gateway denies this path. The body stays driver-type only — never the
// connection string or raw driver errors.
export async function GET() {
  const deps = await buildWorkerReadyDeps({
    isWorker: isSqliteMulticoreWorker,
    redisManager: getRedisManager,
    limiterHealth: () => isGoLimiterActive({ force: true }),
  });
  const result = await checkWorkerReady(deps);
  return NextResponse.json(result, {
    status: result.ready ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
