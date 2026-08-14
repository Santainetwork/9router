"use client";

import { useEffect, useRef, useState } from "react";
import { Card } from "@/shared/components";

// Admin: dedicated live view of the RPM request queue. Shows how many requests
// are waiting for a slot (per API key / provider) plus in-window usage.
// Polls GET /api/queue every 3s; pause toggle to freeze.

export default function QueueMonitorClient() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [paused, setPaused] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (pausedRef.current) return;
      try {
        const res = await fetch("/api/queue", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        if (alive) { setData(j); setUpdatedAt(new Date()); setError(""); }
      } catch (e) {
        if (alive) setError(e.message || "Failed to load queue");
      }
    };
    load();
    const id = setInterval(load, 3000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const buckets = data?.buckets || [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Request Queue</h1>
          <p className="mt-1 text-sm text-text-muted">
            Live view of requests waiting on an RPM limit. Admin only.
          </p>
          <p className="mt-1 text-[11px] text-text-subtle">Modified by SantaiNetwork</p>
        </div>
        <button
          type="button"
          onClick={() => setPaused((p) => !p)}
          className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-2 text-sm hover:bg-surface-2 transition"
        >
          <span className="material-symbols-outlined text-[18px]">{paused ? "play_arrow" : "pause"}</span>
          {paused ? "Resume" : "Pause"}
        </button>
      </div>

      {/* Totals */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Card>
          <p className="text-xs uppercase tracking-wide text-text-muted">Total queued</p>
          <p className="mt-1 text-3xl font-semibold tabular-nums">{data ? data.totalQueued : "…"}</p>
          <p className="mt-0.5 text-xs text-text-muted">waiting for a slot</p>
        </Card>
        <Card>
          <p className="text-xs uppercase tracking-wide text-text-muted">Active buckets</p>
          <p className="mt-1 text-3xl font-semibold tabular-nums">{data ? data.totalActiveWindows : "…"}</p>
          <p className="mt-0.5 text-xs text-text-muted">using their RPM window</p>
        </Card>
        <Card className="col-span-2 sm:col-span-1">
          <p className="text-xs uppercase tracking-wide text-text-muted">Status</p>
          <p className="mt-1 flex items-center gap-2 text-sm">
            <span className={"inline-flex size-2 rounded-full " + (paused ? "bg-text-subtle" : "bg-green-500 animate-pulse")} />
            {paused ? "Paused" : "Live (3s)"}
          </p>
          <p className="mt-0.5 text-xs text-text-muted">
            {updatedAt ? `updated ${updatedAt.toLocaleTimeString()}` : "…"}
          </p>
        </Card>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-400">{error}</div>
      ) : null}

      {/* Buckets */}
      <Card>
        <p className="mb-3 text-sm font-medium">Buckets</p>
        {buckets.length === 0 ? (
          <div className="py-8 text-center">
            <span className="material-symbols-outlined text-3xl text-text-subtle">check_circle</span>
            <p className="mt-1 text-sm text-text-muted">Nothing queued. No request is waiting on an RPM limit right now.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-text-muted">
                  <th className="py-2 pr-3 font-medium">Name</th>
                  <th className="py-2 pr-3 font-medium">Scope</th>
                  <th className="py-2 pr-3 font-medium text-right">RPM</th>
                  <th className="py-2 pr-3 font-medium text-right">In window</th>
                  <th className="py-2 pr-3 font-medium text-right">Queued</th>
                  <th className="py-2 font-medium text-right">Window reset</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {buckets.map((b) => (
                  <tr key={`${b.scope}:${b.key}`}>
                    <td className="py-2 pr-3 font-medium truncate max-w-[180px]">{b.label}</td>
                    <td className="py-2 pr-3 text-text-muted">{b.scope === "apikey" ? "API key" : "provider"}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{b.rpm || "∞"}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{b.inWindow}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {b.queued > 0 ? (
                        <span className="rounded-full bg-orange-500/15 px-2 py-0.5 text-xs font-medium text-orange-500">{b.queued}</span>
                      ) : (
                        <span className="text-text-subtle">0</span>
                      )}
                    </td>
                    <td className="py-2 text-right tabular-nums text-text-muted">{(b.windowResetInMs / 1000).toFixed(1)}s</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
