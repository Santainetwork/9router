"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Card, CardSkeleton } from "@/shared/components";

// Dashboard home / overview. Aggregates providers, API keys, and usage into a
// single at-a-glance landing page with quick links into each section.

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

function StatCard({ icon, label, value, sub, href }) {
  const body = (
    <Card className="h-full">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-text-muted">{label}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
          {sub ? <p className="mt-0.5 text-xs text-text-muted">{sub}</p> : null}
        </div>
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <span className="material-symbols-outlined text-[22px]">{icon}</span>
        </div>
      </div>
    </Card>
  );
  return href ? <Link href={href} className="block transition hover:opacity-90">{body}</Link> : body;
}

const QUICK_LINKS = [
  { href: "/dashboard/endpoint", label: "Endpoint & Key", icon: "api" },
  { href: "/dashboard/api-keys", label: "Key Access Control", icon: "tune" },
  { href: "/dashboard/providers", label: "Providers", icon: "dns" },
  { href: "/dashboard/basic-chat", label: "Basic Chat", icon: "chat" },
  { href: "/dashboard/rpm-tester", label: "Rate & Concurrency Tester", icon: "speed" },
  { href: "/dashboard/usage", label: "Usage", icon: "bar_chart" },
  { href: "/dashboard/quota", label: "Quota Tracker", icon: "data_usage" },
  { href: "/dashboard/combos", label: "Combos", icon: "layers" },
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

  // Live RPM queue monitor (admin): poll every 5s.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/queue", { cache: "no-store" });
        if (res.ok && alive) setQueue(await res.json());
      } catch { /* transient, keep last */ }
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
    const restricted = keys.filter((k) => (k.allowedModels || []).length > 0).length;
    return { total: keys.length, active, withQuota, restricted };
  }, [keys]);

  const recent = stats?.recentRequests || [];
  const pending = (stats?.pending && (Object.keys(stats.pending.byAccount || {}).length)) || 0;

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
      <div>
        <h1 className="text-2xl font-semibold">Overview</h1>
        <p className="text-sm text-text-muted mt-1">Your 9Router at a glance.</p>
        <p className="text-[11px] text-text-subtle mt-1">Modified by SantaiNetwork</p>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-400">{error}</div>
      ) : null}

      {/* Stat cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon="dns"
          label="Providers"
          value={providerSummary.active}
          sub={`${providerSummary.healthy} healthy · ${providerSummary.total} total`}
          href="/dashboard/providers"
        />
        <StatCard
          icon="key"
          label="API Keys"
          value={keySummary.active}
          sub={`${keySummary.restricted} restricted · ${keySummary.withQuota} with quota`}
          href="/dashboard/api-keys"
        />
        <StatCard
          icon="bar_chart"
          label="Requests (7d)"
          value={fmt(stats?.totalRequests || 0)}
          sub={`${pending} active now`}
          href="/dashboard/usage"
        />
        <StatCard
          icon="payments"
          label="Cost (7d)"
          value={money(stats?.totalCost || 0)}
          sub={`${fmt((stats?.totalPromptTokens || 0) + (stats?.totalCompletionTokens || 0))} tokens`}
          href="/dashboard/usage"
        />
      </div>

      {/* Quick links */}
      <Card>
        <p className="text-sm font-medium mb-3">Quick access</p>
        <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {QUICK_LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="flex items-center gap-2 rounded-lg border border-border bg-bg px-3 py-2.5 text-sm transition hover:bg-surface-2"
            >
              <span className="material-symbols-outlined text-[20px] text-primary">{l.icon}</span>
              <span className="truncate">{l.label}</span>
            </Link>
          ))}
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Recent activity */}
        <Card>
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-medium">Recent activity</p>
            <Link href="/dashboard/usage?tab=logs" className="text-xs text-primary hover:underline">View all</Link>
          </div>
          {recent.length === 0 ? (
            <p className="text-sm text-text-muted">No recent requests.</p>
          ) : (
            <div className="flex flex-col divide-y divide-border">
              {recent.slice(0, 8).map((r, i) => (
                <div key={i} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{r.model || "unknown"}</p>
                    <p className="truncate text-xs text-text-muted">{r.provider || ""}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xs tabular-nums">{fmt((r.promptTokens || 0) + (r.completionTokens || 0))} tok</p>
                    <p className="text-[11px] text-text-muted">{timeAgo(r.timestamp)}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Top keys by usage */}
        <Card>
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-medium">Top API keys</p>
            <Link href="/dashboard/usage?tab=api-keys" className="text-xs text-primary hover:underline">View all</Link>
          </div>
          {keys.length === 0 ? (
            <p className="text-sm text-text-muted">No API keys yet.</p>
          ) : (
            <div className="flex flex-col divide-y divide-border">
              {[...keys]
                .sort((a, b) => (b.tokensUsed || 0) - (a.tokensUsed || 0))
                .slice(0, 6)
                .map((k) => {
                  const quota = k.tokenQuota ?? 0;
                  const used = k.tokensUsed ?? 0;
                  const pct = quota > 0 ? Math.min(100, Math.round((used / quota) * 100)) : 0;
                  return (
                    <div key={k.id} className="py-2">
                      <div className="flex items-center justify-between gap-3">
                        <p className="truncate text-sm font-medium">{k.name || "Unnamed"}</p>
                        <p className="text-xs tabular-nums text-text-muted">
                          {fmt(used)}{quota > 0 ? ` / ${fmt(quota)}` : ""}
                        </p>
                      </div>
                      {quota > 0 ? (
                        <div className="mt-1 h-1.5 w-full rounded-full bg-black/10 dark:bg-white/10 overflow-hidden">
                          <div
                            className={`h-full rounded-full ${pct >= 100 ? "bg-red-500" : pct >= 80 ? "bg-orange-500" : "bg-green-500"}`}
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

      {/* Live RPM queue monitor (admin) */}
      <Card>
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">Request queue</p>
            <span className="inline-flex size-2 rounded-full bg-green-500 animate-pulse" title="live (5s)" />
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-text-muted">
              {queue ? `API ${queue.apiKeys?.totalQueued || 0} · Provider ${queue.providers?.totalQueued || 0}` : "…"}
            </span>
            <Link href="/dashboard/queue-monitor" className="text-xs text-primary hover:underline">Open</Link>
          </div>
        </div>
        {!queue || queue.buckets.length === 0 ? (
          <p className="text-sm text-text-muted">No requests queued. Nothing is waiting on an RPM limit right now.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {[{ label: "API Key Queue", icon: "key", summary: queue.apiKeys }, { label: "Provider Queue", icon: "dns", summary: queue.providers }].map((item) => (
              <div key={item.label} className="rounded-lg border border-border bg-bg p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-sm font-medium"><span className="material-symbols-outlined text-[18px] text-primary">{item.icon}</span>{item.label}</span>
                  <span className="text-sm font-semibold tabular-nums">{item.summary?.totalQueued || 0}</span>
                </div>
                <p className="mt-1 text-xs text-text-muted">{item.summary?.activeBuckets || 0} active buckets</p>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
