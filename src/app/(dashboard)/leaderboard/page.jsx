"use client";

import { useState, useEffect, useMemo } from "react";
import { Card, Button, SegmentedControl } from "@/shared/components";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { cn } from "@/shared/utils/cn";

const PERIODS = [
  { value: "today", label: "Today" },
  { value: "24h", label: "24 Hours" },
  { value: "7d", label: "Last 7 Days" },
  { value: "30d", label: "Last 30 Days" },
  { value: "all", label: "All Time" }
];

const SORT_OPTIONS = [
  { value: "requests", label: "Total Requests" },
  { value: "tokens", label: "Total Tokens" },
  { value: "cost", label: "Total Cost ($)" },
  { value: "input", label: "Input Tokens" },
  { value: "output", label: "Output Tokens" },
  { value: "cost_per_req", label: "Cost / Request" },
  { value: "name", label: "Name (A-Z)" },
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
      <span className="inline-flex items-center justify-center size-7 rounded-full bg-warning/20 text-warning dark:text-warning font-bold text-xs ring-1 ring-warning/40 shadow-sm">
        🥇
      </span>
    );
  }
  if (rank === 2) {
    return (
      <span className="inline-flex items-center justify-center size-7 rounded-full bg-surface-3/20 text-text-muted dark:text-text-muted font-bold text-xs ring-1 text-text-muted shadow-sm">
        🥈
      </span>
    );
  }
  if (rank === 3) {
    return (
      <span className="inline-flex items-center justify-center size-7 rounded-full bg-warning/20 text-warning dark:text-warning font-bold text-xs ring-1 ring-warning/40 shadow-sm">
        🥉
      </span>
    );
  }
  return (
    <span className="inline-flex items-center justify-center size-7 rounded-full bg-surface-2 text-text-muted font-mono font-semibold text-xs border border-border-subtle">
      {rank}
    </span>
  );
}

function StatSummaryCard({ icon, label, value, sub, color = "primary" }) {
  const colorMap = {
    primary: "bg-primary/10 text-primary border-primary/20",
    success: "bg-success/10 text-success dark:text-success border-success/20",
    warning: "bg-warning/10 text-warning dark:text-warning border-warning/20",
    info: "bg-info/10 text-info dark:text-info border-info/20"
  };

  return (
    <Card className="flex-1 transition hover:border-border">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wider text-text-muted font-medium">{label}</p>
          <p className="mt-1.5 text-2xl font-bold tracking-tight text-text-main tabular-nums">{value}</p>
          {sub && <p className="mt-1 text-xs text-text-muted">{sub}</p>}
        </div>
        <div className={`flex size-11 shrink-0 items-center justify-center rounded-xl border ${colorMap[color] || colorMap.primary}`}>
          <span className="material-symbols-outlined text-[22px]">{icon}</span>
        </div>
      </div>
    </Card>
  );
}

export default function LeaderboardPage() {
  const [period, setPeriod] = useState("7d");
  const [activeTab, setActiveTab] = useState("connections"); // 'connections' | 'providers'
  const [sortBy, setSortBy] = useState("requests");
  const [sortDir, setSortDir] = useState("desc");
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [search, setSearch] = useState("");
  const [lastRefreshed, setLastRefreshed] = useState("");

  const fetchLeaderboard = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ period, top: "100" });
      const res = await fetch(`/api/usage/leaderboard?${params}`, { cache: "no-store" });
      const json = await res.json();
      if (json.success && json.data) {
        setData(json.data);
        setLastRefreshed(new Date().toLocaleTimeString());
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

  const handleSortClick = (column) => {
    if (sortBy === column) {
      setSortDir((prev) => (prev === "desc" ? "asc" : "desc"));
    } else {
      setSortBy(column);
      setSortDir("desc");
    }
  };

  // Total summary calculations
  const totals = useMemo(() => {
    if (!data) return { requests: 0, tokens: 0, cost: 0, activeAccounts: 0, activeProviders: 0 };
    const reqs = (data.keysByRequests || []).reduce((sum, r) => sum + (r.total_requests || 0), 0);
    const toks = (data.keysByRequests || []).reduce((sum, r) => sum + (r.total_tokens || 0), 0);
    const cst = (data.keysByRequests || []).reduce((sum, r) => sum + (r.total_cost || 0), 0);
    const accounts = (data.keysByRequests || []).length;
    const providers = (data.providersByUsage || []).length;
    return { requests: reqs, tokens: toks, cost: cst, activeAccounts: accounts, activeProviders: providers };
  }, [data]);

  // Max request count for relative progress bars
  const maxKeyRequests = useMemo(() => {
    if (!data?.keysByRequests?.length) return 1;
    return Math.max(...data.keysByRequests.map((k) => k.total_requests || 0), 1);
  }, [data?.keysByRequests]);

  const maxProvRequests = useMemo(() => {
    if (!data?.providersByUsage?.length) return 1;
    return Math.max(...data.providersByUsage.map((p) => p.total_requests || 0), 1);
  }, [data?.providersByUsage]);

  // Sort and filter connection rows
  const sortedAndFilteredKeys = useMemo(() => {
    if (!data?.keysByRequests) return [];
    let list = [...data.keysByRequests];

    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (k) =>
          (k.key_name && k.key_name.toLowerCase().includes(q)) ||
          (k.provider && k.provider.toLowerCase().includes(q)) ||
          (k.id && k.id.toLowerCase().includes(q))
      );
    }

    list.sort((a, b) => {
      let valA, valB;
      switch (sortBy) {
        case "tokens":
          valA = a.total_tokens || 0;
          valB = b.total_tokens || 0;
          break;
        case "input":
          valA = a.input_tokens || 0;
          valB = b.input_tokens || 0;
          break;
        case "output":
          valA = a.output_tokens || 0;
          valB = b.output_tokens || 0;
          break;
        case "cost":
          valA = a.total_cost || 0;
          valB = b.total_cost || 0;
          break;
        case "cost_per_req":
          valA = a.cost_per_request || 0;
          valB = b.cost_per_request || 0;
          break;
        case "name":
          valA = (a.key_name || "").toLowerCase();
          valB = (b.key_name || "").toLowerCase();
          return sortDir === "asc" ? valA.localeCompare(valB) : valB.localeCompare(valA);
        case "requests":
        default:
          valA = a.total_requests || 0;
          valB = b.total_requests || 0;
          break;
      }
      return sortDir === "asc" ? valA - valB : valB - valA;
    });

    return list;
  }, [data?.keysByRequests, search, sortBy, sortDir]);

  // Sort and filter provider rows
  const sortedAndFilteredProviders = useMemo(() => {
    if (!data?.providersByUsage) return [];
    let list = [...data.providersByUsage];

    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((p) => p.provider && p.provider.toLowerCase().includes(q));
    }

    list.sort((a, b) => {
      let valA, valB;
      switch (sortBy) {
        case "tokens":
          valA = a.total_tokens || 0;
          valB = b.total_tokens || 0;
          break;
        case "input":
          valA = a.input_tokens || 0;
          valB = b.input_tokens || 0;
          break;
        case "output":
          valA = a.output_tokens || 0;
          valB = b.output_tokens || 0;
          break;
        case "cost":
          valA = a.total_cost || 0;
          valB = b.total_cost || 0;
          break;
        case "cost_per_req":
          valA = a.cost_per_request || 0;
          valB = b.cost_per_request || 0;
          break;
        case "name":
          valA = (a.provider || "").toLowerCase();
          valB = (b.provider || "").toLowerCase();
          return sortDir === "asc" ? valA.localeCompare(valB) : valB.localeCompare(valA);
        case "requests":
        default:
          valA = a.total_requests || 0;
          valB = b.total_requests || 0;
          break;
      }
      return sortDir === "asc" ? valA - valB : valB - valA;
    });

    return list;
  }, [data?.providersByUsage, search, sortBy, sortDir]);

  const handleExportCsv = () => {
    if (!data) return;
    let csvContent = "";
    const filename = `9router_leaderboard_${activeTab}_${period}_${new Date().toISOString().slice(0, 10)}.csv`;

    if (activeTab === "connections") {
      const headers = ["Rank", "Connection Name", "Connection ID", "Provider", "Total Requests", "Input Tokens", "Output Tokens", "Total Tokens", "Avg Latency (ms)", "Total Cost ($)"];
      const rows = (sortedAndFilteredKeys || []).map((item, idx) => [
        idx + 1,
        `"${(item.key_name || "").replace(/"/g, '""')}"`,
        `"${item.id || ""}"`,
        `"${item.provider || ""}"`,
        item.total_requests || 0,
        item.input_tokens || 0,
        item.output_tokens || 0,
        item.total_tokens || 0,
        item.avg_latency_ms || 0,
        (item.total_cost || 0).toFixed(4),
      ]);
      csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    } else {
      const headers = ["Rank", "Provider Name", "Total Requests", "Input Tokens", "Output Tokens", "Total Tokens", "Total Cost ($)", "Cost Per Request ($)"];
      const rows = (sortedAndFilteredProviders || []).map((prov, idx) => {
        const totalTokens = prov.total_tokens || (prov.input_tokens + prov.output_tokens);
        return [
          idx + 1,
          `"${(prov.provider || "").replace(/"/g, '""')}"`,
          prov.total_requests || 0,
          prov.input_tokens || 0,
          prov.output_tokens || 0,
          totalTokens || 0,
          (prov.total_cost || 0).toFixed(4),
          (prov.cost_per_request || 0).toFixed(4),
        ];
      });
      csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    }

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const renderSortHeader = (label, colKey, alignRight = true) => {
    const isCurrent = sortBy === colKey;
    return (
      <th
        onClick={() => handleSortClick(colKey)}
        className={cn(
          "py-3 px-3 cursor-pointer select-none transition-colors hover:text-text-main",
          alignRight ? "text-right" : "text-left",
          isCurrent ? "text-primary font-bold" : ""
        )}
      >
        <div className={cn("inline-flex items-center gap-1", alignRight ? "justify-end" : "justify-start")}>
          <span>{label}</span>
          <span className="text-[11px] opacity-80">
            {isCurrent ? (sortDir === "asc" ? "▲" : "▼") : "↕"}
          </span>
        </div>
      </th>
    );
  };

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {/* Top Header Card */}
      <Card padding="md">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3.5">
            <div className="flex size-11 items-center justify-center rounded-xl bg-warning/10 text-warning dark:text-warning border border-warning/20">
              <span className="material-symbols-outlined text-[24px]">leaderboard</span>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-bold text-text-main">Usage & Performance Leaderboard</h1>
                {lastRefreshed && (
                  <span className="text-[10px] text-text-muted font-mono bg-surface-2 px-2 py-0.5 rounded-md">
                    Updated {lastRefreshed}
                  </span>
                )}
              </div>
              <p className="text-xs text-text-muted mt-0.5">Real-time usage volume and token ranking across all upstream connections</p>
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
              onClick={handleExportCsv}
              disabled={loading || !data}
              className="gap-1.5"
            >
              <span className="material-symbols-outlined text-[16px]">download</span>
              Export CSV
            </Button>
          </div>
        </div>
      </Card>

      {/* KPI Stats Cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatSummaryCard
          icon="check_circle"
          label="Total Requests"
          value={fmtNum(totals.requests)}
          sub={`Across ${totals.activeAccounts} accounts`}
          color="primary"
        />
        <StatSummaryCard
          icon="token"
          label="Total Tokens"
          value={fmtNum(totals.tokens)}
          sub="Input + Output combined"
          color="info"
        />
        <StatSummaryCard
          icon="payments"
          label="Estimated Cost"
          value={fmtCost(totals.cost)}
          sub="Based on canonical rates"
          color="warning"
        />
        <StatSummaryCard
          icon="hub"
          label="Active Providers"
          value={totals.activeProviders}
          sub="Reporting upstream nodes"
          color="success"
        />
      </div>

      {/* Tab Switcher & Sorting Filters */}
      <Card padding="md">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setActiveTab("connections")}
              className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                activeTab === "connections"
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-text-muted hover:text-text-main bg-surface-2"
              }`}
            >
              Top Connections / Keys ({sortedAndFilteredKeys.length})
            </button>
            <button
              onClick={() => setActiveTab("providers")}
              className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                activeTab === "providers"
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-text-muted hover:text-text-main bg-surface-2"
              }`}
            >
              Provider Summary ({sortedAndFilteredProviders.length})
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Sorting Dropdown */}
            <div className="flex items-center gap-1.5 text-xs text-text-muted">
              <span>Sort by:</span>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                className="rounded-lg border border-border bg-input px-2.5 py-1.5 text-xs font-medium text-text-main focus:outline-none focus:ring-1 focus:ring-primary"
              >
                {SORT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setSortDir((prev) => (prev === "desc" ? "asc" : "desc"))}
                title="Toggle Sort Order"
                className="rounded-lg border border-border bg-input px-2 py-1 text-xs font-mono text-text-main hover:bg-surface-2"
              >
                {sortDir === "desc" ? "▼ High→Low" : "▲ Low→High"}
              </button>
            </div>

            {/* Search Filter */}
            <div className="relative min-w-[180px]">
              <input
                type="text"
                placeholder="Search..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-lg border border-border bg-input px-3 py-1.5 text-xs text-text-main placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary"
              />
              {search && (
                <button
                  onClick={() => setSearch("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-text-muted hover:text-text-main"
                >
                  ✕
                </button>
              )}
            </div>
          </div>
        </div>
      </Card>

      {/* Main Data Table */}
      <Card padding="none" className="overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center p-12 text-sm text-text-muted">
            <span className="inline-block animate-spin mr-2">⌛</span> Loading leaderboard data...
          </div>
        ) : activeTab === "connections" ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-border bg-surface-2 text-text-muted uppercase tracking-wider font-semibold">
                  <th className="py-3 px-3 w-12 text-center">Rank</th>
                  {renderSortHeader("Connection Name", "name", false)}
                  <th className="py-3 px-3">Provider</th>
                  {renderSortHeader("Requests", "requests", true)}
                  {renderSortHeader("Input Tokens", "input", true)}
                  {renderSortHeader("Output Tokens", "output", true)}
                  {renderSortHeader("Total Tokens", "tokens", true)}
                  {renderSortHeader("Total Cost ($)", "cost", true)}
                  {renderSortHeader("Cost / Req", "cost_per_req", true)}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {sortedAndFilteredKeys.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="py-12 text-center text-text-muted">
                      No connections found for the selected period.
                    </td>
                  </tr>
                ) : (
                  sortedAndFilteredKeys.map((item, idx) => {
                    const reqPct = Math.round(((item.total_requests || 0) / maxKeyRequests) * 100);
                    return (
                      <tr key={item.id || idx} className="hover:bg-surface-2/40 transition-colors">
                        <td className="py-3 px-3 text-center">
                          <RankBadge rank={idx + 1} />
                        </td>
                        <td className="py-3 px-3">
                          <div className="flex flex-col">
                            <span className="font-bold text-text-main text-xs">{item.key_name}</span>
                            <span className="font-mono text-[10px] text-text-muted">{item.id || item.key_masked}</span>
                          </div>
                        </td>
                        <td className="py-3 px-3">
                          <div className="flex items-center gap-1.5">
                            <ProviderIcon providerId={item.raw_provider || item.provider} provider={item.raw_provider || item.provider} className="size-4" />
                            <span className="font-semibold text-text-main text-xs">{item.provider}</span>
                          </div>
                        </td>
                        <td className="py-3 px-3 text-right">
                          <div className="flex flex-col items-end gap-1">
                            <span className="font-bold font-mono text-text-main">{fmtNum(item.total_requests)}</span>
                            <div className="w-16 h-1 bg-surface-2 rounded-full overflow-hidden border border-border-subtle">
                              <div className="h-full bg-primary rounded-full" style={{ width: `${reqPct}%` }} />
                            </div>
                          </div>
                        </td>
                        <td className="py-3 px-3 text-right font-mono text-text-muted">{fmtNum(item.input_tokens)}</td>
                        <td className="py-3 px-3 text-right font-mono text-text-muted">{fmtNum(item.output_tokens)}</td>
                        <td className="py-3 px-3 text-right font-mono font-bold text-text-main">{fmtNum(item.total_tokens)}</td>
                        <td className="py-3 px-3 text-right font-mono font-bold text-warning dark:text-warning">{fmtCost(item.total_cost)}</td>
                        <td className="py-3 px-3 text-right font-mono text-text-muted">{fmtCost(item.cost_per_request)}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-border bg-surface-2 text-text-muted uppercase tracking-wider font-semibold">
                  <th className="py-3 px-3 w-12 text-center">Rank</th>
                  {renderSortHeader("Provider Name", "name", false)}
                  {renderSortHeader("Requests", "requests", true)}
                  {renderSortHeader("Input Tokens", "input", true)}
                  {renderSortHeader("Output Tokens", "output", true)}
                  {renderSortHeader("Total Tokens", "tokens", true)}
                  {renderSortHeader("Total Cost ($)", "cost", true)}
                  {renderSortHeader("Cost / Req", "cost_per_req", true)}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {sortedAndFilteredProviders.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-12 text-center text-text-muted">
                      No provider activity recorded for this period.
                    </td>
                  </tr>
                ) : (
                  sortedAndFilteredProviders.map((prov, idx) => {
                    const reqPct = Math.round(((prov.total_requests || 0) / maxProvRequests) * 100);
                    const totalTokens = prov.total_tokens || (prov.input_tokens + prov.output_tokens);
                    return (
                      <tr key={prov.provider || idx} className="hover:bg-surface-2/40 transition-colors">
                        <td className="py-3 px-3 text-center">
                          <RankBadge rank={idx + 1} />
                        </td>
                        <td className="py-3 px-3">
                          <div className="flex items-center gap-2">
                            <ProviderIcon providerId={prov.raw_provider || prov.provider} provider={prov.raw_provider || prov.provider} className="size-5" />
                            <div className="flex flex-col">
                              <span className="font-bold text-text-main text-xs">{prov.provider}</span>
                              {prov.raw_provider && prov.raw_provider !== prov.provider && (
                                <span className="text-[10px] text-text-muted font-mono truncate max-w-[180px]">
                                  {prov.raw_provider}
                                </span>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="py-3 px-3 text-right">
                          <div className="flex flex-col items-end gap-1">
                            <span className="font-bold font-mono text-text-main">{fmtNum(prov.total_requests)}</span>
                            <div className="w-16 h-1 bg-surface-2 rounded-full overflow-hidden border border-border-subtle">
                              <div className="h-full bg-success/20 rounded-full" style={{ width: `${reqPct}%` }} />
                            </div>
                          </div>
                        </td>
                        <td className="py-3 px-3 text-right font-mono text-text-muted">{fmtNum(prov.input_tokens)}</td>
                        <td className="py-3 px-3 text-right font-mono text-text-muted">{fmtNum(prov.output_tokens)}</td>
                        <td className="py-3 px-3 text-right font-mono font-bold text-text-main">{fmtNum(totalTokens)}</td>
                        <td className="py-3 px-3 text-right font-mono font-bold text-warning dark:text-warning">{fmtCost(prov.total_cost)}</td>
                        <td className="py-3 px-3 text-right font-mono text-text-muted">{fmtCost(prov.cost_per_request)}</td>
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
