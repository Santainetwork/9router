"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

function StatusBadge({ status }) {
  if (status === "full") {
    return <Badge variant="destructive">Full Cap</Badge>;
  }
  if (status === "queued") {
    return <Badge variant="warning">Queued</Badge>;
  }
  if (status === "in_flight") {
    return (
      <Badge variant="default" className="bg-blue-500/10 text-blue-500 border-blue-500/20">
        In-Flight
      </Badge>
    );
  }
  if (status === "active") {
    return <Badge variant="success">Active</Badge>;
  }
  if (status === "disabled") {
    return <Badge variant="secondary">Disabled</Badge>;
  }
  return <Badge variant="outline" className="text-text-muted">Idle</Badge>;
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
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const handleReset = async (scope = null, key = null) => {
    setResetting(true);
    try {
      const body = scope && key ? { scope, key } : {};
      const res = await fetch("/api/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        await load();
      }
    } catch (e) {
      console.log("Reset error:", e);
    } finally {
      setResetting(false);
    }
  };

  const activeBuckets = useMemo(() => {
    return data?.buckets || data?.activeBuckets || [];
  }, [data]);

  const keysList = useMemo(() => {
    const raw = data?.apiKeys?.items || data?.apiKeys?.list;
    if (!Array.isArray(raw)) return [];
    let list = raw;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (k) =>
          k.name?.toLowerCase().includes(q) ||
          k.maskedKey?.toLowerCase().includes(q) ||
          k.id?.toLowerCase().includes(q)
      );
    }
    return list;
  }, [data?.apiKeys?.items, data?.apiKeys?.list, search]);

  const providersList = useMemo(() => {
    const raw = data?.providers?.items || data?.providers?.list;
    if (!Array.isArray(raw)) return [];
    let list = raw;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (p) =>
          p.name?.toLowerCase().includes(q) ||
          p.provider?.toLowerCase().includes(q) ||
          p.id?.toLowerCase().includes(q)
      );
    }
    return list;
  }, [data?.providers?.items, data?.providers?.list, search]);

  return (
    <div className="flex flex-col gap-6 max-w-7xl mx-auto py-2">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border/70 pb-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-main flex items-center gap-2.5">
            <span className="material-symbols-outlined text-primary text-[26px]">pending_actions</span>
            Concurrency & Queue Engine
          </h1>
          <p className="text-sm text-text-muted mt-1">
            Real-time in-flight slot tracking, auto-buffering queues, and emergency slot release controls.
          </p>
        </div>

        <div className="flex items-center gap-2.5 self-start sm:self-auto">
          <Button
            variant="destructive"
            size="sm"
            onClick={() => handleReset()}
            disabled={resetting}
            title="Force-clear all active in-flight slot locks if requests are stuck"
            className="flex items-center gap-1.5"
          >
            <span className="material-symbols-outlined text-[16px]">restart_alt</span>
            {resetting ? "Resetting..." : "Reset All Locks"}
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={() => setPaused((p) => !p)}
            className="flex items-center gap-1.5"
          >
            <span className="material-symbols-outlined text-[16px]">
              {paused ? "play_arrow" : "pause"}
            </span>
            {paused ? "Resume" : "Pause"}
          </Button>
        </div>
      </div>

      {/* 4 Bento KPI Overview Cards */}
      {/* Engine Architecture Indicator Banner */}
      <div className={cn(
        "rounded-2xl border p-4 shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3",
        data?.engine?.type === "golang"
          ? "bg-cyan-500/[0.04] border-cyan-500/25"
          : "bg-amber-500/[0.04] border-amber-500/25"
      )}>
        <div className="flex items-center gap-3">
          <div className={cn(
            "p-2.5 rounded-xl flex items-center justify-center",
            data?.engine?.type === "golang" ? "bg-cyan-500/10 text-cyan-500" : "bg-amber-500/10 text-amber-500"
          )}>
            <span className="material-symbols-outlined text-[22px]">memory</span>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-text-main">
                {data?.engine?.type === "golang" ? "Golang Hybrid Concurrency Engine" : "JavaScript In-Memory Limiter"}
              </span>
              <Badge variant={data?.engine?.type === "golang" ? "default" : "warning"} className={cn(
                data?.engine?.type === "golang" ? "bg-cyan-500 text-white font-mono text-[10px]" : "text-[10px]"
              )}>
                {data?.engine?.type === "golang" ? "Active (:20129)" : "Fallback Mode"}
              </Badge>
            </div>
            <p className="text-xs text-text-muted mt-0.5">
              {data?.engine?.type === "golang"
                ? "High-speed Go daemon handling atomic slot management, in-flight semaphores, and automated 10m idle bucket eviction."
                : "Node.js fallback limiter active (Go hybrid engine offline or disabled)."}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4 text-xs font-mono text-text-muted shrink-0 self-end sm:self-center">
          <div>
            <span className="text-[10px] uppercase tracking-wider block text-text-muted">Tracked Buckets</span>
            <span className="font-semibold text-text-main text-sm">{data?.engine?.totalBuckets ?? 0}</span>
          </div>
          <div className="h-6 w-px bg-border/70" />
          <div>
            <span className="text-[10px] uppercase tracking-wider block text-text-muted">Memory Guard</span>
            <span className="text-emerald-500 font-medium">Idle Reaping 10m</span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-2xl border border-border bg-surface p-4 shadow-xs">
          <p className="text-[11px] uppercase tracking-wider font-semibold text-text-muted">In-Flight Concurrency</p>
          <p className="mt-1.5 text-2xl font-bold tabular-nums text-blue-500">
            {data?.totalActiveConcurrent ?? 0}
          </p>
          <p className="text-[11px] text-text-muted mt-0.5">active concurrent streams</p>
        </div>

        <div className="rounded-2xl border border-border bg-surface p-4 shadow-xs">
          <p className="text-[11px] uppercase tracking-wider font-semibold text-text-muted">Waiting In Queue</p>
          <p className="mt-1.5 text-2xl font-bold tabular-nums text-amber-500">
            {data?.totalQueued ?? 0}
          </p>
          <p className="text-[11px] text-text-muted mt-0.5">requests buffered in queue</p>
        </div>

        <div className="rounded-2xl border border-border bg-surface p-4 shadow-xs">
          <p className="text-[11px] uppercase tracking-wider font-semibold text-text-muted">Configured Keys</p>
          <p className="mt-1.5 text-2xl font-bold tabular-nums text-text-main">
            {data?.apiKeys?.total ?? "..."}
          </p>
          <p className="text-[11px] text-text-muted mt-0.5">governed access tokens</p>
        </div>

        <div className="rounded-2xl border border-border bg-surface p-4 shadow-xs">
          <p className="text-[11px] uppercase tracking-wider font-semibold text-text-muted">Engine Status</p>
          <div className="mt-1.5 flex items-center gap-2 text-sm font-semibold">
            <span
              className={cn(
                "inline-flex size-2 rounded-full",
                paused ? "bg-text-subtle" : "bg-emerald-500 animate-pulse"
              )}
            />
            <span className={paused ? "text-text-muted" : "text-emerald-600 dark:text-emerald-400"}>
              {paused ? "Paused" : "Live Polling (3s)"}
            </span>
          </div>
          <p className="text-[10px] text-text-muted mt-0.5 font-mono">
            {updatedAt ? `Synced ${updatedAt.toLocaleTimeString()}` : "Syncing..."}
          </p>
        </div>
      </div>

      {error ? (
        <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-400">
          {error}
        </div>
      ) : null}

      {/* Main Table Card with Tabs and Search */}
      <div className="rounded-2xl border border-border bg-surface shadow-xs overflow-hidden flex flex-col">
        {/* Controls toolbar */}
        <div className="p-4 border-b border-border flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-surface-2/20">
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              type="button"
              onClick={() => setActiveTab("all-keys")}
              className={cn(
                "px-3 py-1.5 text-xs font-semibold rounded-xl transition-all",
                activeTab === "all-keys"
                  ? "bg-primary text-white shadow-xs"
                  : "text-text-muted hover:text-text-main bg-surface border border-border"
              )}
            >
              API Keys Limits ({data?.apiKeys?.total || 0})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("all-providers")}
              className={cn(
                "px-3 py-1.5 text-xs font-semibold rounded-xl transition-all",
                activeTab === "all-providers"
                  ? "bg-primary text-white shadow-xs"
                  : "text-text-muted hover:text-text-main bg-surface border border-border"
              )}
            >
              Provider Connections ({data?.providers?.total || 0})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("live-queue")}
              className={cn(
                "px-3 py-1.5 text-xs font-semibold rounded-xl transition-all flex items-center gap-1.5",
                activeTab === "live-queue"
                  ? "bg-primary text-white shadow-xs"
                  : "text-text-muted hover:text-text-main bg-surface border border-border"
              )}
            >
              Live Waiters ({activeBuckets.length})
            </button>
          </div>

          <div className="relative w-full sm:w-64">
            <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted text-[16px]">
              search
            </span>
            <input
              type="text"
              placeholder="Search key, provider, id..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-xl border border-border bg-input pl-8 pr-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        </div>

        {/* TAB 1: API KEYS */}
        {activeTab === "all-keys" && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Key Name</TableHead>
                <TableHead>Token Mask</TableHead>
                <TableHead className="text-right">RPM</TableHead>
                <TableHead className="text-right">Capacity & In-Flight</TableHead>
                <TableHead className="text-right">Buffer Timeout</TableHead>
                <TableHead className="text-right">Queued</TableHead>
                <TableHead className="text-center">Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keysList.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-8 text-center text-text-muted">
                    No API keys match filter.
                  </TableCell>
                </TableRow>
              ) : (
                keysList.map((k) => {
                  const cap = k.concurrency || 0;
                  const active = k.activeConcurrency || 0;
                  const pct = cap > 0 ? Math.min(100, Math.round((active / cap) * 100)) : 0;

                  return (
                    <TableRow key={k.id}>
                      <TableCell className="font-semibold text-text-main">
                        {k.name || "Unnamed"}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-text-muted">
                        {k.maskedKey}
                      </TableCell>
                      <TableCell className="text-right font-mono font-medium text-xs">
                        {k.rpm > 0 ? `${k.rpm} /min` : <span className="text-text-muted">Unl</span>}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex flex-col items-end gap-1 min-w-[120px]">
                          <div className="text-xs font-mono font-bold">
                            <span className={active > 0 ? "text-blue-500" : "text-text-muted"}>
                              {active}
                            </span>
                            <span className="text-text-muted font-normal"> / {cap > 0 ? cap : "Unl"}</span>
                          </div>
                          {cap > 0 ? (
                            <div className="h-1.5 w-24 rounded-full bg-border overflow-hidden">
                              <div
                                className={cn(
                                  "h-full rounded-full transition-all",
                                  pct >= 100 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-emerald-500"
                                )}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-text-muted">
                        {k.queueTimeoutMs > 0
                          ? `${k.queueTimeoutMs >= 1000 ? Math.round(k.queueTimeoutMs / 1000) : k.queueTimeoutMs}s`
                          : "60s (def)"}
                      </TableCell>
                      <TableCell className="text-right font-mono font-bold text-xs">
                        {k.queued > 0 ? (
                          <span className="text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded">
                            {k.queued}
                          </span>
                        ) : (
                          <span className="text-text-muted">0</span>
                        )}
                      </TableCell>
                      <TableCell className="text-center">
                        <StatusBadge status={k.status} />
                      </TableCell>
                      <TableCell className="text-right">
                        {active > 0 ? (
                          <button
                            type="button"
                            onClick={() => handleReset("apikey", k.id)}
                            className="text-xs text-red-500 hover:underline font-medium"
                          >
                            Release Slot
                          </button>
                        ) : (
                          <span className="text-xs text-text-muted">-</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        )}

        {/* TAB 2: PROVIDERS */}
        {activeTab === "all-providers" && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead>Connection Name</TableHead>
                <TableHead className="text-right">RPM</TableHead>
                <TableHead className="text-right">Capacity & In-Flight</TableHead>
                <TableHead className="text-right">Buffer Timeout</TableHead>
                <TableHead className="text-right">Queued</TableHead>
                <TableHead className="text-center">Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {providersList.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-8 text-center text-text-muted">
                    No provider connections match filter.
                  </TableCell>
                </TableRow>
              ) : (
                providersList.map((p) => {
                  const cap = p.concurrency || 0;
                  const active = p.activeConcurrency || 0;
                  const pct = cap > 0 ? Math.min(100, Math.round((active / cap) * 100)) : 0;

                  return (
                    <TableRow key={p.id}>
                      <TableCell className="font-semibold uppercase text-text-main text-xs">
                        {p.provider}
                      </TableCell>
                      <TableCell className="font-medium text-text-muted text-xs truncate max-w-[200px]">
                        {p.name}
                      </TableCell>
                      <TableCell className="text-right font-mono font-medium text-xs">
                        {p.rpm > 0 ? `${p.rpm} /min` : <span className="text-text-muted">Unl</span>}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex flex-col items-end gap-1 min-w-[120px]">
                          <div className="text-xs font-mono font-bold">
                            <span className={active > 0 ? "text-blue-500" : "text-text-muted"}>
                              {active}
                            </span>
                            <span className="text-text-muted font-normal"> / {cap > 0 ? cap : "Unl"}</span>
                          </div>
                          {cap > 0 ? (
                            <div className="h-1.5 w-24 rounded-full bg-border overflow-hidden">
                              <div
                                className={cn(
                                  "h-full rounded-full transition-all",
                                  pct >= 100 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-emerald-500"
                                )}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-text-muted">
                        {p.queueTimeoutMs > 0
                          ? `${p.queueTimeoutMs >= 1000 ? Math.round(p.queueTimeoutMs / 1000) : p.queueTimeoutMs}s`
                          : "60s (def)"}
                      </TableCell>
                      <TableCell className="text-right font-mono font-bold text-xs">
                        {p.queued > 0 ? (
                          <span className="text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded">
                            {p.queued}
                          </span>
                        ) : (
                          <span className="text-text-muted">0</span>
                        )}
                      </TableCell>
                      <TableCell className="text-center">
                        <StatusBadge status={p.status} />
                      </TableCell>
                      <TableCell className="text-right">
                        {active > 0 ? (
                          <button
                            type="button"
                            onClick={() => handleReset("provider", p.id)}
                            className="text-xs text-red-500 hover:underline font-medium"
                          >
                            Release Slot
                          </button>
                        ) : (
                          <span className="text-xs text-text-muted">-</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        )}

        {/* TAB 3: LIVE WAITERS */}
        {activeTab === "live-queue" && (
          <div className="p-4">
            {activeBuckets.length === 0 ? (
              <div className="py-12 text-center text-xs text-text-muted border border-dashed border-border rounded-xl">
                All queues clear. No requests currently waiting.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Scope</TableHead>
                    <TableHead>Target ID</TableHead>
                    <TableHead className="text-right">Active In-Flight</TableHead>
                    <TableHead className="text-right">Waiting in Queue</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {activeBuckets.map((b) => (
                    <TableRow key={`${b.scope}-${b.key}`}>
                      <TableCell className="font-semibold text-xs capitalize">{b.scope}</TableCell>
                      <TableCell className="font-mono text-xs text-text-muted">{b.key}</TableCell>
                      <TableCell className="text-right font-mono font-bold text-blue-500 text-xs">
                        {b.activeConcurrency}
                      </TableCell>
                      <TableCell className="text-right font-mono font-bold text-amber-500 text-xs">
                        {b.queued}
                      </TableCell>
                      <TableCell className="text-right">
                        <button
                          type="button"
                          onClick={() => handleReset(b.scope, b.key)}
                          className="text-xs text-red-500 hover:underline font-medium"
                        >
                          Clear
                        </button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
