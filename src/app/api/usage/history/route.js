import { NextResponse } from "next/server";
import { getUsageStats } from "@/lib/usageDb";

export async function GET() {
  try {
    const stats = await getUsageStats();
    return NextResponse.json(stats, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Error fetching usage stats:", error);
    return NextResponse.json({ error: "Failed to fetch usage stats" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
