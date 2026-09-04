"use client";

import { useState, useEffect } from "react";
import { Card, Button } from "@/shared/components";
import { cn } from "@/shared/utils/cn";

export default function ModelProbeClient() {
  const [connections, setConnections] = useState([]);
  const [selectedConnId, setSelectedConnId] = useState("");
  
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [modelId, setModelId] = useState("");
  const [claimedModel, setClaimedModel] = useState("");
  const [mode, setMode] = useState("fast"); // "fast" | "full"

  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  useEffect(() => {
    fetch("/api/model-probe", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        const list = d.connections || [];
        setConnections(list);
        if (list.length > 0) {
          handleSelectConnection(list[0].id, list);
        }
      })
      .catch(() => {});
  }, []);

  const handleSelectConnection = (id, list = connections) => {
    setSelectedConnId(id);
    const conn = list.find((c) => c.id === id);
    if (conn) {
      setBaseUrl(conn.baseUrl || "");
      setModelId(conn.defaultModel || "");
      setClaimedModel(conn.defaultModel || "");
      setApiKey("••••••••••••••••"); // Masked, handled by connectionId on backend
    }
  };

  const handleRunProbe = async () => {
    setError("");
    setResult(null);
    setRunning(true);

    try {
      const payload = {
        connectionId: selectedConnId && apiKey.includes("••") ? selectedConnId : undefined,
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.includes("••") ? undefined : apiKey.trim(),
        modelId: modelId.trim(),
        claimedModel: claimedModel ? claimedModel.trim() : modelId.trim(),
        mode,
      };

      const res = await fetch("/api/model-probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setResult(data);
    } catch (err) {
      setError(err.message || "Failed to execute model probe");
    } finally {
      setRunning(false);
    }
  };

  const ident = result?.identityAssessment;
  const v3f = ident?.subModelMatchV3F;
  const flags = ident?.riskFlags || [];
  const status = ident?.status || "unknown";

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="border-b border-border pb-4">
        <div className="flex items-center gap-2.5">
          <span className="material-symbols-outlined text-[28px] text-primary">verified_user</span>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-text-main">Upstream Model Identity Probe</h1>
            <p className="text-sm text-text-muted mt-0.5">
              Verify upstream AI providers via BazaarLink Probe API — detect silent model swap, token inflation, and spoofing.
            </p>
          </div>
        </div>
      </div>

      {error && (
        <div className="p-4 bg-red-500/10 border border-red-500/20 text-red-500 text-xs font-semibold rounded-xl flex items-center gap-2">
          <span className="material-symbols-outlined text-[18px]">error</span>
          <span>{error}</span>
        </div>
      )}

      {/* Target Selection & Form */}
      <Card>
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-border pb-3">
            <span className="text-xs font-bold uppercase tracking-wider text-text-muted">Target Endpoint Configuration</span>
            {connections.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-text-muted">Auto-fill from 9Router:</span>
                <select
                  value={selectedConnId}
                  onChange={(e) => handleSelectConnection(e.target.value)}
                  className="rounded-lg border border-border bg-input px-2.5 py-1 text-xs font-semibold text-text-main focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="">-- Manual Input --</option>
                  {connections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.providerName} · {c.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-text-main">Base URL (OpenAI-compatible)</label>
              <input
                type="text"
                placeholder="https://api.upstream.com/v1"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                className="w-full rounded-lg border border-border bg-input px-3 py-2 text-xs font-mono text-text-main placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-text-main">API Key</label>
              <input
                type="password"
                placeholder="sk-..."
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setSelectedConnId(""); // Manual key overrides saved connection
                }}
                className="w-full rounded-lg border border-border bg-input px-3 py-2 text-xs font-mono text-text-main placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-text-main">Model ID on Endpoint</label>
              <input
                type="text"
                placeholder="anthropic/claude-opus-4.7"
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                className="w-full rounded-lg border border-border bg-input px-3 py-2 text-xs font-mono text-text-main placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-text-main">Claimed Model (Expected Identity)</label>
              <input
                type="text"
                placeholder="anthropic/claude-opus-4.7"
                value={claimedModel}
                onChange={(e) => setClaimedModel(e.target.value)}
                className="w-full rounded-lg border border-border bg-input px-3 py-2 text-xs font-mono text-text-main placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-2 border-t border-border">
            {/* Mode selection */}
            <div className="inline-flex rounded-lg border border-border p-1 bg-surface-2 self-start sm:self-auto">
              <button
                type="button"
                onClick={() => setMode("fast")}
                className={cn(
                  "px-3 py-1 text-xs font-semibold rounded-md transition",
                  mode === "fast" ? "bg-primary text-primary-foreground shadow-sm" : "text-text-muted hover:text-text-main"
                )}
              >
                ⚡ Fast Identity (20–40s)
              </button>
              <button
                type="button"
                onClick={() => setMode("full")}
                className={cn(
                  "px-3 py-1 text-xs font-semibold rounded-md transition",
                  mode === "full" ? "bg-primary text-primary-foreground shadow-sm" : "text-text-muted hover:text-text-main"
                )}
              >
                🔬 Full Multi-layer Audit (60–180s)
              </button>
            </div>

            <Button
              onClick={handleRunProbe}
              disabled={running || !baseUrl || !modelId}
              className="gap-2"
            >
              {running ? (
                <>
                  <span className="inline-block animate-spin">⌛</span>
                  Running 50+ Probes...
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined text-[18px]">play_arrow</span>
                  Launch Verification Probe
                </>
              )}
            </Button>
          </div>
        </div>
      </Card>

      {/* Result Presentation */}
      {result && (
        <div className="space-y-6">
          {/* Verdict Banner */}
          <div
            className={cn(
              "rounded-xl border p-5 shadow-sm transition-all",
              status === "confirmed"
                ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-600"
                : status === "mismatch"
                ? "bg-red-500/10 border-red-500/30 text-red-500"
                : "bg-amber-500/10 border-amber-500/30 text-amber-600"
            )}
          >
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-start gap-3.5">
                <span className="material-symbols-outlined text-[36px] mt-0.5">
                  {status === "confirmed" ? "check_circle" : status === "mismatch" ? "dangerous" : "warning"}
                </span>
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-lg font-bold tracking-tight uppercase">
                      {status === "confirmed"
                        ? "Model Identity Confirmed ✅"
                        : status === "mismatch"
                        ? "Model Mismatch / Spoof Detected 🚨"
                        : "Insufficient Data / Inconclusive ⚠️"}
                    </h2>
                    <span className="text-xs px-2 py-0.5 rounded-full font-mono font-bold bg-surface-1 border border-current">
                      Confidence: {Math.round((ident?.confidence || 0) * 100)}%
                    </span>
                  </div>
                  <p className="text-xs text-text-main mt-1">
                    Claimed: <b className="font-mono">{ident?.claimedModel || modelId}</b> · Detected Family:{" "}
                    <b className="font-mono uppercase">{ident?.predictedFamily || "unknown"}</b>
                  </p>
                </div>
              </div>

              {/* Score pill */}
              <div className="flex items-center gap-3 self-start sm:self-auto bg-surface-1 border border-border px-4 py-2 rounded-xl">
                <div>
                  <p className="text-[10px] uppercase font-bold text-text-muted">Quality Score</p>
                  <p className="text-2xl font-black tabular-nums font-mono text-text-main">{result.score}/100</p>
                </div>
              </div>
            </div>

            {/* Risk flags alert */}
            {flags.length > 0 && (
              <div className="mt-4 pt-3 border-t border-current/20 flex flex-wrap items-center gap-2">
                <span className="text-xs font-bold uppercase tracking-wide text-red-500">Risk Flags Triggered:</span>
                {flags.map((f, i) => (
                  <span key={i} className="text-xs px-2.5 py-0.5 rounded-md bg-red-500 text-white font-mono font-bold">
                    ⚠️ {f}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* V3F Classifier Details */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Card>
              <p className="text-xs uppercase tracking-wider font-semibold text-text-muted">V3F Classifier Match</p>
              <p className="mt-1.5 text-base font-bold font-mono text-text-main truncate" title={v3f?.modelId || "N/A"}>
                {v3f?.modelId || "No exact match"}
              </p>
              <p className="text-xs text-text-muted mt-1 font-mono">
                Match Score: {v3f?.score ? (v3f.score * 100).toFixed(1) + "%" : "0%"}
              </p>
            </Card>

            <Card>
              <p className="text-xs uppercase tracking-wider font-semibold text-text-muted">Tokens Consumed</p>
              <p className="mt-1.5 text-xl font-bold font-mono text-text-main tabular-nums">
                {(result.totalInputTokens || 0) + (result.totalOutputTokens || 0)} tok
              </p>
              <p className="text-xs text-text-muted mt-1 font-mono">
                In: {result.totalInputTokens || 0} · Out: {result.totalOutputTokens || 0}
              </p>
            </Card>

            <Card>
              <p className="text-xs uppercase tracking-wider font-semibold text-text-muted">Probe Test Results</p>
              <p className="mt-1.5 text-xl font-bold font-mono text-text-main tabular-nums">
                {(result.items || []).filter((i) => i.passed === true).length} / {(result.items || []).length} Passed
              </p>
              <p className="text-xs text-text-muted mt-1 font-mono">Run ID: {result.runId?.slice(0, 12)}...</p>
            </Card>
          </div>

          {/* Detailed Probe Items Table */}
          {result.items && result.items.length > 0 && (
            <Card padding="none" className="overflow-hidden">
              <div className="p-4 border-b border-border flex items-center justify-between bg-surface-2/40">
                <span className="text-xs font-bold uppercase tracking-wider text-text-main">
                  Probe Inspection Items ({result.items.length})
                </span>
                <span className="text-xs text-text-muted">Multi-layer diagnostic tests</span>
              </div>
              <div className="overflow-x-auto max-h-96 divide-y divide-border">
                <table className="w-full text-left text-xs">
                  <thead className="bg-surface-2 text-text-muted font-semibold uppercase tracking-wider">
                    <tr>
                      <th className="py-2.5 px-3">Status</th>
                      <th className="py-2.5 px-3">Group</th>
                      <th className="py-2.5 px-3">Probe ID</th>
                      <th className="py-2.5 px-3">TTFT</th>
                      <th className="py-2.5 px-3">Response Preview</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border font-mono">
                    {result.items.map((item, idx) => (
                      <tr key={idx} className="hover:bg-surface-2/40 transition-colors">
                        <td className="py-2 px-3">
                          {item.passed === true ? (
                            <span className="text-emerald-500 font-bold">PASS</span>
                          ) : item.passed === false ? (
                            <span className="text-red-500 font-bold">FAIL</span>
                          ) : (
                            <span className="text-amber-500 font-bold">WARN</span>
                          )}
                        </td>
                        <td className="py-2 px-3 uppercase text-[11px] text-text-muted">{item.group || "identity"}</td>
                        <td className="py-2 px-3 font-semibold text-text-main">{item.probeId}</td>
                        <td className="py-2 px-3 text-text-muted">{item.ttftMs ? `${item.ttftMs}ms` : "-"}</td>
                        <td className="py-2 px-3 max-w-md truncate text-text-muted" title={item.response || ""}>
                          {item.response || "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
