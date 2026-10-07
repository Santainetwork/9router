"use client";

// Rate & Concurrency Tester — fires real requests at /v1/chat/completions (or
// /v1/messages) using a chosen API key so you can watch both per-API-key /
// per-provider RPM limits AND in-flight simultaneous concurrency limits reject
// with 429 + Retry-After.

import { useEffect, useMemo, useState, useCallback } from "react";
import { cn } from "@/shared/utils/cn";

const ENDPOINTS = [
  { id: "openai", label: "/v1/chat/completions (OpenAI)", path: "/v1/chat/completions" },
  { id: "anthropic", label: "/v1/messages (Anthropic)", path: "/v1/messages" },
];

function statusColor(status) {
  if (status === 0) return "text-text-muted dark:text-text-muted";
  if (status === 429) return "text-warning dark:text-warning font-semibold";
  if (status >= 200 && status < 300) return "text-success dark:text-success";
  if (status >= 400) return "text-danger dark:text-danger";
  return "text-text-muted dark:text-text-muted";
}

function buildBody(endpointId, model, prompt, isStream) {
  if (endpointId === "anthropic") {
    return { model, max_tokens: 16, messages: [{ role: "user", content: prompt }], stream: isStream };
  }
  return { model, messages: [{ role: "user", content: prompt }], max_tokens: 16, stream: isStream };
}

export default function RpmTesterPageClient() {
  const [keys, setKeys] = useState([]);
  const [keyId, setKeyId] = useState("");
  const [testType, setTestType] = useState("concurrency"); // "concurrency" | "rpm"
  const [endpointId, setEndpointId] = useState("openai");
  const [model, setModel] = useState("openai/gpt-4o-mini");
  const [prompt, setPrompt] = useState("ping");
  const [count, setCount] = useState(6);
  const [useStream, setUseStream] = useState(true);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState([]);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    fetch("/api/keys", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        const list = Array.isArray(d.keys) ? d.keys.filter((k) => k.isActive && k.key) : [];
        setKeys(list);
        if (list.length && !keyId) setKeyId(list[0].id);
      })
      .catch(() => setLoadError("Failed to load API keys."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedKey = useMemo(() => keys.find((k) => k.id === keyId) || null, [keys, keyId]);
  const endpoint = useMemo(() => ENDPOINTS.find((e) => e.id === endpointId), [endpointId]);

  const fireOne = useCallback(
    async (i) => {
      const t0 = performance.now();
      try {
        const res = await fetch(endpoint.path, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${selectedKey.key}`,
            ...(endpointId === "anthropic" ? { "anthropic-version": "2023-06-01" } : {}),
          },
          body: JSON.stringify(buildBody(endpointId, model, prompt, useStream)),
        });
        const ms = Math.round(performance.now() - t0);
        const retryAfter = res.headers.get("retry-after");
        let detail = "";
        let isConcurrencyLimit = false;
        let isRpmLimit = false;

        if (!res.ok) {
          const data = await res.json().catch(() => null);
          detail = data?.error?.message || data?.error || data?.message || "";
          if (res.status === 429) {
            if (/concurrency/i.test(detail)) {
              isConcurrencyLimit = true;
            } else {
              isRpmLimit = true;
            }
          }
        }
        return { i, status: res.status, ms, retryAfter, detail, isConcurrencyLimit, isRpmLimit };
      } catch (e) {
        return { i, status: 0, ms: Math.round(performance.now() - t0), retryAfter: null, detail: String(e?.message || e), isConcurrencyLimit: false, isRpmLimit: false };
      }
    },
    [endpoint, endpointId, model, prompt, selectedKey, useStream],
  );

  const run = useCallback(async () => {
    if (!selectedKey) { setLoadError("Pick an active API key first."); return; }
    setLoadError("");
    setRunning(true);
    const n = Math.max(1, Math.min(100, Number(count) || 1));
    const pending = Array.from({ length: n }, (_, i) => ({
      i,
      status: null,
      ms: null,
      retryAfter: null,
      detail: "",
      isConcurrencyLimit: false,
      isRpmLimit: false,
    }));
    setResults(pending);

    if (testType === "concurrency") {
      // Fire all simultaneous requests instantly at once to test concurrent in-flight limit
      const settled = await Promise.all(pending.map((p) => fireOne(p.i)));
      setResults(settled.sort((a, b) => a.i - b.i));
    } else {
      // Sequential rapid bursts to observe RPM limits
      const acc = [];
      for (const p of pending) {
        // eslint-disable-next-line no-await-in-loop
        const r = await fireOne(p.i);
        acc.push(r);
        setResults([...acc].concat(pending.slice(acc.length)).sort((a, b) => a.i - b.i));
      }
    }
    setRunning(false);
  }, [selectedKey, count, testType, fireOne]);

  const summary = useMemo(() => {
    const done = results.filter((r) => r.status !== null);
    const ok = done.filter((r) => r.status >= 200 && r.status < 300).length;
    const concurrency429 = done.filter((r) => r.status === 429 && r.isConcurrencyLimit).length;
    const rpm429 = done.filter((r) => r.status === 429 && !r.isConcurrencyLimit).length;
    const total429 = done.filter((r) => r.status === 429).length;
    const other = done.length - ok - total429;
    return { total: done.length, ok, concurrency429, rpm429, total429, other };
  }, [results]);

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-border pb-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-text-main">Rate & Concurrency Tester</h1>
          <p className="text-sm text-text-muted mt-1">
            Test live limits for RPM (Requests per Minute) and in-flight simultaneous Concurrency against gateway endpoints.
          </p>
        </div>
        <div className="inline-flex rounded-lg border border-border p-1 bg-surface-2 self-start sm:self-auto">
          <button
            type="button"
            onClick={() => { setTestType("concurrency"); setCount(6); }}
            className={cn(
              "px-3 py-1 text-xs font-semibold rounded-md transition-colors",
              testType === "concurrency" ? "bg-primary text-primary-foreground shadow-sm" : "text-text-muted hover:text-text-main"
            )}
          >
            ⚡ Concurrency Test (Simultaneous)
          </button>
          <button
            type="button"
            onClick={() => { setTestType("rpm"); setCount(10); }}
            className={cn(
              "px-3 py-1 text-xs font-semibold rounded-md transition-colors",
              testType === "rpm" ? "bg-primary text-primary-foreground shadow-sm" : "text-text-muted hover:text-text-main"
            )}
          >
            ⏱️ RPM Burst Test (Per-Minute)
          </button>
        </div>
      </div>

      {loadError && <div className="text-sm text-danger dark:text-danger bg-danger/10 p-3 rounded-lg border border-danger/20">{loadError}</div>}

      {/* Selected Key Parameters Card */}
      {selectedKey && (
        <div className="rounded-xl border border-border bg-surface-1 p-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-text-main">{selectedKey.name || "API Key"}</span>
              <span className="font-mono text-text-muted">{selectedKey.key.slice(0, 10)}...</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn("px-2 py-0.5 rounded-md font-mono font-medium border", selectedKey.concurrency > 0 ? "bg-info/10 text-info dark:text-info border-info/30" : "bg-surface-2 text-text-muted border-border")}>
                Max Concurrency: {selectedKey.concurrency > 0 ? selectedKey.concurrency : "Unlimited"}
              </span>
              <span className={cn("px-2 py-0.5 rounded-md font-mono font-medium border", selectedKey.rpm > 0 ? "bg-warning/10 text-warning dark:text-warning border-warning/30" : "bg-surface-2 text-text-muted border-border")}>
                RPM Limit: {selectedKey.rpm > 0 ? `${selectedKey.rpm}/min` : "Unlimited"}
              </span>
              <span className="px-2 py-0.5 rounded-md font-mono text-text-muted bg-surface-2 border border-border">
                Queue Timeout: {selectedKey.queueTimeoutMs > 0 ? `${selectedKey.queueTimeoutMs}ms` : "0 (Immediate Reject)"}
              </span>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-text-muted font-medium">API Key</span>
          <select className="border border-border rounded-lg px-3 py-2 bg-input text-text-main focus:outline-none focus:ring-1 focus:ring-primary" value={keyId} onChange={(e) => setKeyId(e.target.value)}>
            {keys.length === 0 && <option value="">No active keys</option>}
            {keys.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name || k.id} {k.concurrency > 0 ? `· conc=${k.concurrency}` : ""}{k.rpm > 0 ? ` · rpm=${k.rpm}` : ""}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-text-muted font-medium">Target Endpoint</span>
          <select className="border border-border rounded-lg px-3 py-2 bg-input text-text-main focus:outline-none focus:ring-1 focus:ring-primary" value={endpointId} onChange={(e) => setEndpointId(e.target.value)}>
            {ENDPOINTS.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-text-muted font-medium">Model</span>
          <input className="border border-border rounded-lg px-3 py-2 bg-input text-text-main focus:outline-none focus:ring-1 focus:ring-primary" value={model} onChange={(e) => setModel(e.target.value)} placeholder="provider/model" />
          <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
            {["qmodel_38max", "deepseek-v4-flash", "claude-sonnet-4-6", "qwen3.8-max", "gemini-3.7-flash-high"].map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setModel(preset)}
                className={`text-[10px] px-2 py-0.5 rounded-full border transition ${model === preset ? "border-primary bg-primary/10 text-primary" : "border-border bg-surface-2 text-text-muted hover:text-text-main"}`}
              >
                {preset}
              </button>
            ))}
          </div>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-text-muted font-medium">Prompt</span>
          <input className="border border-border rounded-lg px-3 py-2 bg-input text-text-main focus:outline-none focus:ring-1 focus:ring-primary" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-text-muted font-medium">
            {testType === "concurrency" ? "Simultaneous In-Flight Requests" : "Burst Requests Count"}
          </span>
          <input
            type="number"
            min={1}
            max={100}
            className="border border-border rounded-lg px-3 py-2 bg-input text-text-main focus:outline-none focus:ring-1 focus:ring-primary w-32"
            value={count}
            onChange={(e) => setCount(e.target.value)}
          />
          <span className="text-[11px] text-text-muted">
            {testType === "concurrency"
              ? "All requests will fire simultaneously in Promise.all() to trigger concurrency cap."
              : "Requests will fire in rapid sequence to verify RPM threshold."}
          </span>
        </label>

        <div className="flex flex-col justify-end gap-2 text-sm">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={useStream} onChange={(e) => setUseStream(e.target.checked)} className="rounded text-primary" />
            <span className="text-text-main text-xs">Enable SSE Streaming (holds slot longer for concurrency test)</span>
          </label>
        </div>
      </div>

      <div>
        <button
          onClick={run}
          disabled={running || !selectedKey}
          className={cn(
            "px-5 py-2.5 rounded-lg text-white font-medium text-sm transition shadow-sm",
            running || !selectedKey ? "bg-surface-3 cursor-not-allowed" : "bg-info/20 hover:bg-info/25"
          )}
        >
          {running ? "Sending Requests..." : `🚀 Run ${testType === "concurrency" ? "Concurrency" : "RPM"} Test (${Math.max(1, Math.min(100, Number(count) || 1))} requests)`}
        </button>
      </div>

      {results.length > 0 && (
        <div className="space-y-4 pt-2">
          {/* Summary KPI Pills */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
            <div className="p-3 rounded-lg border border-border bg-surface-1">
              <p className="text-text-muted">Total Requests</p>
              <p className="text-lg font-bold text-text-main mt-0.5">{summary.total}</p>
            </div>
            <div className="p-3 rounded-lg border border-success/20 bg-success/5">
              <p className="text-success dark:text-success font-medium">2xx OK</p>
              <p className="text-lg font-bold text-success dark:text-success mt-0.5">{summary.ok}</p>
            </div>
            <div className="p-3 rounded-lg border border-info/20 bg-info/5">
              <p className="text-info dark:text-info font-medium">429 Concurrency Cap</p>
              <p className="text-lg font-bold text-info dark:text-info mt-0.5">{summary.concurrency429}</p>
            </div>
            <div className="p-3 rounded-lg border border-warning/20 bg-warning/5">
              <p className="text-warning dark:text-warning font-medium">429 RPM Limit</p>
              <p className="text-lg font-bold text-warning dark:text-warning mt-0.5">{summary.rpm429}</p>
            </div>
            <div className="p-3 rounded-lg border border-danger/20 bg-danger/5 col-span-2 sm:col-span-1">
              <p className="text-danger dark:text-danger font-medium">Other Errors</p>
              <p className="text-lg font-bold text-danger dark:text-danger mt-0.5">{summary.other}</p>
            </div>
          </div>

          <div className="border border-border rounded-xl overflow-hidden shadow-sm bg-surface-1">
            <div className="grid grid-cols-[3rem_5.5rem_5rem_7rem_1fr] gap-2 px-3 py-2 bg-surface-2 border-b border-border font-medium text-xs text-text-muted">
              <span>#</span>
              <span>HTTP Status</span>
              <span>Duration</span>
              <span>Retry-After</span>
              <span>Gateway Response</span>
            </div>
            <div className="divide-y divide-border text-xs max-h-96 overflow-y-auto">
              {results.map((r) => (
                <div key={r.i} className="grid grid-cols-[3rem_5.5rem_5rem_7rem_1fr] gap-2 px-3 py-2 items-center hover:bg-surface-2/50 transition-colors">
                  <span className="text-text-muted font-mono">{r.i + 1}</span>
                  <div>
                    <span className={cn("font-mono px-1.5 py-0.5 rounded text-[11px]", statusColor(r.status ?? -1))}>
                      {r.status === null ? "..." : r.status}
                    </span>
                  </div>
                  <span className="text-text-muted font-mono">{r.ms !== null ? `${r.ms}ms` : "-"}</span>
                  <span className="text-warning dark:text-warning font-mono">{r.retryAfter || "-"}</span>
                  <div className="truncate" title={r.detail}>
                    {r.isConcurrencyLimit ? (
                      <span className="text-info dark:text-info font-medium bg-info/10 px-1.5 py-0.5 rounded text-[10px] mr-1.5">
                        CONCURRENCY CAP
                      </span>
                    ) : r.isRpmLimit ? (
                      <span className="text-warning dark:text-warning font-medium bg-warning/10 px-1.5 py-0.5 rounded text-[10px] mr-1.5">
                        RPM RATE LIMIT
                      </span>
                    ) : null}
                    <span className="text-text-muted font-mono text-[11px]">{r.detail || (r.status >= 200 && r.status < 300 ? "OK" : "-")}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
