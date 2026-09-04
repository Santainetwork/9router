"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

function NeoBox({ children, className = "", bg = "bg-white dark:bg-neutral-900" }) {
  return (
    <div
      className={cn(
        "rounded-2xl border-2 border-black dark:border-white/90 shadow-[4px_4px_0px_#000] dark:shadow-[4px_4px_0px_#fff] p-6 transition-all",
        bg,
        className
      )}
    >
      {children}
    </div>
  );
}

function NeoStat({ label, value, sub, bg = "bg-yellow-400 text-black", border = "border-black" }) {
  return (
    <div
      className={cn(
        "rounded-xl border-2 shadow-[3px_3px_0px_#000] dark:shadow-[3px_3px_0px_#fff] p-4 flex flex-col justify-between",
        border,
        bg
      )}
    >
      <span className="text-[11px] font-black uppercase tracking-wider opacity-85">
        {label}
      </span>
      <div className="mt-2">
        <p className="text-2xl font-black tabular-nums tracking-tight font-mono">
          {value}
        </p>
        {sub ? (
          <p className="mt-0.5 text-[11px] font-bold opacity-80">{sub}</p>
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

  return (
    <div className="min-h-screen bg-[#FFFDF9] dark:bg-[#0B0F19] text-black dark:text-white px-4 py-12 selection:bg-yellow-400 selection:text-black">
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        {/* Header Section */}
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2 self-start">
            <span className="rounded-md border-2 border-black dark:border-white bg-yellow-400 text-black px-2.5 py-0.5 text-xs font-black uppercase tracking-wider shadow-[2px_2px_0px_#000] dark:shadow-[2px_2px_0px_#fff]">
              9Router AI
            </span>
            <span className="rounded-md border-2 border-black dark:border-white bg-cyan-400 text-black px-2 py-0.5 text-[11px] font-black uppercase tracking-wide shadow-[2px_2px_0px_#000] dark:shadow-[2px_2px_0px_#fff]">
              Self-Service Portal
            </span>
          </div>

          <h1 className="text-3xl sm:text-4xl font-black uppercase tracking-tight mt-1">
            Usage & Quota Check
          </h1>
          <p className="text-sm font-bold text-neutral-700 dark:text-neutral-300">
            Paste your API key below to inspect real-time token quotas, concurrency parameters, and model permissions.
          </p>
        </div>

        {/* Input Card */}
        <NeoBox bg="bg-white dark:bg-neutral-900">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-black uppercase tracking-wide text-neutral-800 dark:text-neutral-200">
                Your API Key
              </label>
              <input
                type="password"
                placeholder="sk-..."
                value={key}
                onChange={(e) => setKey(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && check()}
                aria-label="API key"
                className="w-full rounded-xl border-2 border-black dark:border-white bg-[#FAF8F5] dark:bg-neutral-800 px-3.5 py-2.5 text-sm font-mono font-bold text-black dark:text-white placeholder:text-neutral-400 focus:outline-none focus:bg-yellow-50 dark:focus:bg-neutral-800 shadow-[3px_3px_0px_#000] dark:shadow-[3px_3px_0px_#fff] transition-all"
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              {/* Period Selector Buttons */}
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-black uppercase mr-1 text-neutral-600 dark:text-neutral-400">
                  Window:
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
                      "px-3 py-1 text-xs font-black rounded-lg border-2 border-black dark:border-white transition-all shadow-[2px_2px_0px_#000] dark:shadow-[2px_2px_0px_#fff]",
                      days === p.d
                        ? "bg-cyan-400 text-black translate-x-[-1px] translate-y-[-1px]"
                        : "bg-white dark:bg-neutral-800 text-black dark:text-white hover:bg-neutral-100 dark:hover:bg-neutral-700"
                    )}
                  >
                    {p.label}
                  </button>
                ))}
              </div>

              {/* Action Button */}
              <button
                type="button"
                onClick={() => check()}
                disabled={loading}
                className="inline-flex items-center justify-center gap-2 rounded-xl border-2 border-black dark:border-white bg-yellow-400 hover:bg-yellow-300 text-black font-black uppercase text-xs px-5 py-2.5 shadow-[3px_3px_0px_#000] dark:shadow-[3px_3px_0px_#fff] hover:translate-x-[-1px] hover:translate-y-[-1px] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              >
                {loading ? "Checking..." : "Inspect Usage ⚡"}
              </button>
            </div>

            {error ? (
              <div className="rounded-xl border-2 border-black dark:border-red-400 bg-red-400 text-black p-3 text-xs font-black shadow-[3px_3px_0px_#000] dark:shadow-[3px_3px_0px_#fff]">
                ⚠️ {error}
              </div>
            ) : null}
          </div>
        </NeoBox>

        {/* Results Section */}
        {data ? (
          <div className="flex flex-col gap-6 animate-in fade-in duration-200">
            {/* Key Information & Metrics Card */}
            <NeoBox bg="bg-white dark:bg-neutral-900">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b-2 border-black dark:border-white/30 pb-3">
                <div className="flex items-center gap-2">
                  <span className="inline-block h-3 w-3 rounded-full bg-emerald-400 border-2 border-black" />
                  <span className="text-sm font-black uppercase tracking-wide text-black dark:text-white">
                    Key: {data.key?.name || "Active Key"}
                  </span>
                </div>
                <span className="rounded-md border-2 border-black dark:border-white bg-[#FAF8F5] dark:bg-neutral-800 px-2 py-0.5 text-xs font-mono font-bold text-neutral-800 dark:text-neutral-200 shadow-[2px_2px_0px_#000] dark:shadow-[2px_2px_0px_#fff]">
                  {data.key?.keyMasked || ""}
                </span>
              </div>

              {/* Token Quota Progress Bar */}
              <div className="mb-6 flex flex-col gap-2">
                <div className="flex items-center justify-between text-xs font-black">
                  <span className="text-neutral-800 dark:text-neutral-200 uppercase">
                    All-Time Token Quota
                  </span>
                  <span className="font-mono">
                    {fmt(used)} {quota > 0 ? `/ ${fmt(quota)} (${pct}%)` : "(Unlimited)"}
                  </span>
                </div>
                {quota > 0 ? (
                  <div className="h-4 w-full rounded-lg border-2 border-black dark:border-white bg-[#FAF8F5] dark:bg-neutral-800 p-0.5 shadow-[2px_2px_0px_#000] dark:shadow-[2px_2px_0px_#fff]">
                    <div
                      className={cn(
                        "h-full rounded-md border-r-2 border-black transition-all",
                        pct >= 100
                          ? "bg-red-500"
                          : pct >= 80
                          ? "bg-amber-400"
                          : "bg-emerald-400"
                      )}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                ) : null}
              </div>

              {/* 3 NeoStats Grid */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <NeoStat
                  label={`Requests (${days}D)`}
                  value={fmt(data.usage?.requestsInPeriod || 0)}
                  sub="HTTP requests processed"
                  bg="bg-cyan-300 text-black"
                />
                <NeoStat
                  label={`Tokens (${days}D)`}
                  value={fmt(data.usage?.tokensInPeriod || 0)}
                  sub="Prompt + completion"
                  bg="bg-pink-300 text-black"
                />
                <NeoStat
                  label="Remaining Quota"
                  value={remaining != null ? fmt(remaining) : "Unl"}
                  sub={remaining != null ? "Tokens available" : "No hard limit"}
                  bg="bg-yellow-300 text-black"
                />
              </div>

              {/* Traffic Throttle Pills */}
              <div className="mt-5 rounded-xl border-2 border-black dark:border-white/80 bg-[#FAF8F5] dark:bg-neutral-800 p-4 shadow-[3px_3px_0px_#000] dark:shadow-[3px_3px_0px_#fff]">
                <p className="text-[11px] font-black uppercase tracking-wider text-black dark:text-neutral-200 mb-2">
                  Traffic Throttle Parameters
                </p>
                <div className="flex flex-wrap gap-2 text-xs font-mono font-black">
                  <span className="rounded-md border-2 border-black dark:border-white bg-white dark:bg-neutral-900 px-2.5 py-1 text-black dark:text-white shadow-[2px_2px_0px_#000] dark:shadow-[2px_2px_0px_#fff]">
                    RPM: {data.limits?.requestsPerMinute || "Unlimited"}
                  </span>
                  <span className="rounded-md border-2 border-black dark:border-white bg-white dark:bg-neutral-900 px-2.5 py-1 text-black dark:text-white shadow-[2px_2px_0px_#000] dark:shadow-[2px_2px_0px_#fff]">
                    Concurrency: {data.limits?.concurrency || "Unlimited"}
                  </span>
                  <span className="rounded-md border-2 border-black dark:border-white bg-white dark:bg-neutral-900 px-2.5 py-1 text-black dark:text-white shadow-[2px_2px_0px_#000] dark:shadow-[2px_2px_0px_#fff]">
                    Queue: {data.limits?.queueTimeoutMs ? `${data.limits.queueTimeoutMs}ms` : "60s"}
                  </span>
                </div>
              </div>

              {/* Allowed Models */}
              <div className="mt-4">
                <p className="text-[11px] font-black uppercase tracking-wider text-black dark:text-neutral-200 mb-2">
                  Allowed Models
                </p>
                {data.limits?.allowedModels && data.limits.allowedModels.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {data.limits.allowedModels.map((m) => (
                      <span
                        key={m}
                        className={cn(
                          "rounded-md border-2 border-black dark:border-white px-2 py-0.5 text-xs font-mono font-bold shadow-[2px_2px_0px_#000] dark:shadow-[2px_2px_0px_#fff]",
                          m.includes("*")
                            ? "bg-yellow-400 text-black"
                            : "bg-white dark:bg-neutral-800 text-black dark:text-white"
                        )}
                      >
                        {m}
                      </span>
                    ))}
                  </div>
                ) : (
                  <span className="text-xs font-bold text-neutral-600 dark:text-neutral-400">
                    All models permitted (unrestricted).
                  </span>
                )}
              </div>
            </NeoBox>
          </div>
        ) : null}

        {/* Footer */}
        <div className="text-center text-xs font-bold text-neutral-600 dark:text-neutral-400 pt-2">
          SantaiNetwork 9Router Gateway
        </div>
      </div>
    </div>
  );
}
