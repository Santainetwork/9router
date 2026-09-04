"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Card } from "@/shared/components";

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

// Modal / Dialog for editing individual key settings to eliminate page sprawl
function KeyConfigModal({ keyData, allModels, isOpen, onClose, onSave, isSaving }) {
  if (!isOpen || !keyData) return null;

  const [name, setName] = useState(keyData.name || "");
  const [rpm, setRpm] = useState(keyData.rpm ?? 0);
  const [concurrency, setConcurrency] = useState(keyData.concurrency ?? 0);
  const [queueTimeoutMs, setQueueTimeoutMs] = useState(keyData.queueTimeoutMs ?? 0);
  const [tokenQuota, setTokenQuota] = useState(keyData.tokenQuota ?? 0);
  const [allowedModels, setAllowedModels] = useState(keyData.allowedModels || []);
  const [query, setQuery] = useState("");
  const [activeTab, setActiveTab] = useState("limits"); // "limits" | "models"

  // Quick wildcard prefixes detected from available models
  const providerPrefixes = useMemo(() => {
    const set = new Set();
    set.add("hx/*");
    set.add("myr/*");
    set.add("ag/*");
    set.add("cx/*");
    set.add("gemini/*");
    allModels.forEach((m) => {
      const idx = m.indexOf("/");
      if (idx > 0) set.add(`${m.slice(0, idx)}/*`);
    });
    return Array.from(set).slice(0, 8);
  }, [allModels]);

  const filteredModels = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allModels.slice(0, 100);
    return allModels.filter((m) => m.toLowerCase().includes(q)).slice(0, 100);
  }, [allModels, query]);

  const toggleModel = (id) => {
    setAllowedModels((prev) =>
      prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]
    );
  };

  const addCustomModel = () => {
    const val = query.trim();
    if (val && !allowedModels.includes(val)) {
      setAllowedModels((prev) => [...prev, val]);
      setQuery("");
    }
  };

  const handleSave = () => {
    onSave(keyData.id, {
      rpm: Math.max(0, parseInt(rpm, 10) || 0),
      concurrency: Math.max(0, parseInt(concurrency, 10) || 0),
      queueTimeoutMs: Math.max(0, parseInt(queueTimeoutMs, 10) || 0),
      tokenQuota: Math.max(0, parseInt(tokenQuota, 10) || 0),
      allowedModels,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm animate-in fade-in">
      <div className="w-full max-w-2xl overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl flex flex-col max-h-[90vh]">
        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-border px-6 py-4 bg-surface-2/40">
          <div>
            <h2 className="text-lg font-semibold text-text-main flex items-center gap-2">
              <span className="material-symbols-outlined text-primary text-[20px]">tune</span>
              Configure Access: {keyData.name || "API Key"}
            </h2>
            <p className="text-xs font-mono text-text-muted mt-0.5">{maskKey(keyData.key)}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-text-muted hover:bg-surface-2 hover:text-text-main transition-colors"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-border bg-surface-2/20 px-6">
          <button
            type="button"
            onClick={() => setActiveTab("limits")}
            className={`flex items-center gap-2 border-b-2 py-3 px-4 text-sm font-medium transition-colors ${
              activeTab === "limits"
                ? "border-primary text-primary"
                : "border-transparent text-text-muted hover:text-text-main"
            }`}
          >
            <span className="material-symbols-outlined text-[18px]">speed</span>
            Rate & Concurrency Limits
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("models")}
            className={`flex items-center gap-2 border-b-2 py-3 px-4 text-sm font-medium transition-colors ${
              activeTab === "models"
                ? "border-primary text-primary"
                : "border-transparent text-text-muted hover:text-text-main"
            }`}
          >
            <span className="material-symbols-outlined text-[18px]">rule</span>
            Model Allowlist ({allowedModels.length === 0 ? "All" : allowedModels.length})
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 overflow-y-auto custom-scrollbar flex-1 space-y-6">
          {activeTab === "limits" ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-text-muted flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-[16px]">timer</span>
                    RPM (Requests / min)
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={rpm}
                    onChange={(e) => setRpm(e.target.value)}
                    className="w-full rounded-lg border border-border bg-input px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                    placeholder="0 = Unlimited"
                  />
                  <p className="text-[11px] text-text-muted">0 disables RPM throttling</p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-text-muted flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-[16px]">call_split</span>
                    Max Concurrency
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={concurrency}
                    onChange={(e) => setConcurrency(e.target.value)}
                    className="w-full rounded-lg border border-border bg-input px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary font-medium text-primary"
                    placeholder="0 = Unlimited"
                  />
                  <p className="text-[11px] text-text-muted">Active in-flight slots (surplus automatically queues)</p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-text-muted flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-[16px]">hourglass_empty</span>
                    Queue Timeout (Seconds)
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={queueTimeoutMs >= 1000 ? Math.round(queueTimeoutMs / 1000) : queueTimeoutMs}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10) || 0;
                      setQueueTimeoutMs(v);
                    }}
                    className="w-full rounded-lg border border-border bg-input px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                    placeholder="60 (default: 60s)"
                  />
                  <p className="text-[11px] text-text-muted">Max seconds waiting in queue before 429</p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-text-muted flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-[16px]">toll</span>
                    Token Quota (Total)
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={tokenQuota}
                    onChange={(e) => setTokenQuota(e.target.value)}
                    className="w-full rounded-lg border border-border bg-input px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                    placeholder="0 = Unlimited"
                  />
                  <p className="text-[11px] text-text-muted">Prompt + completion token limit</p>
                </div>
              </div>

              {/* Usage bar */}
              <div className="rounded-xl border border-border bg-surface-2/30 p-4 space-y-2">
                <div className="flex justify-between items-center text-xs">
                  <span className="text-text-muted">Current Usage</span>
                  <span className="font-mono font-medium text-text-main">
                    {fmt(keyData.tokensUsed ?? 0)}
                    {keyData.tokenQuota > 0 ? ` / ${fmt(keyData.tokenQuota)} tokens` : " (Unlimited)"}
                  </span>
                </div>
                {keyData.tokenQuota > 0 ? (
                  <div className="h-2 w-full rounded-full bg-border overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
                        (keyData.tokensUsed / keyData.tokenQuota) >= 1
                          ? "bg-red-500"
                          : (keyData.tokensUsed / keyData.tokenQuota) >= 0.8
                          ? "bg-amber-500"
                          : "bg-emerald-500"
                      }`}
                      style={{
                        width: `${Math.min(100, Math.round(((keyData.tokensUsed ?? 0) / keyData.tokenQuota) * 100))}%`,
                      }}
                    />
                  </div>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Quick Wildcards */}
              <div className="space-y-2">
                <label className="text-xs font-medium text-text-muted">Quick Wildcards (Prefixes)</label>
                <div className="flex flex-wrap gap-1.5">
                  {providerPrefixes.map((pfx) => {
                    const isAdded = allowedModels.includes(pfx);
                    return (
                      <button
                        key={pfx}
                        type="button"
                        onClick={() => toggleModel(pfx)}
                        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-mono transition-all border ${
                          isAdded
                            ? "bg-primary text-white border-primary shadow-sm"
                            : "bg-surface border-border text-text-muted hover:border-primary/50 hover:text-text-main"
                        }`}
                      >
                        {pfx}
                        <span className="material-symbols-outlined text-[14px]">
                          {isAdded ? "check" : "add"}
                        </span>
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    onClick={() => toggleModel("*")}
                    className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-mono transition-all border ${
                      allowedModels.includes("*")
                        ? "bg-primary text-white border-primary shadow-sm"
                        : "bg-surface border-border text-text-muted hover:border-primary/50 hover:text-text-main"
                    }`}
                  >
                    * (All)
                  </button>
                </div>
              </div>

              {/* Selected Chips */}
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <label className="text-xs font-medium text-text-muted">
                    Active Allowlist ({allowedModels.length})
                  </label>
                  {allowedModels.length > 0 ? (
                    <button
                      type="button"
                      onClick={() => setAllowedModels([])}
                      className="text-xs text-red-400 hover:text-red-300 underline"
                    >
                      Clear all (Permit all models)
                    </button>
                  ) : null}
                </div>

                {allowedModels.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border p-3 text-center text-xs text-text-muted bg-surface-2/10">
                    No restrictions — this key may access all models and combos.
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-1.5 max-h-36 overflow-y-auto p-2 rounded-lg border border-border bg-surface-2/20 custom-scrollbar">
                    {allowedModels.map((id) => (
                      <span
                        key={id}
                        className="inline-flex items-center gap-1 rounded-md bg-primary/10 border border-primary/20 text-primary px-2 py-0.5 text-xs font-mono"
                      >
                        {id}
                        <button
                          type="button"
                          onClick={() => toggleModel(id)}
                          className="hover:text-red-500 transition-colors ml-0.5"
                        >
                          <span className="material-symbols-outlined text-[14px]">close</span>
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Search & Add */}
              <div className="space-y-2">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addCustomModel();
                      }
                    }}
                    placeholder="Search catalog or type custom pattern (e.g. hx/*) + Enter..."
                    className="flex-1 rounded-lg border border-border bg-input px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  {query.trim() ? (
                    <button
                      type="button"
                      onClick={addCustomModel}
                      className="px-3 py-2 bg-primary text-white rounded-lg text-xs font-medium hover:bg-primary/90 transition-colors shrink-0"
                    >
                      Add "{query.trim()}"
                    </button>
                  ) : null}
                </div>

                <div className="max-h-48 overflow-y-auto rounded-lg border border-border bg-surface divide-y divide-border custom-scrollbar">
                  {filteredModels.map((id) => {
                    const isSelected = allowedModels.includes(id);
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => toggleModel(id)}
                        className={`w-full flex items-center justify-between px-3 py-2 text-left text-xs transition-colors hover:bg-surface-2 ${
                          isSelected ? "bg-primary/5 text-primary font-medium" : "text-text-main"
                        }`}
                      >
                        <span className="font-mono truncate">{id}</span>
                        {isSelected ? (
                          <span className="material-symbols-outlined text-primary text-[16px]">check</span>
                        ) : (
                          <span className="material-symbols-outlined text-text-muted text-[16px]">add</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-end gap-3 border-t border-border px-6 py-4 bg-surface-2/40">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-lg border border-border text-text-muted hover:text-text-main hover:bg-surface transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={isSaving}
            onClick={handleSave}
            className="px-5 py-2 text-sm font-medium rounded-lg bg-primary text-white hover:bg-primary/90 transition-all shadow-sm flex items-center gap-2"
          >
            {isSaving ? "Saving..." : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ApiKeysAccessPageClient() {
  const [keys, setKeys] = useState([]);
  const [allModels, setAllModels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [editingKey, setEditingKey] = useState(null);
  const [savingId, setSavingId] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const [keysRes, modelsRes] = await Promise.all([
        fetch("/api/keys", { cache: "no-store" }),
        fetch("/api/v1/models", { cache: "no-store" }).catch(() => null),
      ]);
      if (!keysRes.ok) throw new Error(`HTTP ${keysRes.status}`);
      const data = await keysRes.json();
      setKeys(data.keys || []);
      if (modelsRes && modelsRes.ok) {
        const md = await modelsRes.json().catch(() => ({}));
        const ids = (md.data || md.models || []).map((m) => (typeof m === "string" ? m : m.id)).filter(Boolean);
        setAllModels([...new Set(ids)].sort());
      }
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
        setKeys((prev) =>
          prev.map((k) => (k.id === id ? { ...k, ...patch, ...(data.key || {}) } : k))
        );
        setEditingKey(null);
      }
    } catch (e) {
      console.log("Error saving key access:", e);
    } finally {
      setSavingId("");
    }
  };

  const filteredKeys = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return keys;
    return keys.filter(
      (k) =>
        (k.name || "").toLowerCase().includes(q) ||
        (k.key || "").toLowerCase().includes(q)
    );
  }, [keys, search]);

  return (
    <div className="max-w-6xl mx-auto px-2 sm:px-4 py-6 flex flex-col gap-6">
      {/* Header section */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-main flex items-center gap-2">
            <span className="material-symbols-outlined text-primary text-[28px]">vpn_key</span>
            API Key Governance & Limits
          </h1>
          <p className="text-sm text-text-muted mt-1">
            Configure RPM, concurrency throttle, queue buffers, and model allowlists with wildcard support.
          </p>
        </div>

        {/* Search bar */}
        <div className="relative w-full sm:w-72">
          <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-text-muted text-[18px]">
            search
          </span>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter keys by name or token..."
            className="w-full rounded-xl border border-border bg-input pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>
      </div>

      {error ? (
        <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-400 flex items-center gap-2">
          <span className="material-symbols-outlined text-[18px]">error</span>
          {error}
        </div>
      ) : null}

      {/* Main Compact Table Card */}
      <div className="rounded-2xl border border-border bg-surface shadow-sm overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-sm text-text-muted">Loading API keys...</div>
        ) : filteredKeys.length === 0 ? (
          <div className="p-12 text-center text-sm text-text-muted">
            {search ? "No matching API keys found." : "No API keys created yet."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-2/40 text-xs font-medium text-text-muted">
                  <th className="py-3.5 px-4 font-semibold">Key & Identification</th>
                  <th className="py-3.5 px-4 font-semibold">Status</th>
                  <th className="py-3.5 px-4 font-semibold">RPM & Concurrency</th>
                  <th className="py-3.5 px-4 font-semibold">Queue Timeout</th>
                  <th className="py-3.5 px-4 font-semibold">Token Quota</th>
                  <th className="py-3.5 px-4 font-semibold">Allowed Models</th>
                  <th className="py-3.5 px-4 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredKeys.map((key) => {
                  const allowed = key.allowedModels || [];
                  const isWildcard = allowed.some((m) => m.includes("*"));
                  const quota = key.tokenQuota ?? 0;
                  const used = key.tokensUsed ?? 0;

                  return (
                    <tr
                      key={key.id}
                      className="hover:bg-surface-2/30 transition-colors group"
                    >
                      {/* Name & Key */}
                      <td className="py-3 px-4">
                        <div className="font-semibold text-text-main truncate max-w-[180px]">
                          {key.name || "Unnamed Key"}
                        </div>
                        <div className="text-xs font-mono text-text-muted mt-0.5">
                          {maskKey(key.key)}
                        </div>
                      </td>

                      {/* Status */}
                      <td className="py-3 px-4">
                        {key.isActive === false ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 text-amber-500 px-2 py-0.5 text-xs font-medium">
                            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                            Paused
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 text-emerald-600 px-2 py-0.5 text-xs font-medium">
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                            Active
                          </span>
                        )}
                      </td>

                      {/* RPM & Concurrency */}
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span
                            className={`px-2 py-0.5 rounded-md text-xs font-medium border ${
                              key.rpm > 0
                                ? "bg-surface-2 border-border text-text-main"
                                : "bg-surface-2/20 border-border/50 text-text-muted"
                            }`}
                          >
                            {key.rpm > 0 ? `${key.rpm} RPM` : "Unl RPM"}
                          </span>
                          <span
                            className={`px-2 py-0.5 rounded-md text-xs font-medium border ${
                              key.concurrency > 0
                                ? "bg-primary/10 border-primary/20 text-primary font-semibold"
                                : "bg-surface-2/20 border-border/50 text-text-muted"
                            }`}
                          >
                            {key.concurrency > 0 ? `${key.concurrency} Conc` : "Unl Conc"}
                          </span>
                        </div>
                      </td>

                      {/* Queue Timeout */}
                      <td className="py-3 px-4 text-xs font-medium text-text-main">
                        {key.queueTimeoutMs > 0
                          ? `${key.queueTimeoutMs >= 1000 ? Math.round(key.queueTimeoutMs / 1000) : key.queueTimeoutMs}s buffer`
                          : "60s (default)"}
                      </td>

                      {/* Token Quota */}
                      <td className="py-3 px-4">
                        <div className="text-xs">
                          <span className="font-mono font-medium text-text-main">
                            {fmt(used)}
                          </span>
                          <span className="text-text-muted">
                            {quota > 0 ? ` / ${fmt(quota)}` : " / Unl"}
                          </span>
                        </div>
                      </td>

                      {/* Allowed Models */}
                      <td className="py-3 px-4">
                        {allowed.length === 0 ? (
                          <span className="text-xs text-text-muted font-medium">
                            All Models (Unrestricted)
                          </span>
                        ) : (
                          <div className="flex items-center gap-1 flex-wrap max-w-[220px]">
                            {allowed.slice(0, 2).map((m) => (
                              <span
                                key={m}
                                className={`px-1.5 py-0.5 rounded text-[11px] font-mono border ${
                                  m.includes("*")
                                    ? "bg-amber-500/10 border-amber-500/30 text-amber-500 font-semibold"
                                    : "bg-surface-2 border-border text-text-main"
                                }`}
                              >
                                {m}
                              </span>
                            ))}
                            {allowed.length > 2 ? (
                              <span className="text-[11px] font-medium text-text-muted px-1">
                                +{allowed.length - 2} more
                              </span>
                            ) : null}
                          </div>
                        )}
                      </td>

                      {/* Actions */}
                      <td className="py-3 px-4 text-right">
                        <button
                          type="button"
                          onClick={() => setEditingKey(key)}
                          className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg border border-border bg-surface hover:bg-surface-2 text-text-main transition-colors shadow-sm"
                        >
                          <span className="material-symbols-outlined text-[16px]">edit</span>
                          Edit
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Edit Config Modal */}
      <KeyConfigModal
        keyData={editingKey}
        allModels={allModels}
        isOpen={Boolean(editingKey)}
        onClose={() => setEditingKey(null)}
        onSave={savePatch}
        isSaving={savingId === editingKey?.id}
      />
    </div>
  );
}
