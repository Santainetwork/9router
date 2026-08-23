import { NextResponse } from "next/server";
import { getRecentLogs } from "@/lib/usageDb";

export async function GET() {
  try {
    const logs = await getRecentLogs(200);
    return NextResponse.json(logs, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Error fetching logs:", error);
    return NextResponse.json({ error: "Failed to fetch logs" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
