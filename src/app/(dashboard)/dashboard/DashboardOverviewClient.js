"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Card, CardSkeleton } from "@/shared/components";
import { cn } from "@/shared/utils/cn";

// Dashboard home / overview. Aggregates providers, API keys, live concurrency/queue,
// and usage into a clean at-a-glance landing page with quick links into each section.

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
    primary: "bg-primary/10 text-primary",
    blue: "bg-blue-500/10 text-blue-500",
    amber: "bg-amber-500/10 text-amber-500",
    emerald: "bg-emerald-500/10 text-emerald-500",
  };

  const body = (
    <Card className="h-full hover:border-border transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wider font-medium text-text-muted">{label}</p>
          <p className="mt-1.5 text-2xl font-bold tabular-nums tracking-tight text-text-main">{value}</p>
          {sub ? <p className="mt-1 text-xs text-text-muted truncate">{sub}</p> : null}
        </div>
        <div className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl", colorMap[color] || colorMap.primary)}>
          <span className="material-symbols-outlined text-[22px]">{icon}</span>
        </div>
      </div>
    </Card>
  );
  return href ? <Link href={href} className="block transition hover:opacity-95">{body}</Link> : body;
}

const QUICK_LINKS = [
  { href: "/dashboard/endpoint", label: "Endpoint & Key", icon: "api" },
  { href: "/dashboard/api-keys", label: "Key Access Control", icon: "tune" },
  { href: "/dashboard/providers", label: "Providers", icon: "dns" },
  { href: "/dashboard/basic-chat", label: "Basic Chat", icon: "chat" },
  { href: "/dashboard/rpm-tester", label: "Rate & Concurrency Tester", icon: "speed" },
  { href: "/dashboard/queue-monitor", label: "Request Queue", icon: "pending_actions" },
  { href: "/dashboard/leaderboard", label: "Leaderboard", icon: "leaderboard" },
  { href: "/dashboard/custom-credits", label: "Custom Credits", icon: "account_balance_wallet" },
  { href: "/dashboard/usage", label: "Usage & Logs", icon: "bar_chart" },
  { href: "/dashboard/quota", label: "Quota Tracker", icon: "data_usage" },
  { href: "/dashboard/combos", label: "Combos & Fallback", icon: "layers" },
  { href: "/dashboard/token-saver", label: "Token Saver", icon: "savings" },
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

  // Live RPM + Concurrency queue monitor polling (every 5s)
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/queue", { cache: "no-store" });
        if (res.ok && alive) setQueue(await res.json());
      } catch { /* transient */ }
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
  const activeBuckets = queue?.buckets || queue?.activeBuckets || [];
  const totalInFlight = queue?.totalActiveConcurrent ?? 0;
  const totalQueued = queue?.totalQueued ?? 0;

  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => <CardSkeleton key={i} />)}
        </div>
        <CardSkeleton />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-main">System Overview</h1>
          <p className="text-sm text-text-muted mt-1">Real-time status, active connections, and usage metrics.</p>
        </div>
        <div className="flex items-center gap-2 self-start sm:self-auto">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-600 border border-emerald-500/20">
            <span className="size-2 rounded-full bg-emerald-500 animate-pulse" />
            Gateway Online
          </span>
          <span className="text-xs text-text-muted font-mono">Port 20128</span>
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-400">{error}</div>
      ) : null}

      {/* Primary KPI Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon="dns"
          label="Provider Connections"
          value={providerSummary.active}
          sub={`${providerSummary.healthy} active · ${providerSummary.total} configured`}
          href="/dashboard/providers"
          color="emerald"
        />
        <StatCard
          icon="key"
          label="API Access Keys"
          value={keySummary.active}
          sub={`${keySummary.withConcurrency} with concurrency · ${keySummary.withQuota} with quota`}
          href="/dashboard/api-keys"
          color="primary"
        />
        <StatCard
          icon="swap_horiz"
          label="Live In-Flight / Queue"
          value={`${totalInFlight} in-flight`}
          sub={totalQueued > 0 ? `${totalQueued} waiting in queue` : "all queues clear"}
          href="/dashboard/queue-monitor"
          color="blue"
        />
        <StatCard
          icon="payments"
          label="Cost (Last 7 Days)"
          value={money(stats?.totalCost || 0)}
          sub={`${fmt(stats?.totalRequests || 0)} reqs · ${fmt((stats?.totalPromptTokens || 0) + (stats?.totalCompletionTokens || 0))} tok`}
          href="/dashboard/usage"
          color="amber"
        />
      </div>

      {/* Quick Navigation Shortcuts */}
      <Card>
        <p className="text-xs uppercase tracking-wider font-semibold text-text-muted mb-3">Quick Navigation</p>
        <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {QUICK_LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="flex items-center gap-2.5 rounded-lg border border-border bg-surface px-3 py-2.5 text-xs font-medium text-text-main transition hover:bg-surface-2 hover:border-primary/40"
            >
              <span className="material-symbols-outlined text-[18px] text-primary">{l.icon}</span>
              <span className="truncate">{l.label}</span>
            </Link>
          ))}
        </div>
      </Card>

      {/* 2-Column Activity Breakdown */}
      <div className="grid gap-6 lg:grid-cols-2">
        
        {/* Recent Requests Stream */}
        <Card>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-text-muted text-[18px]">history</span>
              <p className="text-sm font-semibold text-text-main">Recent Gateway Requests</p>
            </div>
            <Link href="/dashboard/usage?tab=logs" className="text-xs text-primary hover:underline font-medium">View All Logs</Link>
          </div>
          {recent.length === 0 ? (
            <p className="text-sm text-text-muted py-6 text-center">No recent requests recorded yet.</p>
          ) : (
            <div className="flex flex-col divide-y divide-border">
              {recent.slice(0, 7).map((r, i) => (
                <div key={i} className="flex items-center justify-between gap-3 py-2 text-xs">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-text-main font-mono">{r.model || "unknown"}</p>
                    <p className="truncate text-[11px] text-text-muted">{r.provider || "gateway"}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-mono text-text-main tabular-nums font-medium">
                      {fmt((r.promptTokens || 0) + (r.completionTokens || 0))} tok
                    </p>
                    <p className="text-[10px] text-text-muted">{timeAgo(r.timestamp)}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Top Keys by Volume */}
        <Card>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-text-muted text-[18px]">key</span>
              <p className="text-sm font-semibold text-text-main">Top API Keys by Token Usage</p>
            </div>
            <Link href="/dashboard/leaderboard" className="text-xs text-primary hover:underline font-medium">Full Leaderboard</Link>
          </div>
          {keys.length === 0 ? (
            <p className="text-sm text-text-muted py-6 text-center">No active API keys found.</p>
          ) : (
            <div className="flex flex-col divide-y divide-border">
              {[...keys]
                .sort((a, b) => (b.tokensUsed || 0) - (a.tokensUsed || 0))
                .slice(0, 5)
                .map((k) => {
                  const quota = k.tokenQuota ?? 0;
                  const used = k.tokensUsed ?? 0;
                  const pct = quota > 0 ? Math.min(100, Math.round((used / quota) * 100)) : 0;
                  return (
                    <div key={k.id} className="py-2 text-xs">
                      <div className="flex items-center justify-between gap-3">
                        <span className="truncate font-semibold text-text-main">{k.name || "Unnamed Key"}</span>
                        <span className="tabular-nums font-mono text-text-muted">
                          {fmt(used)}{quota > 0 ? ` / ${fmt(quota)}` : " tok"}
                        </span>
                      </div>
                      {quota > 0 ? (
                        <div className="mt-1 h-1.5 w-full rounded-full bg-surface-2 overflow-hidden border border-border">
                          <div
                            className={cn("h-full rounded-full transition-all", pct >= 100 ? "bg-red-500" : pct >= 80 ? "bg-amber-500" : "bg-primary")}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      ) : null}
                    </div>
                  );
                })}
            </div>
          )}
        </Card>
      </div>

      {/* Live Request Queue & Concurrency Monitor Widget */}
      <Card>
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[20px] text-blue-500">pending_actions</span>
            <p className="text-sm font-semibold text-text-main">Live Concurrency & Queue Status</p>
            <span className="inline-flex size-2 rounded-full bg-green-500 animate-pulse" title="Polling live every 5s" />
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-text-muted font-mono">
              In-flight: {totalInFlight} · Queued: {totalQueued}
            </span>
            <Link href="/dashboard/queue-monitor" className="text-xs text-primary hover:underline font-semibold">
              Open Queue Monitor →
            </Link>
          </div>
        </div>

        {activeBuckets.length === 0 ? (
          <div className="py-5 text-center bg-surface-2/40 rounded-lg border border-border/50">
            <p className="text-xs text-text-muted">No requests currently queued or waiting on limits. All connections running smoothly.</p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-border bg-surface-1 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-xs font-semibold text-text-main">
                  <span className="material-symbols-outlined text-[16px] text-primary">key</span>
                  API Keys In-Flight
                </span>
                <span className="text-xs font-bold font-mono text-blue-500">{queue?.apiKeys?.totalActiveConcurrent || 0}</span>
              </div>
              <p className="mt-1 text-[11px] text-text-muted">{queue?.apiKeys?.totalQueued || 0} waiting in queue</p>
            </div>
            <div className="rounded-lg border border-border bg-surface-1 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-xs font-semibold text-text-main">
                  <span className="material-symbols-outlined text-[16px] text-primary">dns</span>
                  Providers In-Flight
                </span>
                <span className="text-xs font-bold font-mono text-blue-500">{queue?.providers?.totalActiveConcurrent || 0}</span>
              </div>
              <p className="mt-1 text-[11px] text-text-muted">{queue?.providers?.totalQueued || 0} waiting in queue</p>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
