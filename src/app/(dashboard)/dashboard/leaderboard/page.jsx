"use client";

import { useState, useEffect, useMemo } from "react";
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
import { SegmentedControl } from "@/shared/components";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { cn } from "@/lib/utils";

const PERIODS = [
  { value: "today", label: "Today" },
  { value: "24h", label: "24 Hours" },
  { value: "7d", label: "Last 7 Days" },
  { value: "30d", label: "Last 30 Days" },
  { value: "all", label: "All Time" },
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
      <span className="inline-flex items-center justify-center size-7 rounded-full bg-amber-500/20 text-amber-500 font-bold text-xs ring-1 ring-amber-500/40 shadow-sm">
        🥇
      </span>
    );
  }
  if (rank === 2) {
    return (
      <span className="inline-flex items-center justify-center size-7 rounded-full bg-slate-400/20 text-slate-400 font-bold text-xs ring-1 ring-slate-400/40 shadow-sm">
        🥈
      </span>
    );
  }
  if (rank === 3) {
    return (
      <span className="inline-flex items-center justify-center size-7 rounded-full bg-amber-700/20 text-amber-700 font-bold text-xs ring-1 ring-amber-700/40 shadow-sm">
        🥉
      </span>
    );
  }
  return (
    <span className="inline-flex items-center justify-center size-7 rounded-full bg-surface-2 text-text-muted font-mono font-semibold text-xs border border-border">
      {rank}
    </span>
  );
}

function StatSummaryCard({ icon, label, value, sub, color = "primary" }) {
  const colorMap = {
    primary: "bg-primary/10 text-primary border-primary/20",
    success: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
    warning: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
    info: "bg-blue-500/10 text-blue-500 border-blue-500/20",
  };

  return (
    <div className="rounded-2xl border border-border bg-surface p-4 shadow-xs">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-wider text-text-muted font-semibold">{label}</p>
          <p className="mt-1.5 text-2xl font-bold tracking-tight text-text-main tabular-nums">{value}</p>
          {sub && <p className="mt-0.5 text-xs text-text-muted truncate">{sub}</p>}
        </div>
        <div className={`flex size-10 shrink-0 items-center justify-center rounded-xl border ${colorMap[color] || colorMap.primary}`}>
          <span className="material-symbols-outlined text-[20px]">{icon}</span>
        </div>
      </div>
    </div>
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

  const totals = useMemo(() => {
    if (!data) return { requests: 0, tokens: 0, cost: 0, activeAccounts: 0, activeProviders: 0 };
    const reqs = (data.keysByRequests || []).reduce((sum, r) => sum + (r.total_requests || 0), 0);
    const toks = (data.keysByRequests || []).reduce((sum, r) => sum + (r.total_tokens || 0), 0);
    const cst = (data.keysByRequests || []).reduce((sum, r) => sum + (r.total_cost || 0), 0);
    const accounts = (data.keysByRequests || []).length;
    const providers = (data.providersByUsage || []).length;
    return { requests: reqs, tokens: toks, cost: cst, activeAccounts: accounts, activeProviders: providers };
  }, [data]);

  const maxKeyRequests = useMemo(() => {
    if (!data?.keysByRequests || data.keysByRequests.length === 0) return 1;
    return Math.max(...data.keysByRequests.map((r) => r.total_requests || 0), 1);
  }, [data?.keysByRequests]);

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
      <TableHead
        onClick={() => handleSortClick(colKey)}
        className={cn(
          "cursor-pointer select-none transition-colors hover:text-text-main",
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
      </TableHead>
    );
  };

  return (
    <div className="flex min-w-0 flex-col gap-6 max-w-7xl mx-auto py-2">
      {/* Top Header Card */}
      <div className="rounded-2xl border border-border bg-surface p-5 shadow-xs">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3.5">
            <div className="flex size-11 items-center justify-center rounded-xl bg-amber-500/10 text-amber-500 border border-amber-500/20">
              <span className="material-symbols-outlined text-[24px]">leaderboard</span>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-bold tracking-tight text-text-main">Usage Leaderboard</h1>
                {lastRefreshed && (
                  <span className="text-[10px] text-text-muted font-mono bg-surface-2 px-2 py-0.5 rounded-md">
                    Synced {lastRefreshed}
                  </span>
                )}
              </div>
              <p className="text-xs text-text-muted mt-0.5">Real-time usage volume and token ranking across all upstream connections</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
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
      </div>

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
          sub="Input + Output"
          color="info"
        />
        <StatSummaryCard
          icon="payments"
          label="Estimated Cost"
          value={fmtCost(totals.cost)}
          sub="Calculated canonical rates"
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

      {/* Main Table Card */}
      <div className="rounded-2xl border border-border bg-surface shadow-xs overflow-hidden flex flex-col">
        <div className="p-4 border-b border-border flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-surface-2/20">
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setActiveTab("connections")}
              className={cn(
                "px-3.5 py-1.5 text-xs font-semibold rounded-xl transition-all",
                activeTab === "connections"
                  ? "bg-primary text-white shadow-xs"
                  : "text-text-muted hover:text-text-main bg-surface border border-border"
              )}
            >
              Top Connections & Keys ({sortedAndFilteredKeys.length})
            </button>
            <button
              onClick={() => setActiveTab("providers")}
              className={cn(
                "px-3.5 py-1.5 text-xs font-semibold rounded-xl transition-all",
                activeTab === "providers"
                  ? "bg-primary text-white shadow-xs"
                  : "text-text-muted hover:text-text-main bg-surface border border-border"
              )}
            >
              Provider Summary ({sortedAndFilteredProviders.length})
            </button>
          </div>

          <div className="flex items-center gap-2">
            <div className="relative w-full sm:w-60">
              <span className="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted text-[16px]">
                search
              </span>
              <input
                type="text"
                placeholder="Search name, provider..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-xl border border-border bg-input pl-8 pr-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>
        </div>

        {/* Data Table */}
        {loading ? (
          <div className="flex items-center justify-center p-12 text-sm text-text-muted">
            Loading leaderboard data...
          </div>
        ) : activeTab === "connections" ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12 text-center">Rank</TableHead>
                {renderSortHeader("Connection Name", "name", false)}
                <TableHead>Provider</TableHead>
                {renderSortHeader("Requests", "requests", true)}
                {renderSortHeader("Input Tokens", "input", true)}
                {renderSortHeader("Output Tokens", "output", true)}
                {renderSortHeader("Total Tokens", "tokens", true)}
                {renderSortHeader("Total Cost ($)", "cost", true)}
                {renderSortHeader("Cost / Req", "cost_per_req", true)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedAndFilteredKeys.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="py-12 text-center text-text-muted">
                    No connections found for the selected period.
                  </TableCell>
                </TableRow>
              ) : (
                sortedAndFilteredKeys.map((item, idx) => {
                  const reqPct = Math.round(((item.total_requests || 0) / maxKeyRequests) * 100);
                  return (
                    <TableRow key={item.id || idx}>
                      <TableCell className="text-center">
                        <RankBadge rank={idx + 1} />
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-bold text-text-main text-xs">{item.key_name}</span>
                          <span className="font-mono text-[10px] text-text-muted">{item.id || item.key_masked}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <ProviderIcon provider={item.raw_provider || item.provider} className="size-4" />
                          <span className="font-semibold text-text-main text-xs">{item.provider}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex flex-col items-end gap-1">
                          <span className="font-mono font-bold text-text-main text-xs">{fmtNum(item.total_requests)}</span>
                          <div className="h-1.5 w-16 rounded-full bg-border overflow-hidden">
                            <div className="h-full bg-primary rounded-full" style={{ width: `${Math.max(reqPct, 4)}%` }} />
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-text-muted">{fmtNum(item.input_tokens)}</TableCell>
                      <TableCell className="text-right font-mono text-xs text-text-muted">{fmtNum(item.output_tokens)}</TableCell>
                      <TableCell className="text-right font-mono font-semibold text-xs text-text-main">{fmtNum(item.total_tokens)}</TableCell>
                      <TableCell className="text-right font-mono font-bold text-xs text-emerald-600 dark:text-emerald-400">{fmtCost(item.total_cost)}</TableCell>
                      <TableCell className="text-right font-mono text-xs text-text-muted">{fmtCost(item.cost_per_request)}</TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12 text-center">Rank</TableHead>
                {renderSortHeader("Provider", "name", false)}
                {renderSortHeader("Requests", "requests", true)}
                {renderSortHeader("Input Tokens", "input", true)}
                {renderSortHeader("Output Tokens", "output", true)}
                {renderSortHeader("Total Tokens", "tokens", true)}
                {renderSortHeader("Total Cost ($)", "cost", true)}
                {renderSortHeader("Cost / Req", "cost_per_req", true)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedAndFilteredProviders.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-12 text-center text-text-muted">
                    No providers found for the selected period.
                  </TableCell>
                </TableRow>
              ) : (
                sortedAndFilteredProviders.map((prov, idx) => (
                  <TableRow key={prov.provider || idx}>
                    <TableCell className="text-center">
                      <RankBadge rank={idx + 1} />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <ProviderIcon provider={prov.provider} className="size-5" />
                        <span className="font-bold text-text-main text-xs">{prov.provider}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono font-bold text-xs text-text-main">{fmtNum(prov.total_requests)}</TableCell>
                    <TableCell className="text-right font-mono text-xs text-text-muted">{fmtNum(prov.input_tokens)}</TableCell>
                    <TableCell className="text-right font-mono text-xs text-text-muted">{fmtNum(prov.output_tokens)}</TableCell>
                    <TableCell className="text-right font-mono font-semibold text-xs text-text-main">{fmtNum(prov.total_tokens)}</TableCell>
                    <TableCell className="text-right font-mono font-bold text-xs text-emerald-600 dark:text-emerald-400">{fmtCost(prov.total_cost)}</TableCell>
                    <TableCell className="text-right font-mono text-xs text-text-muted">{fmtCost(prov.cost_per_request)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
