"use client";

import { useEffect, useMemo, useState } from "react";
import { CardSkeleton } from "@/shared/components";

// Top usage of 9router's OWN API keys (the keys 9router issues to clients),
// not upstream provider usage. Rolls up stats.byApiKey (which is keyed by
// apiKey|model|provider) up to one row per issued key.

function fmt(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + "M";
  if (v >= 1_000) return (v / 1_000).toFixed(1) + "k";
  return String(v);
}

export default function ApiKeyUsageTab({ period = "today" }) {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    fetch(`/api/usage/stats?period=${encodeURIComponent(period)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => alive && setStats(d))
      .catch((e) => alive && setError(e.message || "Failed to load"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [period]);

  const rows = useMemo(() => {
    const byApiKey = stats?.byApiKey || {};
    const acc = new Map();
    for (const entry of Object.values(byApiKey)) {
      const groupKey = entry.apiKeyKey || entry.apiKeyMasked || entry.keyName || "local-no-key";
      const cur = acc.get(groupKey) || {
        keyName: entry.keyName || groupKey,
        apiKeyMasked: entry.apiKeyMasked || "",
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        cost: 0,
        models: new Set(),
        lastUsed: "",
      };
      cur.requests += entry.requests || 0;
      cur.promptTokens += entry.promptTokens || 0;
      cur.completionTokens += entry.completionTokens || 0;
      cur.cachedTokens += entry.cachedTokens || 0;
      cur.cost += entry.cost || 0;
      if (entry.rawModel) cur.models.add(entry.rawModel);
      if ((entry.lastUsed || "") > cur.lastUsed) cur.lastUsed = entry.lastUsed || "";
      acc.set(groupKey, cur);
    }
    return Array.from(acc.values())
      .map((r) => ({ ...r, models: r.models.size, totalTokens: r.promptTokens + r.completionTokens }))
      .sort((a, b) => b.requests - a.requests);
  }, [stats]);

  if (loading) return <CardSkeleton />;
  if (error) return <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-700 dark:text-red-300">{error}</div>;
  if (!rows.length)
    return <div className="rounded-lg border border-white/10 bg-white/5 p-6 text-center text-sm text-gray-600 dark:text-gray-300">No API-key usage in this period.</div>;

  return (
    <div className="overflow-x-auto rounded-lg border border-white/10">
      <table className="min-w-full text-sm">
        <thead className="bg-white/5 text-left text-xs uppercase tracking-wide text-gray-600 dark:text-gray-300">
          <tr>
            <th className="px-4 py-3">API Key</th>
            <th className="px-4 py-3 text-right">Requests</th>
            <th className="px-4 py-3 text-right">Prompt</th>
            <th className="px-4 py-3 text-right">Completion</th>
            <th className="px-4 py-3 text-right">Total Tokens</th>
            <th className="px-4 py-3 text-right">Cached</th>
            <th className="px-4 py-3 text-right">Cost</th>
            <th className="px-4 py-3 text-right">Models</th>
            <th className="px-4 py-3">Last Used</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {rows.map((r, i) => (
            <tr key={i} className="hover:bg-white/5">
              <td className="px-4 py-3">
                <div className="font-medium text-gray-600 dark:text-gray-400">{r.keyName}</div>
                {r.apiKeyMasked && <div className="font-mono text-xs text-gray-600 dark:text-gray-400">{r.apiKeyMasked}</div>}
              </td>
              <td className="px-4 py-3 text-right tabular-nums">{fmt(r.requests)}</td>
              <td className="px-4 py-3 text-right tabular-nums">{fmt(r.promptTokens)}</td>
              <td className="px-4 py-3 text-right tabular-nums">{fmt(r.completionTokens)}</td>
              <td className="px-4 py-3 text-right tabular-nums font-medium">{fmt(r.totalTokens)}</td>
              <td className="px-4 py-3 text-right tabular-nums">{fmt(r.cachedTokens)}</td>
              <td className="px-4 py-3 text-right tabular-nums">${(Number(r.cost) || 0).toFixed(4)}</td>
              <td className="px-4 py-3 text-right tabular-nums">{r.models}</td>
              <td className="px-4 py-3 text-xs text-gray-600 dark:text-gray-400">{r.lastUsed || "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
