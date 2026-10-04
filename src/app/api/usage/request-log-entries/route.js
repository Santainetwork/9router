import { NextResponse } from "next/server";
import { isAuthenticated } from "@/dashboardGuard";
import { getRequestLogs } from "@/lib/db/repos/requestLogsRepo.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  if (!await isAuthenticated(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const params = new URL(request.url).searchParams;
    const page = Number(params.get("page") || 1);
    const pageSize = Number(params.get("pageSize") || 50);
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) {
      return NextResponse.json({ error: "Invalid pagination" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json(await getRequestLogs({
      page, pageSize, apiKeyId: params.get("apiKeyId"), status: params.get("status"),
      endpointKind: params.get("endpointKind"), search: params.get("search")?.slice(0, 200) || null,
    }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[API] request logs fetch failed:", error);
    return NextResponse.json({ error: "Failed to fetch request logs" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
