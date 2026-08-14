import { NextResponse } from "next/server";
import { queueSnapshot } from "open-sse/services/rateLimiter.js";
import { getApiKeys, getProviderConnections } from "@/lib/localDb";

export const dynamic = "force-dynamic";

// GET /api/queue - Admin view of the live RPM queue. Shows how many requests
// are currently waiting for a slot (per API key / provider connection) plus the
// in-window usage. Same-origin admin auth (cookie / cli-token), like /api/keys.
export async function GET() {
  const snap = queueSnapshot();

  // Resolve friendly names so the admin sees "vscode" not a raw id.
  const [keys, conns] = await Promise.all([
    getApiKeys().catch(() => []),
    getProviderConnections().catch(() => []),
  ]);
  const keyName = new Map((keys || []).map((k) => [k.id, k.name || ""]));
  const connName = new Map(
    (conns || []).map((c) => [c.id, c.name || c.provider || ""])
  );

  const buckets = snap.buckets.map((b) => ({
    ...b,
    label:
      b.scope === "apikey"
        ? keyName.get(b.key) || b.key
        : connName.get(b.key) || b.key,
  }));

  return NextResponse.json({
    totalQueued: snap.totalQueued,
    totalActiveWindows: snap.totalActiveWindows,
    buckets,
    at: new Date().toISOString(),
  });
}
