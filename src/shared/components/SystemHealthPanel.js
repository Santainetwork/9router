"use client";

// Admin System Health panel. Polls /api/health?detail=1 and renders engine,
// backend, limiter and database status. Detail (RSS, pids) needs dashboard
// auth, so a 401 simply renders the hint instead of metrics.

import { useEffect, useRef, useState } from "react";
import Button from "@/shared/components/Button";
import Card from "@/shared/components/Card";
import { cn } from "@/shared/utils/cn";

const POLL_MS = 5000;

function StatusDot({ tone }) {
  const color =
    tone === "ok" ? "bg-emerald-500" : tone === "warn" ? "bg-amber-500" : "bg-red-500";
  return (
    <span className="relative flex size-2.5 shrink-0">
      <span
        className={cn(
          "absolute inline-flex size-full rounded-full opacity-70",
          tone === "ok" && "animate-ping",
          color,
        )}
      />
      <span className={cn("relative inline-flex size-2.5 rounded-full", color)} />
    </span>
  );
}

function Row({ label, value, mono = true }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 border-b border-border/50 last:border-0">
      <span className="text-xs text-text-muted shrink-0">{label}</span>
      <span className={cn("text-xs text-right break-all", mono && "font-mono")}>
        {value ?? "-"}
      </span>
    </div>
  );
}

function fmtUptime(sec) {
  if (!Number.isFinite(sec)) return null;
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${sec % 60}s`;
}

export default function SystemHealthPanel() {
  const [data, setData] = useState(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [error, setError] = useState("");
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/health?detail=1", { cache: "no-store" });
      if (res.status === 401 || res.status === 403) {
        setAuthRequired(true);
        setError("");
        setData(null);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      setData(j);
      setAuthRequired(false);
      setError("");
    } catch (e) {
      setError(e.message || "Failed to load system health");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const tick = () => {
      if (!pausedRef.current) load();
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, []);

  const engine = data?.engine;
  const limiter = engine?.limiter;
  const backend = data?.nextBackend;
  const proc = data?.process;
  const db = data?.database;
  const goActive = engine?.type === "golang";

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="size-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
          <span className="material-symbols-outlined text-[20px]">monitor_heart</span>
        </div>
        <div className="flex-1 min-w-[180px]">
          <h3 className="text-base sm:text-lg font-semibold">System Health</h3>
          <p className="text-xs sm:text-sm text-text-muted">
            Go engine, backend, limiter buckets and database driver.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={load} disabled={loading}>
            Refresh
          </Button>
          <Button variant="secondary" onClick={() => setPaused((p) => !p)}>
            {paused ? "Resume" : "Pause"}
          </Button>
        </div>
      </div>

      {authRequired && (
        <p className="text-xs text-amber-500">
          Admin auth required to read process metrics. Reload the dashboard with an authenticated
          session.
        </p>
      )}
      {error && !authRequired && <p className="text-xs text-red-500">{error}</p>}

      {data && !authRequired && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Go engine */}
          <div className="rounded-lg border border-border p-3">
            <div className="flex items-center gap-2 mb-2">
              <StatusDot tone={goActive ? "ok" : "warn"} />
              <p className="text-sm font-semibold">Go Engine</p>
              <span
                className={cn(
                  "ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded",
                  goActive ? "bg-cyan-500/10 text-cyan-500" : "bg-amber-500/10 text-amber-500",
                )}
              >
                {goActive ? "active" : "fallback"}
              </span>
            </div>
            <Row label="Engine" value={engine?.version || engine?.type} />
            <Row label="Limiter URL" value={limiter?.url} />
            <Row label="Limiter port" value={limiter?.port} />
            <Row label="Limiter probe" value={limiter?.reachable ? `${limiter.probeLatencyMs}ms` : "unreachable"} />
            <Row label="Gateway port" value={engine?.gateway?.port} />
            <Row label="Public proxy" value={engine?.publicProxy?.configured ? engine.publicProxy.port : "disabled"} />
            <Row label="Buckets" value={limiter?.totalBuckets} />
            <Row label="Queued" value={limiter?.totalQueued} />
            <Row label="In-flight" value={limiter?.totalActiveConcurrent} />
            <Row label="Scope / conc / rpm" value={`${engine?.config?.scope} / ${engine?.config?.proxyConcurrency} / ${engine?.config?.proxyRpm}`} />
          </div>

          {/* Backend + process */}
          <div className="rounded-lg border border-border p-3">
            <div className="flex items-center gap-2 mb-2">
              <StatusDot tone={backend?.ok ? "ok" : "err"} />
              <p className="text-sm font-semibold">Next Backend</p>
              <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded bg-bg">
                {backend?.ok ? `${backend.latencyMs}ms` : "down"}
              </span>
            </div>
            <Row label="URL" value={backend?.url} />
            <Row label="HTTP" value={backend?.status} />
            <Row label="Version" value={backend?.version} />
            <Row label="PID" value={proc?.pid} />
            <Row label="Uptime" value={fmtUptime(proc?.uptimeSec)} />
            <Row label="RSS" value={proc ? `${proc.rssMb} MB` : null} />
            <Row label="Heap used" value={proc ? `${proc.heapUsedMb} / ${proc.heapTotalMb} MB` : null} />
            <Row label="Node" value={proc?.node} />
          </div>

          {/* Database */}
          <div className="rounded-lg border border-border p-3">
            <div className="flex items-center gap-2 mb-2">
              <StatusDot tone="ok" />
              <p className="text-sm font-semibold">Database</p>
              <span
                className={cn(
                  "ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded",
                  db?.type === "postgres"
                    ? "bg-indigo-500/10 text-indigo-400"
                    : "bg-emerald-500/10 text-emerald-500",
                )}
              >
                {db?.type}
              </span>
            </div>
            <Row label="Driver" value={db?.driver || db?.type} />
            <Row label="Target" value={db?.target} />
            <Row label="Updated" value={data.at ? new Date(data.at).toLocaleTimeString() : null} />
          </div>
        </div>
      )}
    </Card>
  );
}
