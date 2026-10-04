"use client";

import { useCallback, useEffect, useState } from "react";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import Pagination from "@/shared/components/Pagination";

const ENDPOINTS = ["chat", "count_tokens", "embeddings", "images", "tts", "stt", "video", "search", "fetch", "systemone"];
const inputClass = "h-9 rounded-[10px] border border-border bg-surface px-3 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-brand-500/30";

function formatNumber(value) {
  return Number(value || 0).toLocaleString();
}

function statusClass(status) {
  if (status >= 500 || status === 499) return "text-red-600";
  if (status >= 400) return "text-amber-600";
  return "text-green-600";
}

export default function RequestLogsClient() {
  const [data, setData] = useState({ logs: [], pagination: { page: 1, pageSize: 50, totalItems: 0, totalPages: 0 } });
  const [filters, setFilters] = useState({ status: "", endpointKind: "", search: "" });
  const [page, setPage] = useState(1);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (signal) => {
    try {
      const query = new URLSearchParams({ page: String(page), pageSize: "50" });
      for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
      const response = await fetch(`/api/usage/request-log-entries?${query}`, { cache: "no-store", signal });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Failed to load request logs");
      setData(body);
      setError("");
    } catch (cause) {
      if (cause.name !== "AbortError") setError(cause.message);
    }
  }, [filters, page]);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    const timer = autoRefresh ? setInterval(() => load(), 5000) : null;
    return () => { controller.abort(); if (timer) clearInterval(timer); };
  }, [autoRefresh, load]);

  const changeFilter = (key, value) => {
    setPage(1);
    setFilters((current) => ({ ...current, [key]: value }));
  };

  return (
    <Card padding="none">
      <div className="flex flex-wrap items-center gap-3 border-b border-border-subtle p-4">
        <input className={`${inputClass} min-w-[220px] flex-1`} placeholder="Search model, IP, path, provider" aria-label="Search model" value={filters.search} onChange={(event) => changeFilter("search", event.target.value)} />
        <select className={inputClass} aria-label="Status" value={filters.status} onChange={(event) => changeFilter("status", event.target.value)}>
          <option value="">All status</option><option value="ok">Success</option><option value="error">Error</option>
        </select>
        <select className={inputClass} aria-label="Endpoint type" value={filters.endpointKind} onChange={(event) => changeFilter("endpointKind", event.target.value)}>
          <option value="">All endpoints</option>{ENDPOINTS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
        </select>
        <label className="flex items-center gap-2 text-sm text-text-muted"><input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} /> Auto refresh</label>
        <Button variant="secondary" size="sm" onClick={() => load()}>Refresh</Button>
      </div>
      {error && <p className="p-4 text-sm text-red-600">{error}</p>}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[980px] text-left text-sm">
          <thead className="bg-surface-2 text-xs uppercase text-text-muted"><tr>{["Time", "Status", "API key", "IP", "Method / path", "Model", "In", "Out", "TPS", "Duration"].map((label) => <th key={label} className="px-4 py-3 font-semibold">{label}</th>)}</tr></thead>
          <tbody className="divide-y divide-border-subtle">
            {data.logs.map((log) => <tr key={log.id} className="text-text-main">
              <td className="whitespace-nowrap px-4 py-3 text-xs text-text-muted">{new Date(log.timestamp).toLocaleString()}</td>
              <td className={`px-4 py-3 font-semibold ${statusClass(log.status)}`}>{log.status}</td>
              <td className="px-4 py-3">{log.apiKeyName || log.apiKeyMasked || "none"}</td>
              <td className="px-4 py-3 font-mono text-xs">{log.ip || "unknown"}</td>
              <td className="px-4 py-3"><span className="font-semibold">{log.method}</span> <span className="font-mono text-xs">{log.path}</span></td>
              <td className="max-w-[220px] truncate px-4 py-3" title={log.resolvedModel || log.model}>{log.resolvedModel || log.model || "-"}</td>
              <td className="px-4 py-3">{formatNumber(log.promptTokens)}</td><td className="px-4 py-3">{formatNumber(log.completionTokens)}</td>
              <td className="px-4 py-3">{Number(log.tps || 0).toFixed(1)}</td><td className="px-4 py-3">{formatNumber(log.durationMs)}ms</td>
            </tr>)}
            {!data.logs.length && <tr><td colSpan="10" className="px-4 py-12 text-center text-text-muted">No inbound requests logged.</td></tr>}
          </tbody>
        </table>
      </div>
      <Pagination currentPage={data.pagination.page || page} pageSize={data.pagination.pageSize || 50} totalItems={data.pagination.totalItems || 0} onPageChange={setPage} />
    </Card>
  );
}
