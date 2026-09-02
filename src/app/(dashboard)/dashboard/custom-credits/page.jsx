"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Card, Button, Badge } from "@/shared/components";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { formatCompactNumber, formatResetTime } from "../usage/components/ProviderLimits/utils";

export default function CustomCreditsPage() {
  const [connections, setConnections] = useState([]);
  const [quotaData, setQuotaData] = useState({});
  const [loadingQuotas, setLoadingQuotas] = useState({});
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterStrategy, setFilterStrategy] = useState("all");

  // Load custom provider connections
  const fetchConnections = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/providers/client?scope=custom&sort=priority", { cache: "no-store" });
      const json = await res.json();
      setConnections(json.connections || []);
    } catch (e) {
      console.error("Failed to load custom connections:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConnections();
  }, [fetchConnections]);

  // Fetch individual quota for a custom connection
  const fetchQuota = useCallback(async (connectionId, { force = false } = {}) => {
    setLoadingQuotas(prev => ({ ...prev, [connectionId]: true }));
    try {
      const url = `/api/usage/${connectionId}${force ? "?force=true" : ""}`;
      const res = await fetch(url, { cache: "no-store" });
      const data = await res.json();
      setQuotaData(prev => ({ ...prev, [connectionId]: data }));
    } catch (e) {
      console.error(`Failed to fetch credits for connection ${connectionId}:`, e);
      setQuotaData(prev => ({ ...prev, [connectionId]: { message: e.message } }));
    } finally {
      setLoadingQuotas(prev => ({ ...prev, [connectionId]: false }));
    }
  }, []);

  // Refresh all visible custom connections
  const handleRefreshAll = useCallback(async () => {
    setRefreshingAll(true);
    await Promise.all(
      connections.map(conn => fetchQuota(conn.id, { force: true }))
    );
    setRefreshingAll(false);
  }, [connections, fetchQuota]);

  // Auto-fetch quota on initial load of connections
  useEffect(() => {
    if (connections.length > 0) {
      connections.forEach(conn => fetchQuota(conn.id));
    }
  }, [connections, fetchQuota]);

  // Summary Metrics
  const summary = useMemo(() => {
    let totalConnections = connections.length;
    let activeConnections = 0;
    let totalCreditsTracked = 0;
    let hasCreditsCount = 0;

    connections.forEach(conn => {
      if (conn.isActive) activeConnections += 1;
      const q = quotaData[conn.id];
      if (q?.quotas) {
        Object.values(q.quotas).forEach(item => {
          if (item?.total > 0) {
            totalCreditsTracked += item.total;
            hasCreditsCount += 1;
          }
        });
      }
    });

    return {
      totalConnections,
      activeConnections,
      totalCreditsTracked,
      hasCreditsCount
    };
  }, [connections, quotaData]);

  // Filtered List
  const filtered = useMemo(() => {
    return connections.filter(conn => {
      const q = (search || "").toLowerCase();
      const matchesSearch = !q || 
        (conn.name && conn.name.toLowerCase().includes(q)) ||
        (conn.provider && conn.provider.toLowerCase().includes(q));

      const strategy = conn.providerSpecificData?.creditCheckType || "auto";
      const matchesStrategy = filterStrategy === "all" || strategy === filterStrategy;

      return matchesSearch && matchesStrategy;
    });
  }, [connections, search, filterStrategy]);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {/* Header */}
      <Card padding="md">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3.5">
            <div className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary border border-primary/20">
              <span className="material-symbols-outlined text-[24px]">account_balance_wallet</span>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-bold text-text-main">Custom Provider Credits & Balance</h1>
                <Badge size="sm" variant="default" className="font-mono">
                  {connections.length} Accounts
                </Badge>
              </div>
              <p className="text-xs text-text-muted mt-0.5">
                Dedicated real-time balance and credit quota tracking for custom OpenAI-compatible endpoints
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={handleRefreshAll}
              disabled={refreshingAll || loading}
              className="gap-1.5"
            >
              <span className={`material-symbols-outlined text-[16px] ${refreshingAll ? "animate-spin" : ""}`}>
                refresh
              </span>
              Refresh All
            </Button>
          </div>
        </div>
      </Card>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card className="flex-1">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-wider text-text-muted font-medium">Custom Connections</p>
              <p className="mt-1.5 text-2xl font-bold text-text-main tabular-nums">{summary.totalConnections}</p>
              <p className="mt-1 text-xs text-text-muted">{summary.activeConnections} active accounts</p>
            </div>
            <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary border border-primary/20">
              <span className="material-symbols-outlined text-[22px]">dns</span>
            </div>
          </div>
        </Card>

        <Card className="flex-1">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-wider text-text-muted font-medium">Tracked Balance / Credits</p>
              <p className="mt-1.5 text-2xl font-bold text-emerald-500 tabular-nums font-mono">
                {formatCompactNumber(summary.totalCreditsTracked)}
              </p>
              <p className="mt-1 text-xs text-text-muted">Combined across {summary.hasCreditsCount} active quotas</p>
            </div>
            <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">
              <span className="material-symbols-outlined text-[22px]">paid</span>
            </div>
          </div>
        </Card>

        <Card className="flex-1">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-wider text-text-muted font-medium">Supported Adapters</p>
              <p className="mt-1.5 text-2xl font-bold text-text-main tabular-nums">7 Types</p>
              <p className="mt-1 text-xs text-text-muted">Amanai, OpenRouter, SiliconFlow, NewAPI, User Balance, Custom</p>
            </div>
            <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-500 border border-amber-500/20">
              <span className="material-symbols-outlined text-[22px]">integration_instructions</span>
            </div>
          </div>
        </Card>
      </div>

      {/* Main Table Card */}
      <Card padding="none" className="overflow-hidden">
        {/* Search and Filters */}
        <div className="flex flex-col gap-3 p-4 border-b border-border-subtle sm:flex-row sm:items-center sm:justify-between bg-surface-1/50">
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-muted font-medium">Strategy:</span>
            <select
              value={filterStrategy}
              onChange={(e) => setFilterStrategy(e.target.value)}
              className="bg-surface-2 border border-border-subtle rounded-lg px-2.5 py-1.5 text-xs text-text-main focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="all">All Strategies</option>
              <option value="auto">Auto-detect</option>
              <option value="amanai">Amanai</option>
              <option value="openrouter">OpenRouter</option>
              <option value="siliconflow">SiliconFlow</option>
              <option value="newapi">NewAPI / OneAPI</option>
              <option value="deepseek">User Balance</option>
              <option value="custom">Custom URL</option>
              <option value="none">Disabled</option>
            </select>
          </div>

          <div className="relative w-full sm:w-72">
            <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted text-[16px]">
              search
            </span>
            <input
              type="text"
              placeholder="Search custom accounts..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-surface-2 border border-border-subtle rounded-lg pl-8 pr-3 py-1.5 text-xs text-text-main placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        </div>

        {/* Table View */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-border-subtle bg-surface-2/30 text-text-muted font-medium">
                <th className="py-3 px-4 min-w-[200px]">Connection Name</th>
                <th className="py-3 px-4">Strategy</th>
                <th className="py-3 px-4">Plan / Status</th>
                <th className="py-3 px-4 min-w-[240px]">Credits / Balance Remaining</th>
                <th className="py-3 px-4">Reset / Expiry</th>
                <th className="py-3 px-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {loading ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-text-muted">
                    <div className="flex items-center justify-center gap-2">
                      <span className="material-symbols-outlined animate-spin text-[20px]">progress_activity</span>
                      Loading custom connections...
                    </div>
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-text-muted">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <span className="material-symbols-outlined text-[32px] opacity-40">account_balance_wallet</span>
                      <p className="font-medium">No custom provider connections found.</p>
                      <p className="text-[11px] text-text-muted">Add OpenAI-compatible connections in Providers page to monitor credits.</p>
                    </div>
                  </td>
                </tr>
              ) : (
                filtered.map((conn) => {
                  const data = quotaData[conn.id];
                  const isLoading = loadingQuotas[conn.id];
                  const strategy = conn.providerSpecificData?.creditCheckType || "auto";
                  const quotas = data?.quotas || {};
                  const quotaList = Object.entries(quotas);

                  return (
                    <tr key={conn.id} className="hover:bg-surface-2/40 transition group">
                      {/* Name & ID */}
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2.5">
                          <ProviderIcon providerId={conn.provider} className="size-6 rounded shrink-0" />
                          <div className="flex flex-col min-w-0">
                            <span className="font-semibold text-text-main truncate text-sm">
                              {conn.name}
                            </span>
                            <span className="font-mono text-[10px] text-text-muted truncate">
                              {conn.id.slice(0, 16)}...
                            </span>
                          </div>
                        </div>
                      </td>

                      {/* Strategy */}
                      <td className="py-3 px-4">
                        <Badge size="sm" variant="default" className="font-mono capitalize">
                          {strategy}
                        </Badge>
                      </td>

                      {/* Plan / Status */}
                      <td className="py-3 px-4">
                        {isLoading ? (
                          <span className="text-text-muted italic">Checking...</span>
                        ) : data?.message ? (
                          <span className="text-amber-500 font-medium truncate max-w-[200px] block" title={data.message}>
                            {data.message}
                          </span>
                        ) : data?.plan ? (
                          <span className="font-medium text-text-main">
                            {data.plan}
                          </span>
                        ) : (
                          <span className="text-text-muted">—</span>
                        )}
                      </td>

                      {/* Quotas / Balance Rows */}
                      <td className="py-3 px-4">
                        {isLoading ? (
                          <div className="h-4 w-32 bg-surface-2 animate-pulse rounded" />
                        ) : quotaList.length === 0 ? (
                          <span className="text-text-muted italic">No balance data</span>
                        ) : (
                          <div className="flex flex-col gap-2">
                            {quotaList.map(([name, item]) => {
                              const isUnlimited = item.unlimited === true;
                              const pct = item.remainingPercentage ?? 100;
                              return (
                                <div key={name} className="flex flex-col gap-1 min-w-[200px]">
                                  <div className="flex items-center justify-between text-[11px]">
                                    <span className="text-text-muted font-medium truncate">{name}</span>
                                    <span className="font-bold text-emerald-500 font-mono">
                                      {formatCompactNumber(item.total)}
                                    </span>
                                  </div>
                                  <div className="h-1.5 w-full bg-surface-2 rounded-full overflow-hidden">
                                    <div
                                      className={`h-full rounded-full transition-all duration-300 ${
                                        pct > 20 ? "bg-emerald-500" : pct > 5 ? "bg-amber-500" : "bg-red-500"
                                      }`}
                                      style={{ width: `${Math.min(100, Math.max(isUnlimited ? 100 : 4, pct))}%` }}
                                    />
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </td>

                      {/* Reset / Expiry */}
                      <td className="py-3 px-4 text-text-muted font-mono text-[11px]">
                        {(() => {
                          const firstQuota = quotaList[0]?.[1];
                          if (firstQuota?.resetAt) {
                            return formatResetTime(firstQuota.resetAt);
                          }
                          return "—";
                        })()}
                      </td>

                      {/* Action */}
                      <td className="py-3 px-4 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => fetchQuota(conn.id, { force: true })}
                          disabled={isLoading}
                          className="h-7 w-7 p-0"
                          title="Refresh credit balance"
                        >
                          <span className={`material-symbols-outlined text-[16px] ${isLoading ? "animate-spin" : ""}`}>
                            refresh
                          </span>
                        </Button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
