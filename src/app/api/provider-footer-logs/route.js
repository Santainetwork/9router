import { NextResponse } from "next/server";
import { getProviderFooterLogs, clearProviderFooterLogs, countProviderFooterLogs } from "@/lib/db/repos/providerFooterLogsRepo";

const RESPONSE_HEADERS = {
  "Cache-Control": "no-store"
};

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get("limit") || "20", 10);
    
    const logs = await getProviderFooterLogs(limit);
    const totalCount = await countProviderFooterLogs();
    
    return NextResponse.json({
      logs,
      totalCount,
      maxSize: 200
    }, { headers: RESPONSE_HEADERS });
  } catch (error) {
    console.error("Error getting provider footer logs:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const result = await clearProviderFooterLogs();
    return NextResponse.json(result, { headers: RESPONSE_HEADERS });
  } catch (error) {
    console.error("Error clearing provider footer logs:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    // Endpoint for refreshing logs (could be used for real-time updates in future)
    const logs = await getProviderFooterLogs(20);
    const totalCount = await countProviderFooterLogs();
    
    return NextResponse.json({
      logs,
      totalCount,
      maxSize: 200,
      refreshedAt: new Date().toISOString()
    }, { headers: RESPONSE_HEADERS });
  } catch (error) {
    console.error("Error refreshing provider footer logs:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}