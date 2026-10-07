"use client";

import { useState, useEffect, useRef } from "react";
import { Card, Button } from "@/shared/components";
import { cn } from "@/shared/utils/cn";

export default function ModelProbeClient() {
  const [connections, setConnections] = useState([]);
  const [baselines, setBaselines] = useState([]);
  const [selectedConnId, setSelectedConnId] = useState("");
  
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [modelId, setModelId] = useState("");
  const [claimedModel, setClaimedModel] = useState("");
  const [upstreamFormat, setUpstreamFormat] = useState("openai"); // "openai" | "anthropic"
  const [mode, setMode] = useState("fast"); // "fast" | "full"
  const [runContextCheck, setRunContextCheck] = useState(false);

  const [running, setRunning] = useState(false);
  const [progressText, setProgressText] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const pollTimerRef = useRef(null);

  useEffect(() => {
    fetch("/api/model-probe", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        const list = d.connections || [];
        setConnections(list);
        if (Array.isArray(d.baselines)) {
          setBaselines(d.baselines);
        }
        if (list.length > 0) {
          handleSelectConnection(list[0].id, list, d.baselines || []);
        }
      })
      .catch(() => {});

    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, []);

  const handleSelectConnection = (id, list = connections, baseList = baselines) => {
    setSelectedConnId(id);
    const conn = list.find((c) => c.id === id);
    if (conn) {
      setBaseUrl(conn.baseUrl || "");
      const defM = conn.defaultModel || "";
      setModelId(defM);
      
      // Auto-determine format
      const isAnthropic = conn.provider?.includes("anthropic") || (conn.baseUrl && conn.baseUrl.includes("/messages"));
      setUpstreamFormat(isAnthropic ? "anthropic" : "openai");

      // Auto-suggest canonical baseline if available
      const clean = defM.includes("/") ? defM.split("/").pop() : defM;
      const matchedBaseline = baseList.find((b) => {
        const sub = b.split("/")[1] || b;
        return sub.toLowerCase() === clean.toLowerCase() || sub.replace(/[-_.]/g, "") === clean.replace(/[-_.]/g, "");
      });
      setClaimedModel(matchedBaseline || defM);
      setApiKey("••••••••••••••••"); // Masked, handled by connectionId on backend
    }
  };

  const stopPolling = () => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  const handleRunProbe = async () => {
    stopPolling();
    setError("");
    setResult(null);
    setRunning(true);
    setProgressText("Initializing probe session with BazaarLink...");

    try {
      const payload = {
        connectionId: selectedConnId && apiKey.includes("••") ? selectedConnId : undefined,
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.includes("••") ? undefined : apiKey.trim(),
        modelId: modelId.trim(),
        claimedModel: claimedModel ? claimedModel.trim() : modelId.trim(),
        upstreamFormat,
        mode,
        runContextCheck,
        sync: false, // Use async polling for live updates and no timeouts
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

      const runId = data.runId;
      if (!runId) {
        // Immediate sync response fallback
        setResult(data);
        setRunning(false);
        return;
      }

      setProgressText(`Probe run started (ID: ${runId.slice(0, 8)}...). Polling live results...`);

      // Poll run status every 2.5 seconds
      let attempts = 0;
      pollTimerRef.current = setInterval(async () => {
        attempts++;
        try {
          const pollRes = await fetch(`/api/model-probe?runId=${encodeURIComponent(runId)}`, { cache: "no-store" });
          if (!pollRes.ok) return;
          const pollData = await pollRes.json();
          const items = pollData.items || [];
          const completedCount = items.filter((i) => i.status === "completed" || i.status === "error" || i.passed !== null).length;
          const totalCount = items.length || (mode === "fast" ? 46 : 98);
          
          setProgressText(`Running probes... (${completedCount}/${totalCount} complete - ${Math.round((completedCount / (totalCount || 1)) * 100)}%)`);

          if (pollData.status === "completed" || pollData.status === "failed" || attempts >= 80) {
            stopPolling();
            setResult(pollData);
            setRunning(false);
          }
        } catch {
          // Keep polling on transient network hitch
        }
      }, 2500);

    } catch (err) {
      setError(err.message || "Failed to execute model probe");
      setRunning(false);
    }
  };

  const ident = result?.identityAssessment;
  const v3f = ident?.subModelMatchV3F || (result?.v3fModelId ? { modelId: result.v3fModelId, score: result.v3fScore } : null);
  const flags = ident?.riskFlags || [];
  const status = ident?.status || (result?.status === "failed" ? "failed" : result?.identityConfirmed ? "confirmed" : "unknown");

  // Detect if preflight failed
  const firstItemError = result?.items?.find((i) => i.error)?.error;
  const isPreflightFailure = result?.status === "failed" || (result?.items && result.items.length > 0 && result.items.every((i) => i.status === "error"));

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="border-b border-border pb-4">
        <div className="flex items-center gap-2.5">
          <span className="material-symbols-outlined text-[28px] text-primary">verified_user</span>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-text-main">Upstream Model Identity Probe</h1>
            <p className="text-sm text-text-muted mt-0.5">
              Verify upstream AI providers via BazaarLink Probe API (V3F/V4) — detect silent model swap, token inflation, and spoofing.
            </p>
          </div>
        </div>
      </div>

      {error && (
        <div className="p-4 bg-danger/10 border border-danger/20 text-danger dark:text-danger text-xs font-semibold rounded-xl flex items-center gap-2">
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
              <label className="text-xs font-semibold text-text-main">Base URL</label>
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
                  setSelectedConnId("");
                }}
                className="w-full rounded-lg border border-border bg-input px-3 py-2 text-xs font-mono text-text-main placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-text-main">Model ID on Endpoint</label>
              <input
                type="text"
                placeholder="anthropic/claude-sonnet-5"
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                className="w-full rounded-lg border border-border bg-input px-3 py-2 text-xs font-mono text-text-main placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-text-main">Claimed Model (BazaarLink Baseline)</label>
                <span className="text-[10px] text-text-muted font-mono">vendor/model format</span>
              </div>
              <input
                type="text"
                list="bazaarlink-baselines"
                placeholder="e.g. anthropic/claude-sonnet-5"
                value={claimedModel}
                onChange={(e) => setClaimedModel(e.target.value)}
                className="w-full rounded-lg border border-border bg-input px-3 py-2 text-xs font-mono text-text-main placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <datalist id="bazaarlink-baselines">
                {baselines.map((b) => (
                  <option key={b} value={b} />
                ))}
              </datalist>
            </div>
          </div>

          {/* Options Row: Format & Context check */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
            <div className="flex items-center gap-3">
              <span className="text-xs font-semibold text-text-muted">Protocol Format:</span>
              <div className="inline-flex rounded-lg border border-border p-0.5 bg-surface-2 text-xs font-semibold">
                <button
                  type="button"
                  onClick={() => setUpstreamFormat("openai")}
                  className={cn(
                    "px-3 py-1 rounded-md transition",
                    upstreamFormat === "openai" ? "bg-primary text-primary-foreground shadow-sm" : "text-text-muted hover:text-text-main"
                  )}
                >
                  OpenAI Chat (/chat/completions)
                </button>
                <button
                  type="button"
                  onClick={() => setUpstreamFormat("anthropic")}
                  className={cn(
                    "px-3 py-1 rounded-md transition",
                    upstreamFormat === "anthropic" ? "bg-primary text-primary-foreground shadow-sm" : "text-text-muted hover:text-text-main"
                  )}
                >
                  Claude (/messages)
                </button>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="contextCheck"
                checked={runContextCheck}
                onChange={(e) => setRunContextCheck(e.target.checked)}
                className="rounded border-border text-primary focus:ring-primary"
              />
              <label htmlFor="contextCheck" className="text-xs font-semibold text-text-main cursor-pointer select-none">
                Include 4K→128K context window check (+2 mins)
              </label>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-3 border-t border-border">
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
                  <span>{progressText || "Running Probes..."}</span>
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

      {/* Progress banner while running */}
      {running && (
        <div className="p-4 bg-primary/10 border border-primary/20 text-primary rounded-xl flex items-center justify-between animate-pulse">
          <div className="flex items-center gap-2.5 text-xs font-bold font-mono">
            <span className="material-symbols-outlined text-[18px] animate-spin">progress_activity</span>
            <span>{progressText}</span>
          </div>
          <Button variant="outline" size="sm" onClick={stopPolling} className="text-xs">
            Cancel
          </Button>
        </div>
      )}

      {/* Result Presentation */}
      {result && !running && (
        <div className="space-y-6">
          {/* Preflight failure alert */}
          {isPreflightFailure && firstItemError && (
            <div className="p-4 bg-danger/10 border border-danger/30 text-danger dark:text-danger text-xs font-semibold rounded-xl flex items-start gap-2.5">
              <span className="material-symbols-outlined text-[20px] shrink-0 mt-0.5">cancel</span>
              <div>
                <p className="font-bold uppercase tracking-wider">Upstream Pre-flight Check Failed</p>
                <p className="font-mono mt-1 text-[11px] opacity-90">{firstItemError}</p>
                <p className="mt-1 text-[11px] text-text-muted">
                  The upstream endpoint rejected or failed the initial probe requests. Check baseUrl, API key, model ID availability, or protocol format (OpenAI vs Claude).
                </p>
              </div>
            </div>
          )}

          {/* Verdict Banner */}
          <div
            className={cn(
              "rounded-xl border p-5 shadow-sm transition-all",
              status === "confirmed"
                ? "bg-success/10 border-success/30 text-success dark:text-success"
                : status === "mismatch" || status === "failed"
                ? "bg-danger/10 border-danger/30 text-danger dark:text-danger"
                : "bg-warning/10 border-warning/30 text-warning dark:text-warning"
            )}
          >
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-start gap-3.5">
                <span className="material-symbols-outlined text-[36px] mt-0.5">
                  {status === "confirmed" ? "check_circle" : status === "mismatch" || status === "failed" ? "dangerous" : "warning"}
                </span>
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-lg font-bold tracking-tight uppercase">
                      {status === "confirmed"
                        ? "Model Identity Confirmed ✅"
                        : status === "mismatch"
                        ? "Model Mismatch / Spoof Detected 🚨"
                        : status === "failed"
                        ? "Probe Failed / Upstream Error ❌"
                        : "Insufficient Data / Inconclusive ⚠️"}
                    </h2>
                    {ident?.confidence != null && (
                      <span className="text-xs px-2 py-0.5 rounded-full font-mono font-bold bg-surface-1 border border-current">
                        Confidence: {Math.round((ident.confidence || 0) * 100)}%
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-text-main mt-1">
                    Claimed: <b className="font-mono">{ident?.claimedModel || claimedModel || modelId}</b> · Detected Family:{" "}
                    <b className="font-mono uppercase">{ident?.predictedFamily || result?.predictedFamily || "unknown"}</b>
                    {result?.mostSimilarDisplayName && (
                      <span> · Most Similar Model: <b className="font-mono">{result.mostSimilarDisplayName} ({Math.round((result.mostSimilarScore || 0) * 100)}%)</b></span>
                    )}
                  </p>
                </div>
              </div>

              {/* Score pill */}
              <div className="flex items-center gap-3 self-start sm:self-auto bg-surface-1 border border-border px-4 py-2 rounded-xl">
                <div>
                  <p className="text-[10px] uppercase font-bold text-text-muted">Quality Score</p>
                  <p className="text-2xl font-black tabular-nums font-mono text-text-main">
                    {result.score != null ? result.score : 0}/100
                  </p>
                </div>
              </div>
            </div>

            {/* Risk flags alert */}
            {flags.length > 0 && (
              <div className="mt-4 pt-3 border-t border-current/20 flex flex-wrap items-center gap-2">
                <span className="text-xs font-bold uppercase tracking-wide text-danger dark:text-danger">Risk Flags Triggered:</span>
                {flags.map((f, i) => (
                  <span key={i} className="text-xs px-2.5 py-0.5 rounded-md bg-danger/20 text-white font-mono font-bold">
                    ⚠️ {f}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* V3F / V4 Classifier Details */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Card>
              <p className="text-xs uppercase tracking-wider font-semibold text-text-muted">V3F Classifier Match</p>
              <p className="mt-1.5 text-base font-bold font-mono text-text-main truncate" title={v3f?.modelId || "N/A"}>
                {v3f?.displayName || v3f?.modelId || "No exact match"}
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
              <p className="text-xs text-text-muted mt-1 font-mono">
                {result.runId ? `Run ID: ${result.runId.slice(0, 12)}...` : `Status: ${result.status}`}
              </p>
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
              <div className="overflow-x-auto max-h-[30rem] divide-y divide-border">
                <table className="w-full text-left text-xs">
                  <thead className="bg-surface-2 text-text-muted font-semibold uppercase tracking-wider">
                    <tr>
                      <th className="py-2.5 px-3">Status</th>
                      <th className="py-2.5 px-3">Group</th>
                      <th className="py-2.5 px-3">Probe ID</th>
                      <th className="py-2.5 px-3">Reason / Details</th>
                      <th className="py-2.5 px-3">Response Preview</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border font-mono">
                    {result.items.map((item, idx) => (
                      <tr key={idx} className="hover:bg-surface-2/40 transition-colors">
                        <td className="py-2 px-3 whitespace-nowrap">
                          {item.passed === true ? (
                            <span className="text-success dark:text-success font-bold">PASS</span>
                          ) : item.passed === false ? (
                            <span className="text-danger dark:text-danger font-bold">FAIL</span>
                          ) : item.status === "error" ? (
                            <span className="text-danger dark:text-danger font-bold">ERR</span>
                          ) : (
                            <span className="text-warning dark:text-warning font-bold">WARN</span>
                          )}
                        </td>
                        <td className="py-2 px-3 uppercase text-[11px] text-text-muted">{item.group || "identity"}</td>
                        <td className="py-2 px-3 font-semibold text-text-main whitespace-nowrap">{item.label || item.probeId}</td>
                        <td className="py-2 px-3 max-w-xs truncate text-text-muted font-sans" title={item.passReason || item.error || ""}>
                          {item.passReason || item.error || (item.passed === true ? "Passed criteria" : "-")}
                        </td>
                        <td className="py-2 px-3 max-w-xs truncate text-text-muted" title={item.response || ""}>
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
