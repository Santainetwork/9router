import { NextResponse } from "next/server";
import {
  getApiKeyByKey,
  getApiKeyTokenUsage,
  getApiKeyUsageInRange,
} from "@/lib/localDb";

export const dynamic = "force-dynamic";

// Self-service usage check. A caller authenticates with THEIR OWN API key
// (Bearer) and gets back only that key's limits + usage. Safe to expose over a
// public domain (Cloudflare -> Safeline WAF -> 9router): the raw key is never
// echoed and one key can never read another's data.
//
//   GET /api/v1/usage?period=1d|7d|30d   (default 7d, range 1-30 days)
//   Authorization: Bearer <api-key>   (or ?api_key= / x-api-key header)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, x-api-key",
};

function json(body, status = 200) {
  return NextResponse.json(body, { status, headers: CORS });
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

function extractKey(req) {
  const auth = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (m) return m[1].trim();
  const xk = req.headers.get("x-api-key");
  if (xk) return xk.trim();
  const qp = new URL(req.url).searchParams.get("api_key");
  return qp ? qp.trim() : "";
}

// Clamp requested period to 1..30 days. Accepts "1d".."30d" or a bare number.
function parsePeriodDays(raw) {
  const s = String(raw || "7d").trim().toLowerCase();
  const n = parseInt(s.replace(/d$/, ""), 10);
  if (!Number.isFinite(n)) return 7;
  return Math.max(1, Math.min(30, n));
}

export async function GET(req) {
  const key = extractKey(req);
  if (!key) {
    return json({ error: "Missing API key. Send 'Authorization: Bearer <key>'." }, 401);
  }

  const info = await getApiKeyByKey(key);
  if (!info) {
    return json({ error: "Invalid API key." }, 401);
  }
  if (!info.isActive) {
    return json({ error: "API key is disabled." }, 403);
  }

  const days = parsePeriodDays(new URL(req.url).searchParams.get("period"));
  const start = new Date();
  start.setDate(start.getDate() - days + 1);
  start.setHours(0, 0, 0, 0);

  const [allTimeUsed, ranged] = await Promise.all([
    getApiKeyTokenUsage(key),
    getApiKeyUsageInRange(key, start.toISOString()),
  ]);

  const quota = info.tokenQuota || 0;
  const remaining = quota > 0 ? Math.max(0, quota - allTimeUsed) : null;

  // Which models this key may call. Empty allowlist = unrestricted (all models).
  const restricted = info.allowedModels.length > 0;

  return json({
    key: {
      name: info.name,
      createdAt: info.createdAt,
    },
    limits: {
      requestsPerMinute: info.rpm || 0,        // 0 = unlimited
      queueTimeoutMs: info.queueTimeoutMs || 0, // 0 = provider default
      tokenQuota: quota,                        // 0 = unlimited
    },
    access: {
      restricted,                               // false = can use all models
      allowedModels: info.allowedModels,        // [] when unrestricted
    },
    usage: {
      tokensUsedAllTime: allTimeUsed,
      tokensRemaining: remaining,               // null = unlimited quota
      period: { days, since: start.toISOString() },
      requests: ranged.requests,
      promptTokens: ranged.promptTokens,
      completionTokens: ranged.completionTokens,
      totalTokens: ranged.totalTokens,
      byModel: ranged.byModel,
      byDay: ranged.byDay,
    },
  });
}
