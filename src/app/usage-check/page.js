"use client";

import { useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const PERIODS = [
  { d: 1, label: "1D" },
  { d: 7, label: "7D" },
  { d: 14, label: "14D" },
  { d: 30, label: "30D" },
];

function fmt(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + "M";
  if (v >= 1_000) return (v / 1_000).toFixed(1) + "k";
  return String(Math.round(v));
}

function StatBox({ label, value, sub, color = "default" }) {
  const colorMap = {
    default: "text-text-main",
    primary: "text-primary",
    emerald: "text-emerald-500",
    amber: "text-amber-500",
  };

  return (
    <div className="rounded-xl border border-border bg-surface-2/30 p-3.5 flex flex-col justify-between">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
        {label}
      </span>
      <div className="mt-1.5">
        <p className={cn("text-2xl font-bold tabular-nums tracking-tight font-mono", colorMap[color])}>
          {value}
        </p>
        {sub ? (
          <p className="mt-0.5 text-[11px] text-text-muted font-medium">{sub}</p>
        ) : null}
      </div>
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
      setError("Please enter your API key first.");
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
        setError(body?.error || `Request failed with HTTP status ${res.status}`);
        setData(null);
      } else {
        setData(body);
      }
    } catch (e) {
      setError(e.message || "Network error occurred.");
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
    <div className="min-h-screen bg-bg text-text-main px-4 py-12 flex flex-col items-center justify-start">
      <div className="w-full max-w-2xl flex flex-col gap-6">
        {/* Header Section */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 self-start">
            <span className="px-2.5 py-0.5 text-xs font-semibold rounded-full bg-primary/10 text-primary border border-primary/20">
              9Router Gateway
            </span>
            <span className="px-2 py-0.5 text-[11px] font-mono text-text-muted rounded-full bg-surface-2 border border-border">
              Self-Service Portal
            </span>
          </div>

          <h1 className="text-3xl font-bold tracking-tight text-text-main mt-1 flex items-center gap-2.5">
            <span className="material-symbols-outlined text-primary text-[32px]">manage_search</span>
            API Usage & Quota Check
          </h1>
          <p className="text-sm text-text-muted">
            Inspect real-time token quotas, concurrency parameters, and model permissions for your API key.
          </p>
        </div>

        {/* Input Card */}
        <div className="rounded-2xl border border-border bg-surface p-6 shadow-xs space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wider text-text-muted">
              Your API Key
            </label>
            <Input
              type="password"
              placeholder="sk-..."
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && check()}
              className="font-mono text-sm"
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            {/* Period Selector */}
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-semibold text-text-muted mr-1">
                Period:
              </span>
              {PERIODS.map((p) => (
                <button
                  key={p.d}
                  type="button"
                  onClick={() => {
                    setDays(p.d);
                    if (data) check(p.d);
                  }}
                  className={cn(
                    "px-3 py-1 text-xs font-semibold rounded-lg transition-all",
                    days === p.d
                      ? "bg-primary text-white shadow-xs"
                      : "bg-surface-2 text-text-muted hover:text-text-main"
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>

            <Button
              type="button"
              onClick={() => check()}
              disabled={loading}
              className="gap-2"
            >
              {loading ? "Checking..." : "Inspect Usage"}
            </Button>
          </div>

          {error ? (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-500 font-medium">
              {error}
            </div>
          ) : null}
        </div>

        {/* Results Section */}
        {data ? (
          <div className="flex flex-col gap-6 animate-in fade-in duration-200">
            {/* Overview Card */}
            <div className="rounded-2xl border border-border bg-surface p-6 shadow-xs space-y-5">
              <div className="flex items-center justify-between border-b border-border/70 pb-3">
                <div className="flex items-center gap-2">
                  <span className="size-2.5 rounded-full bg-emerald-500 animate-pulse" />
                  <span className="text-sm font-bold text-text-main">
                    Key: {data.key?.name || "Active Key"}
                  </span>
                </div>
                <span className="text-xs font-mono text-text-muted">
                  {data.key?.keyMasked || ""}
                </span>
              </div>

              {/* Token Quota Progress */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs font-medium">
                  <span className="text-text-muted">All-Time Token Quota</span>
                  <span className="font-mono">
                    {fmt(used)} {quota > 0 ? `/ ${fmt(quota)} (${pct}%)` : "(Unlimited)"}
                  </span>
                </div>
                {quota > 0 ? (
                  <div className="h-2 w-full rounded-full bg-border overflow-hidden">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all",
                        pct >= 100 ? "bg-red-500" : pct >= 80 ? "bg-amber-500" : "bg-primary"
                      )}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                ) : null}
              </div>

              {/* 3 Stats in Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <StatBox
                  label={`Requests (${days}d)`}
                  value={fmt(data.usage?.requestsInPeriod || 0)}
                  sub="HTTP requests processed"
                  color="primary"
                />
                <StatBox
                  label={`Tokens (${days}d)`}
                  value={fmt(data.usage?.tokensInPeriod || 0)}
                  sub="Prompt + completion"
                  color="default"
                />
                <StatBox
                  label="Remaining Quota"
                  value={remaining != null ? fmt(remaining) : "Unl"}
                  sub={remaining != null ? "Tokens left" : "No hard ceiling"}
                  color={remaining != null && remaining < 10000 ? "amber" : "emerald"}
                />
              </div>

              {/* Rate Limits Pills */}
              <div className="rounded-xl border border-border bg-surface-2/20 p-4 space-y-2">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                  Governed Traffic Throttles
                </p>
                <div className="flex flex-wrap gap-2 text-xs font-mono">
                  <span className="px-2.5 py-1 rounded-lg bg-surface border border-border text-text-main">
                    RPM: <strong className="text-primary">{data.limits?.requestsPerMinute || "Unlimited"}</strong>
                  </span>
                  <span className="px-2.5 py-1 rounded-lg bg-surface border border-border text-text-main">
                    Concurrency: <strong className="text-primary">{data.limits?.concurrency || "Unlimited"}</strong>
                  </span>
                  <span className="px-2.5 py-1 rounded-lg bg-surface border border-border text-text-main">
                    Queue Buffer: <strong className="text-primary">{data.limits?.queueTimeoutMs ? `${data.limits.queueTimeoutMs}ms` : "60s (default)"}</strong>
                  </span>
                </div>
              </div>

              {/* Allowed Models */}
              <div className="space-y-2">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                  Allowed Models
                </p>
                {data.limits?.allowedModels && data.limits.allowedModels.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {data.limits.allowedModels.map((m) => (
                      <span
                        key={m}
                        className={cn(
                          "px-2 py-0.5 rounded-md text-xs font-mono border",
                          m.includes("*")
                            ? "bg-primary/10 border-primary/20 text-primary font-semibold"
                            : "bg-surface-2 border-border text-text-main"
                        )}
                      >
                        {m}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-text-muted">
                    All models permitted (unrestricted access).
                  </p>
                )}
              </div>
            </div>

            {/* Model Breakdown */}
            {models.length > 0 ? (
              <div className="rounded-2xl border border-border bg-surface p-6 shadow-xs space-y-3">
                <p className="text-xs font-bold uppercase tracking-wider text-text-muted">
                  Usage by Model ({days}d)
                </p>
                <div className="divide-y divide-border/60">
                  {models.map(([modelName, modelUsage]) => (
                    <div key={modelName} className="flex items-center justify-between py-2.5 text-xs">
                      <span className="font-mono font-semibold text-text-main truncate max-w-[260px]">
                        {modelName}
                      </span>
                      <div className="text-right font-mono">
                        <span className="font-bold text-text-main">{fmt(modelUsage.total_tokens || 0)} tok</span>
                        <span className="text-text-muted ml-2">({modelUsage.requests || 0} reqs)</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Footer info */}
        <div className="text-center text-xs text-text-muted pt-4">
          <p>Powered by SantaiNetwork 9Router AI Gateway</p>
        </div>
      </div>
    </div>
  );
}
