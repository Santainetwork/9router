import { NextResponse } from "next/server";
import {
  queueSnapshot,
  getBucketDetail,
  resetActiveConcurrency,
  resetAllActiveConcurrency,
} from "open-sse/services/rateLimiter.js";
import { getApiKeys, getProviderConnections } from "@/lib/localDb";

export const dynamic = "force-dynamic";

function maskKey(k) {
  if (!k) return "";
  if (k.length <= 8) return k;
  return `${k.slice(0, 4)}...${k.slice(-4)}`;
}

// GET /api/queue - Complete view of all RPM limits, Concurrency limits, and live Queue status.
export async function GET() {
  const snap = queueSnapshot();

  const [keys, conns] = await Promise.all([
    getApiKeys().catch(() => []),
    getProviderConnections().catch(() => []),
  ]);

  const allKeys = (keys || []).map((k) => {
    const detail = getBucketDetail("apikey", k.id);
    const rpm = Number(k.rpm) || 0;
    const concurrency = Number(k.concurrency) || 0;
    const queueTimeoutMs = Number(k.queueTimeoutMs) || 0;
    const active = detail.activeConcurrency || 0;
    const queued = detail.queued || 0;

    let status = "idle";
    if (!k.isActive) status = "disabled";
    else if (queued > 0) status = "queued";
    else if (concurrency > 0 && active >= concurrency) status = "full";
    else if (active > 0) status = "in_flight";
    else if (detail.inWindow > 0) status = "active";

    return {
      id: k.id,
      name: k.name || "Unnamed Key",
      maskedKey: maskKey(k.key),
      isActive: k.isActive !== false,
      rpm,
      concurrency,
      queueTimeoutMs,
      activeConcurrency: active,
      inWindow: detail.inWindow || 0,
      queued,
      windowResetInMs: detail.windowResetInMs || 0,
      status,
    };
  });

  const allProviders = (conns || []).map((c) => {
    const detail = getBucketDetail("provider", c.id);
    const rpm = Number(c.rpm) || 0;
    const concurrency = Number(c.concurrency) || 0;
    const queueTimeoutMs = Number(c.queueTimeoutMs) || 0;
    const active = detail.activeConcurrency || 0;
    const queued = detail.queued || 0;

    let status = "idle";
    if (!c.isActive) status = "disabled";
    else if (queued > 0) status = "queued";
    else if (concurrency > 0 && active >= concurrency) status = "full";
    else if (active > 0) status = "in_flight";
    else if (detail.inWindow > 0) status = "active";

    return {
      id: c.id,
      provider: c.provider,
      name: c.name || c.email || c.provider,
      isActive: c.isActive !== false,
      rpm,
      concurrency,
      queueTimeoutMs,
      activeConcurrency: active,
      inWindow: detail.inWindow || 0,
      queued,
      windowResetInMs: detail.windowResetInMs || 0,
      status,
    };
  });

  const keyMap = new Map(allKeys.map((k) => [k.id, k.name]));
  const connMap = new Map(allProviders.map((c) => [c.id, c.name]));

  const activeBuckets = snap.buckets.map((b) => ({
    ...b,
    label:
      b.scope === "apikey"
        ? keyMap.get(b.key) || b.key
        : connMap.get(b.key) || b.key,
  }));

  const apiKeyBuckets = activeBuckets.filter((b) => b.scope === "apikey");
  const providerBuckets = activeBuckets.filter((b) => b.scope === "provider");

  return NextResponse.json({
    totalQueued: snap.totalQueued,
    totalActiveWindows: snap.totalActiveWindows,
    totalActiveConcurrent: snap.totalActiveConcurrent,
    buckets: activeBuckets,
    activeBuckets,
    apiKeys: {
      total: allKeys.length,
      totalQueued: allKeys.reduce((acc, k) => acc + k.queued, 0),
      totalActiveConcurrent: allKeys.reduce((acc, k) => acc + k.activeConcurrency, 0),
      activeBuckets: apiKeyBuckets.length,
      buckets: apiKeyBuckets,
      items: allKeys,
      list: allKeys,
    },
    providers: {
      total: allProviders.length,
      totalQueued: allProviders.reduce((acc, c) => acc + c.queued, 0),
      totalActiveConcurrent: allProviders.reduce((acc, c) => acc + c.activeConcurrency, 0),
      activeBuckets: providerBuckets.length,
      buckets: providerBuckets,
      items: allProviders,
      list: allProviders,
    },
    at: new Date().toISOString(),
  });
}

// POST /api/queue - Admin action to reset stuck concurrency slots
export async function POST(request) {
  try {
    const body = await request.json();
    const { action, scope, key } = body;

    if (action === "reset-all") {
      const cleared = resetAllActiveConcurrency();
      return NextResponse.json({ ok: true, message: `Cleared ${cleared} concurrency slots across all scopes.` });
    }

    if (action === "reset" && scope && key) {
      const cleared = resetActiveConcurrency(scope, key);
      return NextResponse.json({ ok: true, message: `Reset concurrency for ${scope}:${key}. Cleared ${cleared} slots.` });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
