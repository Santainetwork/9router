"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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

// Searchable multi-select for the model allowlist. `all` is the list of known
// model ids (request format, e.g. "myr/qd/auto"); `value` is the current
// allowlist. Also allows adding a free-typed id not present in the list.
function ModelAllowlist({ all, value, onChange, disabled }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef(null);
  const selected = value || [];

  useEffect(() => {
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q ? all.filter((m) => m.toLowerCase().includes(q)) : all;
    return base.slice(0, 200);
  }, [all, query]);

  const toggle = (id) => {
    const next = selected.includes(id) ? selected.filter((m) => m !== id) : [...selected, id];
    onChange(next);
  };

  const addTyped = () => {
    const id = query.trim();
    if (id && !selected.includes(id)) onChange([...selected, id]);
    setQuery("");
  };

  return (
    <div className="flex flex-col gap-2" ref={ref}>
      <div className="flex items-center justify-between">
        <label className="text-xs text-text-muted">Allowed models (blank = all)</label>
        {selected.length > 0 ? (
          <button type="button" onClick={() => onChange([])} disabled={disabled} className="text-[11px] text-text-muted hover:text-text-main underline">
            Clear all
          </button>
        ) : null}
      </div>

      {selected.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((id) => (
            <span key={id} className="inline-flex items-center gap-1 rounded-full bg-primary/10 text-primary px-2 py-0.5 text-xs">
              <span className="font-mono">{id}</span>
              <button type="button" onClick={() => toggle(id)} disabled={disabled} className="hover:text-red-500" aria-label={`Remove ${id}`}>
                <span className="material-symbols-outlined text-[14px]">close</span>
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="text-[11px] text-text-muted">No restriction — this key may use any model.</p>
      )}

      <div className="relative">
        <input
          type="text"
          value={query}
          disabled={disabled}
          onFocus={() => setOpen(true)}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTyped(); } }}
          placeholder="Search models to add, or type an id + Enter"
          className="w-full rounded border border-border bg-input px-2 py-1 text-sm"
        />
        {open ? (
          <div className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-border bg-surface shadow-lg custom-scrollbar">
            {filtered.length === 0 ? (
              <button type="button" onClick={addTyped} className="block w-full px-3 py-2 text-left text-sm hover:bg-surface-2">
                Add "<span className="font-mono">{query.trim()}</span>"
              </button>
            ) : (
              filtered.map((id) => {
                const on = selected.includes(id);
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => toggle(id)}
                    className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-2 ${on ? "text-primary" : ""}`}
                  >
                    <span className="font-mono truncate">{id}</span>
                    {on ? <span className="material-symbols-outlined text-[16px]">check</span> : null}
                  </button>
                );
              })
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default function ApiKeysAccessPageClient() {
  const [keys, setKeys] = useState([]);
  const [allModels, setAllModels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
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
        <p className="text-[11px] text-text-subtle mt-1">Modified by SantaiNetwork</p>
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

                <div className="grid gap-3 sm:grid-cols-4">
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-text-muted">RPM (0 = unl)</label>
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
                    <label className="text-xs text-text-muted">Max Concurrency</label>
                    <input
                      type="number"
                      min="0"
                      defaultValue={key.concurrency ?? 0}
                      onBlur={(e) => {
                        const concurrency = Math.max(0, parseInt(e.target.value, 10) || 0);
                        if (concurrency !== (key.concurrency ?? 0)) savePatch(key.id, { concurrency });
                      }}
                      className="rounded border border-border bg-input px-2 py-1 text-sm"
                      placeholder="0 = unl"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-text-muted">Queue timeout ms</label>
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
                    <label className="text-xs text-text-muted">Token quota</label>
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

                <ModelAllowlist
                  all={allModels}
                  value={key.allowedModels || []}
                  disabled={savingId === key.id}
                  onChange={(allowedModels) => savePatch(key.id, { allowedModels })}
                />
              </div>
            </Card>
          );
        })
      )}
    </div>
  );
}
