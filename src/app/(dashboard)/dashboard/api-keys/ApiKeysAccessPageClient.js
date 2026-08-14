"use client";

import { useEffect, useState } from "react";
import { Card } from "@/shared/components";

// Dedicated page for per-API-key access control: RPM, queue timeout, total
// token quota, and model allowlist. Split out from the Endpoint page so key
// governance lives in one focused place.

function fmt(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + "M";
  if (v >= 1_000) return (v / 1_000).toFixed(1) + "k";
  return String(v);
}

function maskKey(k) {
  if (!k || k.length <= 12) return k || "";
  return `${k.slice(0, 8)}...${k.slice(-4)}`;
}

export default function ApiKeysAccessPageClient() {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [savingId, setSavingId] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/keys", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setKeys(data.keys || []);
    } catch (e) {
      setError(e.message || "Failed to load keys");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const savePatch = async (id, patch) => {
    setSavingId(id);
    try {
      const res = await fetch(`/api/keys/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        setKeys((prev) => prev.map((k) => (k.id === id ? { ...k, ...patch, ...(data.key || {}) } : k)));
      }
    } catch (e) {
      console.log("Error saving key access:", e);
    } finally {
      setSavingId("");
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-1 sm:px-0 flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">API Key Access Control</h1>
        <p className="text-sm text-text-muted mt-1">
          Per-key limits: requests-per-minute, queue timeout, total token quota, and which models each key may use.
          Manage the keys themselves (create/pause/delete) on the Endpoint &amp; Key page.
        </p>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-400">{error}</div>
      ) : null}

      {loading ? (
        <Card><p className="text-sm text-text-muted">Loading keys...</p></Card>
      ) : keys.length === 0 ? (
        <Card><p className="text-sm text-text-muted">No API keys yet. Create one on the Endpoint &amp; Key page.</p></Card>
      ) : (
        keys.map((key) => {
          const quota = key.tokenQuota ?? 0;
          const used = key.tokensUsed ?? 0;
          const pct = quota > 0 ? Math.min(100, Math.round((used / quota) * 100)) : 0;
          return (
            <Card key={key.id}>
              <div className="flex flex-col gap-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold truncate">{key.name || "Unnamed key"}</p>
                    <p className="text-xs text-text-muted font-mono">{maskKey(key.key)}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {key.isActive === false ? (
                      <span className="text-xs rounded-full bg-orange-500/10 text-orange-500 px-2 py-0.5">Paused</span>
                    ) : (
                      <span className="text-xs rounded-full bg-green-500/10 text-green-600 px-2 py-0.5">Active</span>
                    )}
                    {savingId === key.id ? <span className="text-xs text-text-muted">Saving...</span> : null}
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-text-muted">RPM (0 = unlimited)</label>
                    <input
                      type="number"
                      min="0"
                      defaultValue={key.rpm ?? 0}
                      onBlur={(e) => {
                        const rpm = Math.max(0, parseInt(e.target.value, 10) || 0);
                        if (rpm !== (key.rpm ?? 0)) savePatch(key.id, { rpm });
                      }}
                      className="rounded border border-border bg-input px-2 py-1 text-sm"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-text-muted">Queue timeout ms (0 = reject)</label>
                    <input
                      type="number"
                      min="0"
                      defaultValue={key.queueTimeoutMs ?? 0}
                      onBlur={(e) => {
                        const queueTimeoutMs = Math.max(0, parseInt(e.target.value, 10) || 0);
                        if (queueTimeoutMs !== (key.queueTimeoutMs ?? 0)) savePatch(key.id, { queueTimeoutMs });
                      }}
                      className="rounded border border-border bg-input px-2 py-1 text-sm"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-text-muted">Token quota (0 = unlimited)</label>
                    <input
                      type="number"
                      min="0"
                      defaultValue={quota}
                      onBlur={(e) => {
                        const tokenQuota = Math.max(0, parseInt(e.target.value, 10) || 0);
                        if (tokenQuota !== quota) savePatch(key.id, { tokenQuota });
                      }}
                      className="rounded border border-border bg-input px-2 py-1 text-sm"
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-1">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-text-muted">Token usage (all-time)</span>
                    <span className="text-xs text-text-muted">
                      {fmt(used)}{quota > 0 ? ` / ${fmt(quota)} (${pct}%)` : " / unlimited"}
                    </span>
                  </div>
                  {quota > 0 ? (
                    <div className="h-2 w-full rounded-full bg-black/10 dark:bg-white/10 overflow-hidden">
                      <div
                        className={`h-full rounded-full ${pct >= 100 ? "bg-red-500" : pct >= 80 ? "bg-orange-500" : "bg-green-500"}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  ) : null}
                </div>

                <div className="flex flex-col gap-1">
                  <label className="text-xs text-text-muted">Allowed models (comma-separated, blank = all)</label>
                  <input
                    type="text"
                    defaultValue={(key.allowedModels || []).join(", ")}
                    placeholder="e.g. myr/qd/auto, ama/gpt-5.5"
                    onBlur={(e) => {
                      const allowedModels = e.target.value.split(",").map((m) => m.trim()).filter(Boolean);
                      const current = (key.allowedModels || []).join(",");
                      if (allowedModels.join(",") !== current) savePatch(key.id, { allowedModels });
                    }}
                    className="rounded border border-border bg-input px-2 py-1 text-sm"
                  />
                  <p className="text-[11px] text-text-muted">
                    Match by full id (<code>prefix/model</code>) or the part after the last <code>/</code>.
                  </p>
                </div>
              </div>
            </Card>
          );
        })
      )}
    </div>
  );
}
