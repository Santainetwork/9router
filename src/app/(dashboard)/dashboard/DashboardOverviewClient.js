"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Card, CardSkeleton } from "@/shared/components";
import { cn } from "@/shared/utils/cn";

function fmt(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + "M";
  if (v >= 1_000) return (v / 1_000).toFixed(1) + "k";
  return String(Math.round(v));
}

function money(n) {
  return "$" + (Number(n) || 0).toFixed(2);
}

function timeAgo(ts) {
  if (!ts) return "";
  const diff = Date.now() - new Date(ts).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function StatCard({ icon, label, value, sub, href, color = "primary" }) {
  const colorMap = {
    primary: "bg-primary/10 text-primary border-primary/20",
    blue: "bg-blue-500/10 text-blue-500 border-blue-500/20",
    amber: "bg-amber-500/10 text-amber-500 border-amber-500/20",
    emerald: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20",
  };

  const content = (
    <div className="h-full rounded-2xl border border-border bg-surface p-5 transition-all hover:border-primary/40 hover:shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-wider font-semibold text-text-muted">{label}</p>
          <p className="mt-2 text-2xl font-bold tabular-nums tracking-tight text-text-main">{value}</p>
          {sub ? <p className="mt-1 text-xs text-text-muted truncate">{sub}</p> : null}
        </div>
        <div className={cn("flex size-11 shrink-0 items-center justify-center rounded-xl border", colorMap[color] || colorMap.primary)}>
          <span className="material-symbols-outlined text-[22px]">{icon}</span>
        </div>
      </div>
    </div>
  );

  return href ? (
    <Link href={href} className="block group">
      {content}
    </Link>
  ) : (
    content
  );
}

const QUICK_ACTIONS = [
  { href: "/dashboard/api-keys", label: "Key Limits", icon: "tune", badge: "Wildcard" },
  { href: "/dashboard/providers", label: "Providers", icon: "dns", badge: "Live" },
  { href: "/dashboard/combos", label: "Combos & Vision", icon: "layers" },
  { href: "/dashboard/queue-monitor", label: "Request Queue", icon: "pending_actions", badge: "Throttled" },
  { href: "/dashboard/leaderboard", label: "Leaderboard", icon: "leaderboard" },
  { href: "/dashboard/usage", label: "Analytics & Logs", icon: "bar_chart" },
  { href: "/dashboard/model-probe", label: "Model Probe", icon: "verified_user" },
  { href: "/dashboard/basic-chat", label: "Basic Chat", icon: "chat" },
];

export default function DashboardOverviewClient() {
  const [providers, setProviders] = useState([]);
  const [keys, setKeys] = useState([]);
  const [stats, setStats] = useState(null);
  const [queue, setQueue] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [pRes, kRes, sRes] = await Promise.all([
          fetch("/api/providers", { cache: "no-store" }).catch(() => null),
          fetch("/api/keys", { cache: "no-store" }).catch(() => null),
          fetch("/api/usage/stats?period=7d", { cache: "no-store" }).catch(() => null),
        ]);
        if (!alive) return;
        if (pRes?.ok) {
          const d = await pRes.json();
          setProviders(Array.isArray(d.connections) ? d.connections : []);
        }
        if (kRes?.ok) {
          const d = await kRes.json();
          setKeys(Array.isArray(d.keys) ? d.keys : []);
        }
        if (sRes?.ok) setStats(await sRes.json());
      } catch (e) {
        if (alive) setError(e.message || "Failed to load overview");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  // Live Queue & Concurrency polling (every 5s)
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/queue", { cache: "no-store" });
        if (res.ok && alive) setQueue(await res.json());
      } catch {}
    };
    load();
    const id = setInterval(load, 5000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const providerSummary = useMemo(() => {
    const active = providers.filter((p) => p.isActive !== false).length;
    const healthy = providers.filter((p) => p.testStatus === "active").length;
    return { total: providers.length, active, healthy };
  }, [providers]);

  const keySummary = useMemo(() => {
    const active = keys.filter((k) => k.isActive !== false).length;
    const withQuota = keys.filter((k) => (k.tokenQuota ?? 0) > 0).length;
    const withConcurrency = keys.filter((k) => (k.concurrency ?? 0) > 0).length;
    return { total: keys.length, active, withQuota, withConcurrency };
  }, [keys]);

  const recent = stats?.recentRequests || [];
  const totalInFlight = queue?.totalActiveConcurrent ?? 0;
  const totalQueued = queue?.totalQueued ?? 0;

  if (loading) {
    return (
      <div className="flex flex-col gap-6 max-w-7xl mx-auto py-2">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => <CardSkeleton key={i} />)}
        </div>
        <CardSkeleton />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 max-w-7xl mx-auto py-2">
      {/* Top Welcome & Health Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-border/70 pb-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-main flex items-center gap-2.5">
            <span className="material-symbols-outlined text-primary text-[26px]">space_dashboard</span>
            Gateway Dashboard
          </h1>
          <p className="text-sm text-text-muted mt-1">
            Real-time multi-model router with zero-leak concurrency control and automatic request queuing.
          </p>
        </div>

        <div className="flex items-center gap-2.5 self-start sm:self-auto flex-wrap">
          {queue?.engine && (
            <Link
              href="/dashboard/queue-monitor"
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border shadow-xs transition-colors",
                queue.engine.type === "golang"
                  ? "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-cyan-500/20 hover:bg-cyan-500/20"
                  : "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20 hover:bg-amber-500/20"
              )}
              title={queue.engine.type === "golang" ? "Limiter: Go Hybrid Daemon Active on :20129" : "Limiter: JavaScript Fallback Active"}
            >
              <span className={cn("size-2 rounded-full", queue.engine.type === "golang" ? "bg-cyan-500 animate-pulse" : "bg-amber-500")} />
              {queue.engine.type === "golang" ? "Engine: Go Hybrid (:20129)" : "Engine: JS Fallback"}
            </Link>
          )}
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-semibold bg-emerald-500/10 text-emerald-600 border border-emerald-500/20 shadow-xs">
            <span className="size-2 rounded-full bg-emerald-500 animate-pulse" />
            Port 20128 Active
          </div>
        </div>
      </div>

      {error ? (
        <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-400">
          {error}
        </div>
      ) : null}

      {/* Primary Bento KPI Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon="dns"
          label="Providers"
          value={providerSummary.active}
          sub={`${providerSummary.healthy} online · ${providerSummary.total} total`}
          href="/dashboard/providers"
          color="emerald"
        />
        <StatCard
          icon="key"
          label="API Access Keys"
          value={keySummary.active}
          sub={`${keySummary.withConcurrency} rate limited · ${keySummary.total} keys`}
          href="/dashboard/api-keys"
          color="primary"
        />
        <StatCard
          icon="swap_horiz"
          label="In-Flight / Queue"
          value={`${totalInFlight} in-flight`}
          sub={totalQueued > 0 ? `${totalQueued} waiting in queue` : "all queues clear"}
          href="/dashboard/queue-monitor"
          color="blue"
        />
        <StatCard
          icon="payments"
          label="Volume (7 Days)"
          value={money(stats?.totalCost || 0)}
          sub={`${fmt(stats?.totalRequests || 0)} reqs · ${fmt((stats?.totalPromptTokens || 0) + (stats?.totalCompletionTokens || 0))} tok`}
          href="/dashboard/usage"
          color="amber"
        />
      </div>

      {/* Quick Action Navigation Strip */}
      <div className="rounded-2xl border border-border bg-surface p-5 shadow-xs">
        <div className="flex items-center justify-between mb-3">
          <p className="text-[11px] font-bold uppercase tracking-wider text-text-muted">
            Quick Actions & Management
          </p>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          {QUICK_ACTIONS.map((a) => (
            <Link
              key={a.href}
              href={a.href}
              className="flex items-center justify-between p-3 rounded-xl border border-border/80 bg-surface-2/20 hover:bg-surface-2 hover:border-primary/40 transition-all group"
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="material-symbols-outlined text-[20px] text-primary group-hover:scale-110 transition-transform">
                  {a.icon}
                </span>
                <span className="text-xs font-semibold text-text-main truncate">
                  {a.label}
                </span>
              </div>
              {a.badge ? (
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20">
                  {a.badge}
                </span>
              ) : null}
            </Link>
          ))}
        </div>
      </div>

      {/* 2-Column Activity Bento Grid */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Recent Requests Stream */}
        <div className="rounded-2xl border border-border bg-surface p-5 shadow-xs flex flex-col">
          <div className="flex items-center justify-between mb-3.5">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-text-muted text-[20px]">history</span>
              <p className="text-sm font-semibold text-text-main">Recent Activity</p>
            </div>
            <Link
              href="/dashboard/usage?tab=logs"
              className="text-xs text-primary hover:underline font-medium"
            >
              View All Logs
            </Link>
          </div>

          {recent.length === 0 ? (
            <div className="py-8 text-center text-xs text-text-muted border border-dashed border-border rounded-xl">
              No recent requests recorded yet.
            </div>
          ) : (
            <div className="divide-y divide-border/60 flex-1">
              {recent.slice(0, 6).map((r, i) => (
                <div key={i} className="flex items-center justify-between gap-3 py-2.5 text-xs">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-text-main font-mono">
                      {r.model || "unknown"}
                    </p>
                    <p className="truncate text-[11px] text-text-muted">
                      {r.provider || "gateway"}{r.requestedModel && r.requestedModel !== r.model ? ` · via ${r.requestedModel}` : ""}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-mono text-text-main font-medium">
                      {fmt((r.promptTokens || 0) + (r.completionTokens || 0))} tok
                    </p>
                    <p className="text-[10px] text-text-muted">{timeAgo(r.timestamp)}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Top API Keys Bento */}
        <div className="rounded-2xl border border-border bg-surface p-5 shadow-xs flex flex-col">
          <div className="flex items-center justify-between mb-3.5">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-text-muted text-[20px]">leaderboard</span>
              <p className="text-sm font-semibold text-text-main">Top Keys by Token Volume</p>
            </div>
            <Link
              href="/dashboard/leaderboard"
              className="text-xs text-primary hover:underline font-medium"
            >
              Leaderboard
            </Link>
          </div>

          {keys.length === 0 ? (
            <div className="py-8 text-center text-xs text-text-muted border border-dashed border-border rounded-xl">
              No API keys configured.
            </div>
          ) : (
            <div className="divide-y divide-border/60 flex-1">
              {[...keys]
                .sort((a, b) => (b.tokensUsed || 0) - (a.tokensUsed || 0))
                .slice(0, 6)
                .map((k) => (
                  <div key={k.id} className="flex items-center justify-between gap-3 py-2.5 text-xs">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-text-main">
                        {k.name || "Unnamed Key"}
                      </p>
                      <p className="truncate text-[10px] font-mono text-text-muted">
                        {k.key ? `${k.key.slice(0, 8)}...${k.key.slice(-4)}` : ""}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <span className="font-mono font-medium text-text-main">
                        {fmt(k.tokensUsed || 0)} tok
                      </span>
                      <p className="text-[10px] text-text-muted">
                        {k.concurrency > 0 ? `${k.concurrency} concurrent` : "unlimited"}
                      </p>
                    </div>
                  </div>
                ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
