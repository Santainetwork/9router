import { NextResponse } from "next/server";
import { collectSystemHealth } from "@/shared/utils/systemHealth.js";

export const dynamic = "force-dynamic";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

// GET /api/health            -> liveness + component summary (public, unchanged shape: ok + components)
// GET /api/health?detail=1   -> full diagnostics for the admin System Health panel
export async function GET(request) {
  const detail = new URL(request.url).searchParams.get("detail") === "1";

  let health = null;
  try {
    health = await collectSystemHealth({ detail });
  } catch (e) {
    health = { ok: true, at: new Date().toISOString(), error: e?.message || "collector failed" };
  }

  const body = {
    ok: true,
    engine: health.engine
      ? { type: health.engine.type, active: health.engine.active, status: health.engine.status }
      : null,
    nextBackend: health.nextBackend
      ? { ok: health.nextBackend.ok, latencyMs: health.nextBackend.latencyMs }
      : null,
    database: health.database ? { type: health.database.type } : null,
  };

  if (detail) Object.assign(body, health);

  return NextResponse.json(body, {
    status: 200,
    headers: { ...CORS_HEADERS, "Cache-Control": "no-store" },
  });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
