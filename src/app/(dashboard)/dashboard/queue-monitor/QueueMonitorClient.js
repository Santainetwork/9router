"use client";

import { useEffect, useRef, useState } from "react";
import { Card } from "@/shared/components";
import { cn } from "@/shared/utils/cn";

function StatusBadge({ status }) {
  if (status === "full") {
    return <span className="rounded-full bg-red-500/15 text-red-500 px-2 py-0.5 text-xs font-semibold">Full Cap</span>;
  }
  if (status === "queued") {
    return <span className="rounded-full bg-amber-500/15 text-amber-500 px-2 py-0.5 text-xs font-semibold">Queued</span>;
  }
  if (status === "in_flight") {
    return <span className="rounded-full bg-blue-500/15 text-blue-500 px-2 py-0.5 text-xs font-semibold">In-Flight</span>;
  }
  if (status === "active") {
    return <span className="rounded-full bg-emerald-500/15 text-emerald-500 px-2 py-0.5 text-xs font-semibold">Active Window</span>;
  }
  if (status === "disabled") {
    return <span className="rounded-full bg-neutral-500/15 text-neutral-400 px-2 py-0.5 text-xs">Disabled</span>;
  }
  return <span className="rounded-full bg-neutral-500/10 text-text-muted px-2 py-0.5 text-xs">Idle</span>;
}

export default function QueueMonitorClient() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [paused, setPaused] = useState(false);
  const [activeTab, setActiveTab] = useState("all-keys"); // "all-keys" | "all-providers" | "live-queue"
  const [search, setSearch] = useState("");
  const [resetting, setResetting] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const load = async () => {
    try {
      const res = await fetch("/api/queue", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      setData(j);
      setUpdatedAt(new Date());
      setError("");
    } catch (e) {
      setError(e.message || "Failed to load queue");
    }
  };

  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (!pausedRef.current) load();
    };
    load();
    const id = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const handleReset = async (scope = null, key = null) => {
    if (!confirm(scope ? `Reset concurrency for this ${scope}?` : "Reset all active concurrency slots?")) return;
    setResetting(true);
    try {
      const body = scope && key ? { action: "reset", scope, key } : { action: "reset-all" };
      const res = await fetch("/api/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        await load();
      }
    } catch (err) {
      alert("Failed to reset: " + err.message);
    } finally {
      setResetting(false);
    }
  };

  const keysList = (data?.apiKeys?.items || []).filter((k) =>
    !search || k.name.toLowerCase().includes(search.toLowerCase()) || k.id.toLowerCase().includes(search.toLowerCase())
  );

  const providersList = (data?.providers?.items || []).filter((p) =>
    !search || p.name.toLowerCase().includes(search.toLowerCase()) || p.provider.toLowerCase().includes(search.toLowerCase())
  );

  const activeBuckets = data?.activeBuckets || [];

  return (
    <div className="flex flex-col gap-6">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-main">Request Queue & Concurrency Limits</h1>
          <p className="mt-1 text-sm text-text-muted">
            Inspect real-time RPM, simultaneous concurrency, and queued in-flight requests across all keys and providers.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => handleReset()}
            disabled={resetting}
            title="Clear all in-flight concurrency locks if requests are stuck"
            className="flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-500 hover:bg-red-500/20 transition disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-[16px]">restart_alt</span>
            {resetting ? "Resetting..." : "Reset Concurrency"}
          </button>
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-2 text-xs font-medium hover:bg-surface-2 transition"
          >
            <span className="material-symbols-outlined text-[16px]">{paused ? "play_arrow" : "pause"}</span>
            {paused ? "Resume" : "Pause"}
          </button>
        </div>
      </div>

      {/* KPI Overview Cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card>
          <p className="text-xs uppercase tracking-wide text-text-muted">In-Flight Concurrency</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-blue-500">{data?.totalActiveConcurrent ?? "0"}</p>
          <p className="text-[11px] text-text-muted mt-0.5">active simultaneous streams</p>
        </Card>
        <Card>
          <p className="text-xs uppercase tracking-wide text-text-muted">Total In Queue</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-amber-500">{data?.totalQueued ?? "0"}</p>
          <p className="text-[11px] text-text-muted mt-0.5">waiting for available slot</p>
        </Card>
        <Card>
          <p className="text-xs uppercase tracking-wide text-text-muted">Active Keys</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-text-main">{data?.apiKeys?.total ?? "…"}</p>
          <p className="text-[11px] text-text-muted mt-0.5">configured access tokens</p>
        </Card>
        <Card>
          <p className="text-xs uppercase tracking-wide text-text-muted">Monitor Status</p>
          <p className="mt-1 flex items-center gap-2 text-sm font-semibold">
            <span className={cn("inline-flex size-2 rounded-full", paused ? "bg-text-subtle" : "bg-green-500 animate-pulse")} />
            {paused ? "Paused" : "Live Stream (3s)"}
          </p>
          <p className="text-[11px] text-text-muted mt-0.5">{updatedAt ? `Synced ${updatedAt.toLocaleTimeString()}` : "…"}</p>
        </Card>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-400">{error}</div>
      ) : null}

      {/* Tab Switcher & Filter */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-border pb-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setActiveTab("all-keys")}
            className={cn(
              "px-3.5 py-1.5 text-xs font-semibold rounded-lg transition",
              activeTab === "all-keys"
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-text-muted hover:text-text-main bg-surface-2"
            )}
          >
            🔑 API Keys Limits ({data?.apiKeys?.total || 0})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("all-providers")}
            className={cn(
              "px-3.5 py-1.5 text-xs font-semibold rounded-lg transition",
              activeTab === "all-providers"
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-text-muted hover:text-text-main bg-surface-2"
            )}
          >
            🌐 Provider Connections Limits ({data?.providers?.total || 0})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("live-queue")}
            className={cn(
              "px-3.5 py-1.5 text-xs font-semibold rounded-lg transition flex items-center gap-1.5",
              activeTab === "live-queue"
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-text-muted hover:text-text-main bg-surface-2"
            )}
          >
            ⚡ Live Waiters ({activeBuckets.length})
          </button>
        </div>

        <input
          type="text"
          placeholder="Filter by name, id, provider..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="rounded-lg border border-border bg-input px-3 py-1.5 text-xs text-text-main placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary w-full sm:w-64"
        />
      </div>

      {/* TAB 1: ALL API KEYS LIMITS */}
      {activeTab === "all-keys" && (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-border text-text-muted uppercase tracking-wider font-semibold">
                  <th className="py-2.5 px-3">API Key Name</th>
                  <th className="py-2.5 px-3">Key Token</th>
                  <th className="py-2.5 px-3 text-right">RPM Limit</th>
                  <th className="py-2.5 px-3 text-right">Max Concurrency</th>
                  <th className="py-2.5 px-3 text-right">Queue Timeout</th>
                  <th className="py-2.5 px-3 text-right">In-Flight</th>
                  <th className="py-2.5 px-3 text-right">Queued</th>
                  <th className="py-2.5 px-3 text-center">Status</th>
                  <th className="py-2.5 px-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {keysList.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="py-8 text-center text-text-muted">No API keys match filter.</td>
                  </tr>
                ) : (
                  keysList.map((k) => (
                    <tr key={k.id} className="hover:bg-surface-2/40 transition-colors">
                      <td className="py-2.5 px-3 font-semibold text-text-main">{k.name}</td>
                      <td className="py-2.5 px-3 font-mono text-text-muted">{k.maskedKey}</td>
                      <td className="py-2.5 px-3 text-right font-mono font-medium">
                        {k.rpm > 0 ? `${k.rpm} /min` : <span className="text-text-subtle">Unlimited</span>}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono font-medium">
                        {k.concurrency > 0 ? (
                          <span className="text-blue-500 font-bold">{k.concurrency} concurrent</span>
                        ) : (
                          <span className="text-text-subtle">Unlimited</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono text-text-muted">
                        {k.queueTimeoutMs > 0 ? `${k.queueTimeoutMs}ms` : "0 (Reject)"}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono font-bold">
                        {k.activeConcurrency > 0 ? (
                          <span className="text-blue-500 bg-blue-500/10 px-1.5 py-0.5 rounded">{k.activeConcurrency}</span>
                        ) : (
                          <span className="text-text-subtle">0</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono font-bold">
                        {k.queued > 0 ? (
                          <span className="text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded">{k.queued}</span>
                        ) : (
                          <span className="text-text-subtle">0</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-center">
                        <StatusBadge status={k.status} />
                      </td>
                      <td className="py-2.5 px-3 text-right">
                        {k.activeConcurrency > 0 ? (
                          <button
                            type="button"
                            onClick={() => handleReset("apikey", k.id)}
                            className="text-[11px] text-red-500 hover:underline font-medium"
                          >
                            Release Slot
                          </button>
                        ) : (
                          <span className="text-[11px] text-text-subtle">-</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* TAB 2: ALL PROVIDERS LIMITS */}
      {activeTab === "all-providers" && (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-border text-text-muted uppercase tracking-wider font-semibold">
                  <th className="py-2.5 px-3">Provider</th>
                  <th className="py-2.5 px-3">Connection Name</th>
                  <th className="py-2.5 px-3 text-right">RPM Limit</th>
                  <th className="py-2.5 px-3 text-right">Max Concurrency</th>
                  <th className="py-2.5 px-3 text-right">Queue Timeout</th>
                  <th className="py-2.5 px-3 text-right">In-Flight</th>
                  <th className="py-2.5 px-3 text-right">Queued</th>
                  <th className="py-2.5 px-3 text-center">Status</th>
                  <th className="py-2.5 px-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {providersList.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="py-8 text-center text-text-muted">No provider connections match filter.</td>
                  </tr>
                ) : (
                  providersList.map((p) => (
                    <tr key={p.id} className="hover:bg-surface-2/40 transition-colors">
                      <td className="py-2.5 px-3 font-semibold uppercase text-text-main">{p.provider}</td>
                      <td className="py-2.5 px-3 font-medium text-text-muted truncate max-w-[200px]">{p.name}</td>
                      <td className="py-2.5 px-3 text-right font-mono font-medium">
                        {p.rpm > 0 ? `${p.rpm} /min` : <span className="text-text-subtle">Unlimited</span>}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono font-medium">
                        {p.concurrency > 0 ? (
                          <span className="text-blue-500 font-bold">{p.concurrency} concurrent</span>
                        ) : (
                          <span className="text-text-subtle">Unlimited</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono text-text-muted">
                        {p.queueTimeoutMs > 0 ? `${p.queueTimeoutMs}ms` : "0 (Reject)"}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono font-bold">
                        {p.activeConcurrency > 0 ? (
                          <span className="text-blue-500 bg-blue-500/10 px-1.5 py-0.5 rounded">{p.activeConcurrency}</span>
                        ) : (
                          <span className="text-text-subtle">0</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono font-bold">
                        {p.queued > 0 ? (
                          <span className="text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded">{p.queued}</span>
                        ) : (
                          <span className="text-text-subtle">0</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-center">
                        <StatusBadge status={p.status} />
                      </td>
                      <td className="py-2.5 px-3 text-right">
                        {p.activeConcurrency > 0 ? (
                          <button
                            type="button"
                            onClick={() => handleReset("provider", p.id)}
                            className="text-[11px] text-red-500 hover:underline font-medium"
                          >
                            Release Slot
                          </button>
                        ) : (
                          <span className="text-[11px] text-text-subtle">-</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* TAB 3: LIVE WAITERS & ACTIVE BUCKETS */}
      {activeTab === "live-queue" && (
        <Card>
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-text-main">Currently Active Buckets</h3>
              <p className="text-xs text-text-muted">Buckets that currently have requests waiting in queue, active in-flight, or used within 60s window.</p>
            </div>
            <span className="text-xs rounded-full bg-primary/10 text-primary px-2.5 py-0.5 font-medium font-mono">
              {activeBuckets.length} buckets active
            </span>
          </div>

          {activeBuckets.length === 0 ? (
            <div className="py-12 text-center">
              <span className="material-symbols-outlined text-4xl text-text-subtle">done_all</span>
              <p className="mt-2 text-sm text-text-muted font-medium">All queues are clear. No waiting or in-flight requests right now.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-border text-text-muted uppercase tracking-wider font-semibold">
                    <th className="py-2.5 px-3">Scope</th>
                    <th className="py-2.5 px-3">Target Name</th>
                    <th className="py-2.5 px-3 text-right">In-Flight</th>
                    <th className="py-2.5 px-3 text-right">Queued</th>
                    <th className="py-2.5 px-3 text-right">60s Window Usage</th>
                    <th className="py-2.5 px-3 text-right">Window Reset</th>
                    <th className="py-2.5 px-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {activeBuckets.map((b) => (
                    <tr key={`${b.scope}:${b.key}`} className="hover:bg-surface-2/40 transition-colors">
                      <td className="py-2.5 px-3 font-mono font-bold uppercase text-primary">{b.scope}</td>
                      <td className="py-2.5 px-3 font-medium text-text-main truncate max-w-[200px]">{b.label}</td>
                      <td className="py-2.5 px-3 text-right font-mono font-bold text-blue-500">
                        {b.activeConcurrency || 0}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono font-bold text-amber-500">
                        {b.queued || 0}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono text-text-muted">
                        {b.inWindow} reqs
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono text-text-muted">
                        {(b.windowResetInMs / 1000).toFixed(1)}s
                      </td>
                      <td className="py-2.5 px-3 text-right">
                        <button
                          type="button"
                          onClick={() => handleReset(b.scope, b.key)}
                          className="text-[11px] text-red-500 hover:underline font-medium"
                        >
                          Clear
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
