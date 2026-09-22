import { NextResponse } from "next/server";
import { checkDatabaseReady } from "@/lib/db/readiness.js";

export const dynamic = "force-dynamic";

// GET /api/ready -> 200 once the adapter is up and _meta.schemaVersion matches
// this build's SCHEMA_VERSION, 503 otherwise. Internal probe: the public Go
// gateway denies this path. The body stays driver-type only — never the
// connection string or raw driver errors.
export async function GET() {
  const result = await checkDatabaseReady();
  return NextResponse.json(result, {
    status: result.ready ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
