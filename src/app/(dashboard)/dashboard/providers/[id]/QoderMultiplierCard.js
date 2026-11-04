"use client";

import { useEffect, useMemo, useState } from "react";
import { Card } from "@/shared/components";

// Live Qoder credit burn rate per model. The catalog at
// /algo/api/v2/model/list publishes `price_factor` for every chat model, so we
// read it through our own /api/providers/[id]/models endpoint instead of
// hardcoding a table that would drift per plan/region. Display-only: nothing
// here feeds routing or billing.
export default function QoderMultiplierCard({ connectionId }) {
  const [sorted, setSorted] = useState(true);
  const [rows, setRows] = useState([]);
  const [state, setState] = useState("loading"); // loading | ready | error

  useEffect(() => {
    if (!connectionId) {
      setRows([]);
      setState("error");
      return;
    }
    let cancelled = false;
    setState("loading");
    fetch(`/api/providers/${connectionId}/models`, { cache: "no-store" })
      .then(async (res) => ({ ok: res.ok, data: await res.json().catch(() => null) }))
      .then(({ ok, data }) => {
        if (cancelled) return;
        const list = Array.isArray(data?.models) ? data.models : [];
        const withFactor = list
          .filter((m) => m.priceFactor != null)
          .map((m) => ({
            id: m.id,
            label: m.name || m.id,
            multiplier: Number(m.priceFactor),
          }));
        setRows(withFactor);
        setState(ok && withFactor.length > 0 ? "ready" : "error");
      })
      .catch(() => {
        if (!cancelled) {
          setRows([]);
          setState("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId]);

  const ordered = useMemo(
    () => (sorted ? [...rows].sort((a, b) => a.multiplier - b.multiplier) : rows),
    [rows, sorted],
  );

  return (
    <Card>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">Credit Multiplier</h2>
          <p className="mt-0.5 text-xs text-text-muted">
            Live Qoder price factor per model. Lower is cheaper.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setSorted((v) => !v)}
          className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-text-muted transition-colors hover:bg-black/5 hover:text-text-primary dark:hover:bg-white/5"
          title={sorted ? "Show catalog order" : "Sort by multiplier (lowest first)"}
        >
          {sorted ? "Sort: multiplier" : "Sort: catalog"}
        </button>
      </div>
      {state === "loading" ? (
        <p className="text-sm text-text-muted">Loading catalog…</p>
      ) : state === "error" ? (
        <p className="text-sm text-text-muted">
          No multiplier data — connect an active Qoder account and reload.
        </p>
      ) : (
        <div className="max-h-80 overflow-auto rounded-lg border border-border-subtle">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-surface-2 text-text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Model</th>
                <th className="px-3 py-2 text-right font-medium">Multiplier</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {ordered.map((m) => (
                <tr key={m.id} className="hover:bg-black/[0.02] dark:hover:bg-white/[0.03]">
                  <td className="px-3 py-2 font-mono text-text-primary">{m.label}</td>
                  <td
                    className={`px-3 py-2 text-right font-mono font-semibold ${
                      m.multiplier === 0
                        ? "text-success dark:text-success"
                        : m.multiplier >= 2
                          ? "text-danger dark:text-danger"
                          : m.multiplier >= 1
                            ? "text-warning dark:text-warning"
                            : "text-text-primary"
                    }`}
                  >
                    {m.multiplier === 0 ? "free" : `${m.multiplier.toFixed(2)}x`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
