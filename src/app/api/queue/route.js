import { NextResponse } from "next/server";
import {
  queueSnapshot,
  getBucketDetail,
  resetActiveConcurrency,
  resetAllActiveConcurrency,
} from "open-sse/services/rateLimiter.js";
import { isGoLimiterActive, goSnapshot, goReset } from "open-sse/services/hybrid/goLimiterClient.js";
import { getApiKeys, getProviderConnections } from "@/lib/localDb";

export const dynamic = "force-dynamic";

function maskKey(k) {
  if (!k) return "";
  if (k.length <= 8) return k;
  return `${k.slice(0, 4)}...${k.slice(-4)}`;
}

// GET /api/queue - Complete view of all RPM limits, Concurrency limits, and live Queue status.
export async function GET() {
  const isGoActive = await isGoLimiterActive().catch(() => false);
  const [goSnap, jsSnap, keys, conns] = await Promise.all([
    isGoActive ? goSnapshot().catch(() => null) : Promise.resolve(null),
    Promise.resolve(queueSnapshot()),
    getApiKeys().catch(() => []),
    getProviderConnections().catch(() => []),
  ]);

  const snap = (isGoActive && goSnap) ? goSnap : jsSnap;
  const goBucketMap = new Map();
  if (isGoActive && goSnap?.buckets) {
    for (const b of goSnap.buckets) {
      goBucketMap.set(`${b.scope}:${b.key}`, b);
    }
  }

  const allKeys = (keys || []).map((k) => {
    const detail = goBucketMap.get(`apikey:${k.id}`) || getBucketDetail("apikey", k.id);
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
    const detail = goBucketMap.get(`provider:${c.id}`) || getBucketDetail("provider", c.id);
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

  const rawBuckets = snap?.buckets || [];
  const activeBuckets = rawBuckets.map((b) => ({
    ...b,
    label:
      b.scope === "apikey"
        ? keyMap.get(b.key) || b.key
        : connMap.get(b.key) || b.key,
  }));

  const apiKeyBuckets = activeBuckets.filter((b) => b.scope === "apikey");
  const providerBuckets = activeBuckets.filter((b) => b.scope === "provider");

  const engine = isGoActive
    ? {
        type: "golang",
        name: "Golang Hybrid Engine",
        active: true,
        status: "healthy",
        port: 20129,
        url: process.env.GO_ENGINE_URL || "http://127.0.0.1:20129",
        version: "go-hybrid-v1",
        totalBuckets: snap?.totalBuckets ?? activeBuckets.length,
      }
    : {
        type: "javascript",
        name: "JavaScript In-Memory Limiter (Fallback)",
        active: false,
        status: "fallback",
        port: null,
        totalBuckets: activeBuckets.length,
      };

  return NextResponse.json({
    engine,
    totalQueued: snap?.totalQueued || 0,
    totalActiveWindows: snap?.totalActiveWindows || 0,
    totalActiveConcurrent: snap?.totalActiveConcurrent || 0,
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
      const [clearedJs, clearedGo] = await Promise.all([
        Promise.resolve(resetAllActiveConcurrency()),
        goReset().catch(() => 0),
      ]);
      const total = Math.max(clearedJs, clearedGo);
      return NextResponse.json({ ok: true, message: `Cleared ${total} concurrency slots across all scopes.` });
    }

    if (action === "reset" && scope && key) {
      const [clearedJs, clearedGo] = await Promise.all([
        Promise.resolve(resetActiveConcurrency(scope, key)),
        goReset(scope, key).catch(() => 0),
      ]);
      const total = Math.max(clearedJs, clearedGo);
      return NextResponse.json({ ok: true, message: `Reset concurrency for ${scope}:${key}. Cleared ${total} slots.` });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
