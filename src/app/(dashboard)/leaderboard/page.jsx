"use client";

import { useState, useEffect } from "react";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import SegmentedControl from "@/shared/components/SegmentedControl.js";

const PERIODS = [
  { value: "today", label: "Today" },
  { value: "7d", label: "Last 7 Days" },
  { value: "30d", label: "Last 30 Days" },
  { value: "all", label: "All Time" }
];

export default function LeaderboardPage() {
  const [period, setPeriod] = useState("7d");
  const [showProviders, setShowProviders] = useState(false);
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);

  const fetchLeaderboard = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ period, top: "20", providers: showProviders });
      const res = await fetch(`/api/leaderboard?${params}`);
      const json = await res.json();
      if (json.success) {
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
  }, [period, showProviders]);

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      {/* Header with Controls */}
      <Card padding="md">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <h1 className="text-xl font-semibold text-text-main">🏆 API Keys & Providers Leaderboard</h1>
          
          <div className="flex items-center gap-3">
            <SegmentedControl
              options={PERIODS}
              value={period}
              onChange={setPeriod}
              size="sm"
            />
            
            <Button
              variant={showProviders ? "primary" : "outline"}
              size="sm"
              onClick={() => setShowProviders(!showProviders)}
              className="whitespace-nowrap"
            >
              📊 {showProviders ? "Hide" : "Show"} Providers
            </Button>
          </div>
        </div>
      </Card>

      {/* Loading State */}
      {loading && (
        <div className="space-y-4">
          {[1, 2, 3].map(i => (
            <Card key={i} padding="none">
              <div className="p-4">
                <div className="h-4 w-48 mb-2 bg-gray-200 dark:bg-gray-700 rounded"></div>
                <div className="h-8 w-full bg-gray-200 dark:bg-gray-700 rounded"></div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* API Keys Leaderboard - Top by Requests */}
      {!loading && data?.keysByRequests && (
        <Card padding="none">
          <div className="p-4 border-b border-border-subtle">
            <h2 className="text-lg font-semibold text-text-main">🔝 Top API Keys by Usage</h2>
            <p className="text-sm text-text-muted mt-1">Most requested keys in the selected period</p>
          </div>
          
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-black/5 dark:border-white/5">
                  <th className="text-left p-4 text-sm font-semibold">#</th>
                  <th className="text-left p-4 text-sm font-semibold">API Key</th>
                  <th className="text-right p-4 text-sm font-semibold">Requests</th>
                  <th className="text-right p-4 text-sm font-semibold">Input Tokens</th>
                  <th className="text-right p-4 text-sm font-semibold">Output Tokens</th>
                  <th className="text-right p-4 text-sm font-semibold">Cost ($)</th>
                  <th className="text-right p-4 text-sm font-semibold">Avg Latency</th>
                </tr>
              </thead>
              <tbody>
                {data.keysByRequests.map((key, index) => (
                  <tr key={key.id} className="border-b border-black/5 dark:border-white/5 hover:bg-black/[0.02] dark:hover:bg-white/[0.02]">
                    <td className="p-4">
                      <span className={`inline-flex items-center justify-center w-8 h-8 rounded-full font-bold ${index === 0 ? 'bg-yellow-500/20 text-yellow-600' : index === 1 ? 'bg-gray-500/20 text-gray-600' : index === 2 ? 'bg-orange-500/20 text-orange-600' : 'bg-black/5 dark:bg-white/5 text-text-muted'}`}>
                        {index + 1}
                      </span>
                    </td>
                    <td className="p-4">
                      <div>
                        <div className="font-medium text-text-main">{key.key_name || "Unnamed Key"}</div>
                        <div className="text-xs text-text-muted font-mono">{key.key_masked}</div>
                      </div>
                    </td>
                    <td className="p-4 text-right font-mono">{key.total_requests.toLocaleString()}</td>
                    <td className="p-4 text-right font-mono text-text-muted">{key.input_tokens.toLocaleString()}</td>
                    <td className="p-4 text-right font-mono">{key.output_tokens.toLocaleString()}</td>
                    <td className="p-4 text-right font-mono text-green-600">${key.total_cost.toFixed(4)}</td>
                    <td className="p-4 text-right font-mono text-text-muted">{key.avg_latency_ms}ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* API Keys by Cost */}
      {!loading && data?.keysByCost && (
        <Card padding="none">
          <div className="p-4 border-b border-border-subtle">
            <h2 className="text-lg font-semibold text-text-main">💰 Top API Keys by Cost</h2>
            <p className="text-sm text-text-muted mt-1">Highest spending keys in the selected period</p>
          </div>
          
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-black/5 dark:border-white/5">
                  <th className="text-left p-4 text-sm font-semibold">#</th>
                  <th className="text-left p-4 text-sm font-semibold">API Key</th>
                  <th className="text-right p-4 text-sm font-semibold">Total Cost</th>
                  <th className="text-right p-4 text-sm font-semibold">Requests</th>
                  <th className="text-right p-4 text-sm font-semibold">$/Request</th>
                </tr>
              </thead>
              <tbody>
                {data.keysByCost.map((key, index) => (
                  <tr key={key.id} className="border-b border-black/5 dark:border-white/5 hover:bg-black/[0.02]">
                    <td className="p-4">
                      <span className="inline-flex items-center justify-center w-8 h-8 rounded-full font-bold bg-yellow-500/20 text-yellow-600">
                        {index + 1}
                      </span>
                    </td>
                    <td className="p-4">
                      <div className="font-medium">{key.key_name || "Unnamed Key"}</div>
                      <div className="text-xs text-text-muted font-mono">{key.key_masked}</div>
                    </td>
                    <td className="p-4 text-right font-mono text-green-600 font-bold">${key.total_cost.toFixed(4)}</td>
                    <td className="p-4 text-right font-mono">{key.total_requests.toLocaleString()}</td>
                    <td className="p-4 text-right font-mono text-text-muted">${key.cost_per_request}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Providers Leaderboard */}
      {showProviders && !loading && data?.providersByUsage && (
        <Card padding="none">
          <div className="p-4 border-b border-border-subtle">
            <h2 className="text-lg font-semibold text-text-main">🌐 Provider Usage Rankings</h2>
            <p className="text-sm text-text-muted mt-1">Provider performance and usage metrics</p>
          </div>
          
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-black/5 dark:border-white/5">
                  <th className="text-left p-4 text-sm font-semibold">#</th>
                  <th className="text-left p-4 text-sm font-semibold">Provider</th>
                  <th className="text-right p-4 text-sm font-semibold">Requests</th>
                  <th className="text-right p-4 text-sm font-semibold">Tokens Used</th>
                  <th className="text-right p-4 text-sm font-semibold">Total Cost</th>
                  <th className="text-right p-4 text-sm font-semibold">$/Million Tokens</th>
                </tr>
              </thead>
              <tbody>
                {data.providersByUsage.map((provider, index) => (
                  <tr key={provider.provider} className="border-b border-black/5 dark:border-white/5 hover:bg-black/[0.02]">
                    <td className="p-4">
                      <span className="inline-flex items-center justify-center w-8 h-8 rounded-full font-bold bg-blue-500/20 text-blue-600">
                        {index + 1}
                      </span>
                    </td>
                    <td className="p-4 font-medium">{provider.provider}</td>
                    <td className="p-4 text-right font-mono">{provider.total_requests.toLocaleString()}</td>
                    <td className="p-4 text-right font-mono text-text-muted">
                      {(provider.input_tokens + provider.output_tokens).toLocaleString()}
                    </td>
                    <td className="p-4 text-right font-mono text-green-600">
                      ${(data.providersByCost.find(p => p.provider === provider.provider)?.total_cost || 0).toFixed(4)}
                    </td>
                    <td className="p-4 text-right font-mono text-text-muted">
                      {(() => {
                        const cost = data.providersByCost.find(p => p.provider === provider.provider)?.total_cost || 0;
                        const tokens = (provider.input_tokens + provider.output_tokens) / 1000000;
                        return tokens > 0 ? '$' + (cost / tokens).toFixed(2) : '-';
                      })()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Empty State */}
      {!loading && (!data || Object.keys(data).length === 0) && (
        <Card padding="md">
          <div className="text-center py-8 text-text-muted">
            <p>No leaderboard data available yet.</p>
            <p className="text-sm mt-2">Make some API requests to see rankings appear here.</p>
          </div>
        </Card>
      )}
    </div>
  );
}
