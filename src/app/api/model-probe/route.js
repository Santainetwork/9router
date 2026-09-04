import { NextResponse } from "next/server";
import { getProviderConnectionById, getProviderConnections, getProviderNodes } from "@/lib/localDb";

export const dynamic = "force-dynamic";
export const maxDuration = 180; // 3 minutes timeout

const BAZAARLINK_API = "https://bazaarlink.ai/api/probe/run";

// GET /api/model-probe - List available provider connections for quick select
export async function GET() {
  try {
    const [conns, nodes] = await Promise.all([
      getProviderConnections().catch(() => []),
      getProviderNodes().catch(() => []),
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

    return NextResponse.json({ connections: items });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// POST /api/model-probe - Run BazaarLink probe
export async function POST(request) {
  try {
    const body = await request.json();
    let { connectionId, baseUrl, apiKey, modelId, claimedModel, mode = "fast" } = body;

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
    }

    if (!baseUrl || !apiKey || !modelId) {
      return NextResponse.json(
        { error: "baseUrl, apiKey, and modelId are required" },
        { status: 400 }
      );
    }

    const payload = {
      baseUrl: baseUrl.replace(/\/+$/, ""),
      apiKey,
      modelId: modelId.trim(),
      claimedModel: claimedModel ? claimedModel.trim() : modelId.trim(),
      quickMode: mode === "fast",
      identityOnly: mode === "fast",
      sync: true,
    };

    const res = await fetch(BAZAARLINK_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(180_000),
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
