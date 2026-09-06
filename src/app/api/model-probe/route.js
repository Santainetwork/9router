import { NextResponse } from "next/server";
import { getProviderConnectionById, getProviderConnections, getProviderNodes } from "@/lib/localDb";
import { DEFAULT_BASELINES, resolveClaimedModel } from "@/shared/utils/modelProbe";

export const dynamic = "force-dynamic";
export const maxDuration = 180; // 3 minutes timeout

const BAZAARLINK_API = "https://bazaarlink.ai/api/probe/run";
const BAZAARLINK_BASELINES_API = "https://bazaarlink.ai/api/probe/baselines";

let cachedBaselines = null;
let lastBaselinesFetch = 0;

async function fetchBaselines() {
  const now = Date.now();
  if (cachedBaselines && now - lastBaselinesFetch < 10 * 60 * 1000) {
    return cachedBaselines;
  }
  try {
    const res = await fetch(BAZAARLINK_BASELINES_API, { cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data?.models) && data.models.length > 0) {
        cachedBaselines = data.models;
        lastBaselinesFetch = now;
        return cachedBaselines;
      }
    }
  } catch {}
  cachedBaselines = DEFAULT_BASELINES;
  return cachedBaselines;
}

// GET /api/model-probe - List available provider connections or poll active run status
export async function GET(request) {
  try {
    const url = new URL(request.url);
    const runId = url.searchParams.get("runId");

    // If runId is provided, proxy poll status from BazaarLink
    if (runId) {
      const res = await fetch(`https://bazaarlink.ai/api/probe/run/${encodeURIComponent(runId)}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return NextResponse.json(
          { error: data.error || data.message || `Failed to fetch run status (HTTP ${res.status})` },
          { status: res.status }
        );
      }
      return NextResponse.json(data);
    }

    // Default: return available connections and official baselines
    const [conns, nodes, baselines] = await Promise.all([
      getProviderConnections().catch(() => []),
      getProviderNodes().catch(() => []),
      fetchBaselines().catch(() => DEFAULT_BASELINES),
    ]);

    const nodeMap = new Map((nodes || []).map((n) => [n.id, n]));

    const items = (conns || [])
      .filter((c) => c.isActive !== false)
      .map((c) => {
        const node = nodeMap.get(c.provider);
        const baseUrl = c.providerSpecificData?.baseUrl || node?.data?.baseUrl || "";
        const apiKey = c.apiKey || "";
        return {
          id: c.id,
          name: c.name || c.email || c.provider,
          provider: c.provider,
          providerName: node?.name || c.provider,
          baseUrl,
          hasApiKey: !!apiKey,
          defaultModel: c.defaultModel || "",
        };
      })
      .filter((c) => c.baseUrl && c.hasApiKey);

    return NextResponse.json({ connections: items, baselines });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// POST /api/model-probe - Run BazaarLink probe
export async function POST(request) {
  try {
    const body = await request.json();
    let {
      connectionId,
      baseUrl,
      apiKey,
      modelId,
      claimedModel,
      upstreamFormat,
      mode = "fast",
      runContextCheck = false,
      lang,
      sync = false,
    } = body;

    if (connectionId) {
      const conn = await getProviderConnectionById(connectionId);
      if (!conn) {
        return NextResponse.json({ error: "Connection not found" }, { status: 404 });
      }
      const nodes = await getProviderNodes().catch(() => []);
      const node = nodes.find((n) => n.id === conn.provider);

      baseUrl = baseUrl || conn.providerSpecificData?.baseUrl || node?.data?.baseUrl || "";
      apiKey = apiKey || conn.apiKey || "";
      modelId = modelId || conn.defaultModel || "";
      if (!upstreamFormat) {
        if (conn.provider?.includes("anthropic") || baseUrl.includes("/messages")) {
          upstreamFormat = "anthropic";
        }
      }
    }

    if (!baseUrl || !apiKey || !modelId) {
      return NextResponse.json(
        { error: "baseUrl, apiKey, and modelId are required" },
        { status: 400 }
      );
    }

    const baselines = await fetchBaselines();
    const effectiveClaimedModel = resolveClaimedModel(claimedModel, modelId, baselines);

    const payload = {
      baseUrl: baseUrl.replace(/\/+$/, ""),
      apiKey,
      modelId: modelId.trim(),
      claimedModel: effectiveClaimedModel,
      upstreamFormat: upstreamFormat === "anthropic" ? "anthropic" : "openai",
      quickMode: mode === "fast",
      identityOnly: mode === "fast",
      sync: sync === true,
    };

    if (runContextCheck) payload.runContextCheck = true;
    if (lang) payload.lang = lang;

    const res = await fetch(BAZAARLINK_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(sync === true ? 180_000 : 30_000),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json(
        { error: data.error || data.message || `Probe failed with HTTP ${res.status}` },
        { status: res.status }
      );
    }

    return NextResponse.json(data);
  } catch (err) {
    console.error("[Model Probe Error]", err);
    return NextResponse.json(
      { error: err.message || "Failed to execute model probe" },
      { status: 500 }
    );
  }
}
