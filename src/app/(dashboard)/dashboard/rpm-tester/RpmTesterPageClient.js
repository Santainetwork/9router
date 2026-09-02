"use client";

// RPM Tester — fires a burst of real requests at /v1/chat/completions (or
// /v1/messages) using a chosen API key so you can watch the per-API-key /
// per-provider RPM gate reject with 429 + Retry-After. This hits the SAME gated
// endpoint external clients use, so it is a true end-to-end test of the limiter.

import { useEffect, useMemo, useState, useCallback } from "react";
import { cn } from "@/shared/utils/cn";

const ENDPOINTS = [
  { id: "openai", label: "/v1/chat/completions (OpenAI)", path: "/v1/chat/completions" },
  { id: "anthropic", label: "/v1/messages (Anthropic)", path: "/v1/messages" },
];

function statusColor(status) {
  if (status === 0) return "text-neutral-400";
  if (status === 429) return "text-amber-500";
  if (status >= 200 && status < 300) return "text-emerald-500";
  if (status >= 400) return "text-red-500";
  return "text-neutral-500";
}

function buildBody(endpointId, model, prompt) {
  if (endpointId === "anthropic") {
    return { model, max_tokens: 16, messages: [{ role: "user", content: prompt }] };
  }
  return { model, messages: [{ role: "user", content: prompt }], max_tokens: 16, stream: false };
}

export default function RpmTesterPageClient() {
  const [keys, setKeys] = useState([]);
  const [keyId, setKeyId] = useState("");
  const [endpointId, setEndpointId] = useState("openai");
  const [model, setModel] = useState("openai/gpt-4o-mini");
  const [prompt, setPrompt] = useState("ping");
  const [count, setCount] = useState(6);
  const [concurrent, setConcurrent] = useState(true);
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
          body: JSON.stringify(buildBody(endpointId, model, prompt)),
        });
        const ms = Math.round(performance.now() - t0);
        const retryAfter = res.headers.get("retry-after");
        let detail = "";
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          detail = data?.error?.message || data?.error || data?.message || "";
        }
        return { i, status: res.status, ms, retryAfter, detail };
      } catch (e) {
        return { i, status: 0, ms: Math.round(performance.now() - t0), retryAfter: null, detail: String(e?.message || e) };
      }
    },
    [endpoint, endpointId, model, prompt, selectedKey],
  );

  const run = useCallback(async () => {
    if (!selectedKey) { setLoadError("Pick an active API key first."); return; }
    setLoadError("");
    setRunning(true);
    const n = Math.max(1, Math.min(100, Number(count) || 1));
    const pending = Array.from({ length: n }, (_, i) => ({ i, status: null, ms: null, retryAfter: null, detail: "" }));
    setResults(pending);

    if (concurrent) {
      const settled = await Promise.all(pending.map((p) => fireOne(p.i)));
      setResults(settled.sort((a, b) => a.i - b.i));
    } else {
      const acc = [];
      for (const p of pending) {
        // eslint-disable-next-line no-await-in-loop
        const r = await fireOne(p.i);
        acc.push(r);
        setResults([...acc].concat(pending.slice(acc.length)).sort((a, b) => a.i - b.i));
      }
    }
    setRunning(false);
  }, [selectedKey, count, concurrent, fireOne]);

  const summary = useMemo(() => {
    const done = results.filter((r) => r.status !== null);
    const ok = done.filter((r) => r.status >= 200 && r.status < 300).length;
    const limited = done.filter((r) => r.status === 429).length;
    const other = done.length - ok - limited;
    return { total: done.length, ok, limited, other };
  }, [results]);

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold">RPM Tester</h1>
        <p className="text-sm text-neutral-500 mt-1">
          Fire a burst of real requests at the gated endpoint to watch per-key / per-provider RPM limits reject with 429 + Retry-After.
        </p>
      </div>

      {loadError && <div className="text-sm text-red-500">{loadError}</div>}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-500">API key</span>
          <select className="border rounded px-2 py-1.5 bg-transparent" value={keyId} onChange={(e) => setKeyId(e.target.value)}>
            {keys.length === 0 && <option value="">No active keys</option>}
            {keys.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name || k.id} {k.rpm > 0 ? `· rpm=${k.rpm}` : "· no limit"}{k.queueTimeoutMs > 0 ? ` · queue=${k.queueTimeoutMs}ms` : ""}
              </option>
            ))}
          </select>
          {selectedKey && (
            <span className="text-xs text-neutral-400">
              {selectedKey.rpm > 0
                ? `Limit ${selectedKey.rpm}/min` + (selectedKey.queueTimeoutMs > 0 ? `, queue up to ${selectedKey.queueTimeoutMs}ms` : ", no queue (immediate 429)")
                : "This key has no RPM limit — set one on Endpoint & Key to see 429s."}
            </span>
          )}
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-500">Endpoint</span>
          <select className="border rounded px-2 py-1.5 bg-transparent" value={endpointId} onChange={(e) => setEndpointId(e.target.value)}>
            {ENDPOINTS.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-500">Model</span>
          <input className="border rounded px-2 py-1.5 bg-transparent" value={model} onChange={(e) => setModel(e.target.value)} placeholder="provider/model" />
          <div className="flex flex-wrap items-center gap-1.5 mt-1">
            {["deepseek-v4-flash", "claude-sonnet-4-6", "qwen3.8-max", "gemini-3.7-flash-high"].map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setModel(preset)}
                className={`text-[10px] px-2 py-0.5 rounded-full border transition ${model === preset ? "border-primary bg-primary/10 text-primary" : "border-border-subtle bg-surface-2 text-text-muted hover:text-text-main"}`}
              >
                {preset}
              </button>
            ))}
          </div>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-500">Prompt</span>
          <input className="border rounded px-2 py-1.5 bg-transparent" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-500">Requests</span>
          <input type="number" min={1} max={100} className="border rounded px-2 py-1.5 bg-transparent w-28" value={count} onChange={(e) => setCount(e.target.value)} />
        </label>

        <label className="flex items-center gap-2 text-sm mt-6">
          <input type="checkbox" checked={concurrent} onChange={(e) => setConcurrent(e.target.checked)} />
          <span>Fire concurrently (burst)</span>
        </label>
      </div>

      <button
        onClick={run}
        disabled={running || !selectedKey}
        className={cn("px-4 py-2 rounded text-white text-sm", running || !selectedKey ? "bg-neutral-400 cursor-not-allowed" : "bg-blue-600 hover:bg-blue-700")}
      >
        {running ? "Running…" : `Send ${Math.max(1, Math.min(100, Number(count) || 1))} request(s)`}
      </button>

      {results.length > 0 && (
        <div className="space-y-3">
          <div className="flex gap-4 text-sm">
            <span>Total: <b>{summary.total}</b></span>
            <span className="text-emerald-500">2xx: <b>{summary.ok}</b></span>
            <span className="text-amber-500">429: <b>{summary.limited}</b></span>
            <span className="text-red-500">other: <b>{summary.other}</b></span>
          </div>
          <div className="border rounded divide-y text-sm">
            <div className="grid grid-cols-[3rem_5rem_5rem_7rem_1fr] gap-2 px-3 py-1.5 font-medium text-neutral-500">
              <span>#</span><span>status</span><span>ms</span><span>retry-after</span><span>detail</span>
            </div>
            {results.map((r) => (
              <div key={r.i} className="grid grid-cols-[3rem_5rem_5rem_7rem_1fr] gap-2 px-3 py-1.5">
                <span className="text-neutral-400">{r.i + 1}</span>
                <span className={cn("font-mono", statusColor(r.status ?? -1))}>{r.status === null ? "…" : r.status}</span>
                <span className="text-neutral-500">{r.ms ?? ""}</span>
                <span className="text-amber-500">{r.retryAfter || ""}</span>
                <span className="text-neutral-500 truncate" title={r.detail}>{r.detail}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
