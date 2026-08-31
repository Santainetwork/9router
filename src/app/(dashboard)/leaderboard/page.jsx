"use client";

import { useState, useEffect, useMemo } from "react";
import { Card, Button, SegmentedControl, Badge, CardSkeleton } from "@/shared/components";
import ProviderIcon from "@/shared/components/ProviderIcon";

const PERIODS = [
  { value: "today", label: "Today" },
  { value: "7d", label: "Last 7 Days" },
  { value: "30d", label: "Last 30 Days" },
  { value: "all", label: "All Time" }
];

function fmtNum(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000_000) return (v / 1_000_000_000).toFixed(2) + "B";
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + "M";
  if (v >= 1_000) return (v / 1_000).toFixed(1) + "K";
  return v.toLocaleString();
}

function fmtCost(n) {
  const v = Number(n) || 0;
  if (v === 0) return "$0.00";
  if (v < 0.0001) return "<$0.0001";
  if (v < 0.01) return "$" + v.toFixed(4);
  return "$" + v.toFixed(2);
}

function RankBadge({ rank }) {
  if (rank === 1) {
    return (
      <span className="inline-flex items-center justify-center size-7 rounded-full bg-amber-500/15 text-amber-500 font-bold text-xs ring-1 ring-amber-500/30">
        🥇
      </span>
    );
  }
  if (rank === 2) {
    return (
      <span className="inline-flex items-center justify-center size-7 rounded-full bg-slate-400/15 text-slate-400 font-bold text-xs ring-1 ring-slate-400/30">
        🥈
      </span>
    );
  }
  if (rank === 3) {
    return (
      <span className="inline-flex items-center justify-center size-7 rounded-full bg-amber-700/15 text-amber-700 font-bold text-xs ring-1 ring-amber-700/30">
        🥉
      </span>
    );
  }
  return (
    <span className="inline-flex items-center justify-center size-7 rounded-full bg-surface-2 text-text-muted font-mono font-medium text-xs">
      {rank}
    </span>
  );
}

function StatSummaryCard({ icon, label, value, sub, color = "primary" }) {
  const colorMap = {
    primary: "bg-primary/10 text-primary",
    success: "bg-emerald-500/10 text-emerald-500",
    warning: "bg-amber-500/10 text-amber-500",
    info: "bg-sky-500/10 text-sky-500"
  };

  return (
    <Card className="flex-1">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-text-muted font-medium">{label}</p>
          <p className="mt-1 text-2xl font-bold tracking-tight text-text-main tabular-nums">{value}</p>
          {sub && <p className="mt-0.5 text-xs text-text-muted">{sub}</p>}
        </div>
        <div className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${colorMap[color] || colorMap.primary}`}>
          <span className="material-symbols-outlined text-[20px]">{icon}</span>
        </div>
      </div>
    </Card>
  );
}

export default function LeaderboardPage() {
  const [period, setPeriod] = useState("7d");
  const [activeTab, setActiveTab] = useState("connections"); // 'connections' | 'providers'
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [search, setSearch] = useState("");

  const fetchLeaderboard = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ period, top: "100", providers: "true" });
      const res = await fetch(`/api/leaderboard?${params}`, { cache: "no-store" });
      const json = await res.json();
      if (json.success && json.data) {
        setData(json.data);
      } else {
        console.error("Failed to fetch leaderboard:", json.error);
      }
    } catch (error) {
      console.error("Error fetching leaderboard:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLeaderboard();
  }, [period]);

  // Compute overall summary stats
  const totals = useMemo(() => {
    if (!data) return { requests: 0, tokens: 0, cost: 0, activeAccounts: 0, activeProviders: 0 };
    
    const reqs = (data.keysByRequests || []).reduce((sum, r) => sum + (r.total_requests || 0), 0);
    const toks = (data.keysByRequests || []).reduce((sum, r) => sum + (r.total_tokens || 0), 0);
    const cst = (data.keysByRequests || []).reduce((sum, r) => sum + (r.total_cost || 0), 0);
    const accounts = (data.keysByRequests || []).length;
    const providers = (data.providersByUsage || []).length;

    return { requests: reqs, tokens: toks, cost: cst, activeAccounts: accounts, activeProviders: providers };
  }, [data]);

  // Filtered lists
  const filteredKeys = useMemo(() => {
    if (!data?.keysByRequests) return [];
    if (!search.trim()) return data.keysByRequests;
    const q = search.toLowerCase();
    return data.keysByRequests.filter(
      k => (k.key_name && k.key_name.toLowerCase().includes(q)) ||
           (k.provider && k.provider.toLowerCase().includes(q)) ||
           (k.id && k.id.toLowerCase().includes(q))
    );
  }, [data?.keysByRequests, search]);

  const filteredProviders = useMemo(() => {
    if (!data?.providersByUsage) return [];
    if (!search.trim()) return data.providersByUsage;
    const q = search.toLowerCase();
    return data.providersByUsage.filter(
      p => p.provider && p.provider.toLowerCase().includes(q)
    );
  }, [data?.providersByUsage, search]);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {/* Top Header Card */}
      <Card padding="md">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-amber-500/10 text-amber-500">
              <span className="material-symbols-outlined text-[24px]">leaderboard</span>
            </div>
            <div>
              <h1 className="text-lg font-bold text-text-main">Usage & Performance Leaderboard</h1>
              <p className="text-xs text-text-muted">Rankings of connections, accounts, and AI providers</p>
            </div>
          </div>
          
          <div className="flex flex-wrap items-center gap-3">
            <SegmentedControl
              options={PERIODS}
              value={period}
              onChange={setPeriod}
              size="sm"
            />

            <Button
              variant="outline"
              size="sm"
              onClick={fetchLeaderboard}
              disabled={loading}
              className="gap-1.5"
            >
              <span className={`material-symbols-outlined text-[16px] ${loading ? "animate-spin" : ""}`}>
                refresh
              </span>
              Refresh
            </Button>
          </div>
        </div>
      </Card>

      {/* Summary KPI Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatSummaryCard
          icon="swap_calls"
          label="Total Requests"
          value={loading ? "..." : fmtNum(totals.requests)}
          sub={`Across ${totals.activeAccounts} active connections`}
          color="primary"
        />
        <StatSummaryCard
          icon="token"
          label="Total Tokens"
          value={loading ? "..." : fmtNum(totals.tokens)}
          sub="Input & output combined"
          color="info"
        />
        <StatSummaryCard
          icon="payments"
          label="Estimated Cost"
          value={loading ? "..." : fmtCost(totals.cost)}
          sub="Tracked upstream costs"
          color="success"
        />
        <StatSummaryCard
          icon="hub"
          label="Active Providers"
          value={loading ? "..." : String(totals.activeProviders)}
          sub={`${totals.activeAccounts} account credentials`}
          color="warning"
        />
      </div>

      {/* Main View Tabs & Search Filter */}
      <Card padding="none" className="overflow-hidden">
        <div className="flex flex-col gap-3 p-4 border-b border-border-subtle sm:flex-row sm:items-center sm:justify-between bg-surface-1/50">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setActiveTab("connections")}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                activeTab === "connections"
                  ? "bg-primary text-white shadow-sm"
                  : "text-text-muted hover:bg-surface-2 hover:text-text-main"
              }`}
            >
              <span className="material-symbols-outlined text-[16px]">key</span>
              Accounts & Connections ({filteredKeys.length})
            </button>
            <button
              onClick={() => setActiveTab("providers")}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                activeTab === "providers"
                  ? "bg-primary text-white shadow-sm"
                  : "text-text-muted hover:bg-surface-2 hover:text-text-main"
              }`}
            >
              <span className="material-symbols-outlined text-[16px]">dns</span>
              AI Providers ({filteredProviders.length})
            </button>
          </div>

          <div className="relative w-full sm:w-64">
            <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted text-[16px]">
              search
            </span>
            <input
              type="text"
              placeholder={`Search ${activeTab}...`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-surface-2 border border-border-subtle rounded-lg pl-8 pr-3 py-1.5 text-xs text-text-main placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        </div>

        {/* Loading State */}
        {loading && (
          <div className="p-6 space-y-3">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="h-12 bg-surface-2/60 animate-pulse rounded-lg" />
            ))}
          </div>
        )}

        {/* Connections / Accounts Table */}
        {!loading && activeTab === "connections" && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-border-subtle bg-surface-2/30 text-text-muted font-medium">
                  <th className="py-3 px-4 w-12 text-center">Rank</th>
                  <th className="py-3 px-4">Connection / Account</th>
                  <th className="py-3 px-4">Provider</th>
                  <th className="py-3 px-4 text-right">Requests</th>
                  <th className="py-3 px-4 text-right">Input Tokens</th>
                  <th className="py-3 px-4 text-right">Output Tokens</th>
                  <th className="py-3 px-4 text-right">Total Tokens</th>
                  <th className="py-3 px-4 text-right">Avg Latency</th>
                  <th className="py-3 px-4 text-right">Total Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {filteredKeys.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="py-8 text-center text-text-muted">
                      No connection records found for this period.
                    </td>
                  </tr>
                ) : (
                  filteredKeys.map((item, idx) => {
                    const shareOfTotal = totals.requests > 0 
                      ? ((item.total_requests / totals.requests) * 100).toFixed(1)
                      : 0;

                    return (
                      <tr
                        key={item.id || idx}
                        className="hover:bg-surface-2/40 transition group"
                      >
                        <td className="py-3 px-4 text-center">
                          <RankBadge rank={idx + 1} />
                        </td>
                        <td className="py-3 px-4">
                          <div className="flex flex-col min-w-0">
                            <span className="font-semibold text-text-main truncate">
                              {item.key_name}
                            </span>
                            <span className="font-mono text-[10px] text-text-muted truncate">
                              ID: {item.id ? `${item.id.slice(0, 12)}...` : "unknown"}
                            </span>
                          </div>
                        </td>
                        <td className="py-3 px-4">
                          {item.provider ? (
                            <div className="flex items-center gap-1.5">
                              <ProviderIcon providerId={item.provider} className="size-4 rounded" />
                              <Badge size="sm" variant="default" className="font-medium capitalize">
                                {item.provider}
                              </Badge>
                            </div>
                          ) : (
                            <span className="text-text-muted">-</span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right">
                          <div className="flex flex-col items-end">
                            <span className="font-bold text-text-main tabular-nums">
                              {item.total_requests.toLocaleString()}
                            </span>
                            <span className="text-[10px] text-text-muted">
                              {shareOfTotal}% share
                            </span>
                          </div>
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-text-muted tabular-nums">
                          {fmtNum(item.input_tokens)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-text-main tabular-nums font-medium">
                          {fmtNum(item.output_tokens)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-primary font-bold tabular-nums">
                          {fmtNum(item.total_tokens)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums">
                          <span className={item.avg_latency_ms > 3000 ? "text-amber-500" : "text-text-muted"}>
                            {item.avg_latency_ms > 0 ? `${item.avg_latency_ms}ms` : "-"}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right font-mono font-bold text-emerald-500 tabular-nums">
                          {fmtCost(item.total_cost)}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* Providers Table */}
        {!loading && activeTab === "providers" && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-border-subtle bg-surface-2/30 text-text-muted font-medium">
                  <th className="py-3 px-4 w-12 text-center">Rank</th>
                  <th className="py-3 px-4">Provider</th>
                  <th className="py-3 px-4 text-right">Total Requests</th>
                  <th className="py-3 px-4 text-right">Input Tokens</th>
                  <th className="py-3 px-4 text-right">Output Tokens</th>
                  <th className="py-3 px-4 text-right">Total Volume</th>
                  <th className="py-3 px-4 text-right">Tracked Cost</th>
                  <th className="py-3 px-4 text-right">Cost / 1M Tokens</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {filteredProviders.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-8 text-center text-text-muted">
                      No provider records found for this period.
                    </td>
                  </tr>
                ) : (
                  filteredProviders.map((prov, idx) => {
                    const costItem = (data?.providersByCost || []).find(p => p.provider === prov.provider);
                    const cost = costItem?.total_cost || 0;
                    const totalTokens = prov.total_tokens || (prov.input_tokens + prov.output_tokens);
                    const costPerMillion = totalTokens > 0 ? (cost / (totalTokens / 1_000_000)) : 0;
                    const shareOfTotal = totals.requests > 0 
                      ? ((prov.total_requests / totals.requests) * 100).toFixed(1)
                      : 0;

                    return (
                      <tr
                        key={prov.provider || idx}
                        className="hover:bg-surface-2/40 transition group"
                      >
                        <td className="py-3 px-4 text-center">
                          <RankBadge rank={idx + 1} />
                        </td>
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-2">
                            <ProviderIcon providerId={prov.provider} className="size-6 rounded" />
                            <span className="font-semibold text-text-main capitalize">
                              {prov.provider}
                            </span>
                          </div>
                        </td>
                        <td className="py-3 px-4 text-right">
                          <div className="flex flex-col items-end">
                            <span className="font-bold text-text-main tabular-nums">
                              {prov.total_requests.toLocaleString()}
                            </span>
                            <span className="text-[10px] text-text-muted">
                              {shareOfTotal}% volume
                            </span>
                          </div>
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-text-muted tabular-nums">
                          {fmtNum(prov.input_tokens)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-text-main tabular-nums font-medium">
                          {fmtNum(prov.output_tokens)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-primary font-bold tabular-nums">
                          {fmtNum(totalTokens)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono font-bold text-emerald-500 tabular-nums">
                          {fmtCost(cost)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-text-muted tabular-nums">
                          {costPerMillion > 0 ? fmtCost(costPerMillion) : "-"}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
