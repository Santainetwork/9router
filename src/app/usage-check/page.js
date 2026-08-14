"use client";

import { useState } from "react";
import { Card, Button, Input } from "@/shared/components";

// Public self-service usage-check page. A friend pastes THEIR OWN API key and
// sees only that key's limits + usage. Lives outside the (dashboard) group so
// it needs no login cookie — safe to expose over the public domain.
// Calls the same-origin GET /api/v1/usage endpoint.

const PERIODS = [
  { d: 1, label: "1 day" },
  { d: 7, label: "7 days" },
  { d: 14, label: "14 days" },
  { d: 30, label: "30 days" },
];

function fmt(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + "M";
  if (v >= 1_000) return (v / 1_000).toFixed(1) + "k";
  return String(Math.round(v));
}

function Stat({ label, value, sub }) {
  return (
    <div className="rounded-lg border border-border bg-bg p-3">
      <p className="text-xs uppercase tracking-wide text-text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
      {sub ? <p className="mt-0.5 text-xs text-text-muted">{sub}</p> : null}
    </div>
  );
}

export default function UsageCheckPage() {
  const [key, setKey] = useState("");
  const [days, setDays] = useState(7);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function check(period = days) {
    const k = key.trim();
    if (!k) {
      setError("Enter your API key.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/v1/usage?period=${period}d`, {
        headers: { Authorization: `Bearer ${k}` },
        cache: "no-store",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body?.error || `Request failed (${res.status})`);
        setData(null);
      } else {
        setData(body);
      }
    } catch (e) {
      setError(e.message || "Network error");
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  const quota = data?.limits?.tokenQuota || 0;
  const used = data?.usage?.tokensUsedAllTime || 0;
  const remaining = data?.usage?.tokensRemaining;
  const pct = quota > 0 ? Math.min(100, Math.round((used / quota) * 100)) : 0;
  const models = data ? Object.entries(data.usage.byModel || {}) : [];

  return (
    <div className="min-h-screen bg-bg text-text-main px-4 py-10">
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        <div>
          <h1 className="text-2xl font-semibold">Usage Check</h1>
          <p className="mt-1 text-sm text-text-muted">
            Paste your API key to see your limits and usage. Only your own key&apos;s data is shown.
          </p>
          <p className="mt-1 text-[11px] text-text-subtle">Modified by SantaiNetwork</p>
        </div>

        <Card>
          <div className="flex flex-col gap-3">
            <Input
              type="password"
              placeholder="sk-..."
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && check()}
              aria-label="API key"
            />
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex rounded-lg bg-black/5 dark:bg-white/5 p-1">
                {PERIODS.map((p) => (
                  <button
                    key={p.d}
                    type="button"
                    onClick={() => { setDays(p.d); if (data) check(p.d); }}
                    className={
                      "px-3 py-1.5 rounded-md text-xs font-medium transition " +
                      (days === p.d ? "bg-white dark:bg-white/10 text-text-main shadow-sm" : "text-text-muted hover:text-text-main")
                    }
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <Button onClick={() => check()} loading={loading} icon="search" className="ml-auto">
                Check
              </Button>
            </div>
            {error ? (
              <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-400">{error}</div>
            ) : null}
          </div>
        </Card>

        {data ? (
          <>
            <Card>
              <div className="mb-3 flex items-center justify-between">
                <p className="text-sm font-medium">{data.key?.name || "Your key"}</p>
                <span className="text-xs text-text-muted">last {data.usage.period.days}d</span>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Requests / min" value={data.limits.requestsPerMinute > 0 ? data.limits.requestsPerMinute : "Unlimited"} />
                <Stat label="Requests" value={fmt(data.usage.requests)} sub={`in ${data.usage.period.days}d`} />
                <Stat label="Tokens" value={fmt(data.usage.totalTokens)} sub={`in ${data.usage.period.days}d`} />
                <Stat
                  label="Quota"
                  value={quota > 0 ? fmt(quota) : "Unlimited"}
                  sub={quota > 0 ? `${fmt(remaining)} left` : "no cap"}
                />
              </div>
              {quota > 0 ? (
                <div className="mt-3">
                  <div className="h-2 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
                    <div
                      className={"h-full rounded-full " + (pct >= 100 ? "bg-red-500" : pct >= 80 ? "bg-orange-500" : "bg-green-500")}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <p className="mt-1 text-xs text-text-muted">{fmt(used)} / {fmt(quota)} tokens used all-time ({pct}%)</p>
                </div>
              ) : null}
            </Card>

            <Card>
              <p className="mb-2 text-sm font-medium">Models you can use</p>
              {data.access.restricted ? (
                <div className="flex flex-wrap gap-2">
                  {data.access.allowedModels.map((m) => (
                    <span key={m} className="rounded-full border border-border bg-bg px-2.5 py-1 text-xs font-mono">{m}</span>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-text-muted">
                  <span className="material-symbols-outlined align-middle text-[18px] text-green-500">check_circle</span>{" "}
                  All models are available (no restriction).
                </p>
              )}
            </Card>

            {models.length > 0 ? (
              <Card>
                <p className="mb-2 text-sm font-medium">Usage by model (last {data.usage.period.days}d)</p>
                <div className="flex flex-col divide-y divide-border">
                  {models
                    .sort((a, b) => (b[1].promptTokens + b[1].completionTokens) - (a[1].promptTokens + a[1].completionTokens))
                    .map(([m, v]) => (
                      <div key={m} className="flex items-center justify-between gap-3 py-2">
                        <p className="truncate font-mono text-xs">{m}</p>
                        <p className="shrink-0 text-xs tabular-nums text-text-muted">
                          {fmt(v.requests)} req · {fmt(v.promptTokens + v.completionTokens)} tok
                        </p>
                      </div>
                    ))}
                </div>
              </Card>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
