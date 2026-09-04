"use client";

import { useState } from "react";

// Public self-service usage-check page. A friend pastes THEIR OWN API key and
// sees only that key's limits + usage. Styled in vibrant Neobrutalism.
// Calls GET /api/v1/usage.

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

function NeoCard({ children, className = "", bg = "bg-white dark:bg-neutral-900" }) {
  return (
    <div
      className={`border-2 border-black dark:border-white/90 shadow-[4px_4px_0px_0px_#000] dark:shadow-[4px_4px_0px_0px_#fff] p-5 rounded-xl ${bg} ${className}`}
    >
      {children}
    </div>
  );
}

function NeoStat({ label, value, sub, bg = "bg-white dark:bg-neutral-800" }) {
  return (
    <div
      className={`border-2 border-black dark:border-white/80 shadow-[3px_3px_0px_0px_#000] dark:shadow-[3px_3px_0px_0px_#fff] p-3.5 rounded-lg ${bg} flex flex-col justify-between`}
    >
      <span className="text-[11px] font-black uppercase tracking-wider text-black dark:text-neutral-200">
        {label}
      </span>
      <div className="mt-2">
        <p className="text-2xl font-black tabular-nums tracking-tight text-black dark:text-white">
          {value}
        </p>
        {sub ? (
          <p className="mt-0.5 text-[11px] font-bold text-neutral-700 dark:text-neutral-300">{sub}</p>
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
    <div className="min-h-screen bg-[#FDFBF7] dark:bg-[#121212] text-black dark:text-white px-4 py-12 selection:bg-yellow-400 selection:text-black">
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        
        {/* Header Section */}
        <div className="flex flex-col gap-2">
          <div className="inline-flex items-center gap-2 self-start">
            <span className="border-2 border-black dark:border-white bg-yellow-400 text-black px-2.5 py-0.5 text-xs font-black uppercase tracking-wider rounded-md shadow-[2px_2px_0px_0px_#000] dark:shadow-[2px_2px_0px_0px_#fff]">
              9ROUTER GATEWAY
            </span>
            <span className="border-2 border-black dark:border-white bg-cyan-400 text-black px-2 py-0.5 text-[11px] font-bold uppercase rounded-md shadow-[2px_2px_0px_0px_#000] dark:shadow-[2px_2px_0px_0px_#fff]">
              SELF SERVICE
            </span>
          </div>

          <h1 className="text-3xl sm:text-4xl font-black uppercase tracking-tight text-black dark:text-white mt-1">
            Usage & Quota Check
          </h1>
          <p className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">
            Paste your API key below to inspect real-time quotas, token usage, and allowed models.
          </p>
          <p className="text-[11px] font-bold text-neutral-500 uppercase tracking-widest">
            Modified by SantaiNetwork
          </p>
        </div>

        {/* Input Card */}
        <NeoCard bg="bg-white dark:bg-neutral-900">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-black uppercase tracking-wide text-neutral-800 dark:text-neutral-200">
                Your API Key
              </label>
              <div className="relative">
                <input
                  type="password"
                  placeholder="sk-9r-..."
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && check()}
                  aria-label="API key"
                  className="w-full rounded-lg border-2 border-black dark:border-white/80 bg-neutral-50 dark:bg-neutral-800 px-3.5 py-2.5 text-sm font-mono font-bold text-black dark:text-white placeholder:text-neutral-400 focus:outline-none focus:bg-yellow-50 dark:focus:bg-neutral-800/80 shadow-[3px_3px_0px_0px_#000] dark:shadow-[3px_3px_0px_0px_#fff] transition-all"
                />
              </div>
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
                    className={`px-3 py-1 text-xs font-black rounded-md border-2 border-black dark:border-white transition-all ${
                      days === p.d
                        ? "bg-cyan-400 text-black shadow-[2px_2px_0px_0px_#000] dark:shadow-[2px_2px_0px_0px_#fff] translate-x-[-1px] translate-y-[-1px]"
                        : "bg-white dark:bg-neutral-800 text-black dark:text-white hover:bg-neutral-100"
                    }`}
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
                className="inline-flex items-center justify-center gap-2 rounded-lg border-2 border-black dark:border-white bg-yellow-400 hover:bg-yellow-300 text-black font-black uppercase text-xs px-5 py-2.5 shadow-[3px_3px_0px_0px_#000] dark:shadow-[3px_3px_0px_0px_#fff] hover:translate-x-[-1px] hover:translate-y-[-1px] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? (
                  <>
                    <span className="inline-block animate-spin">⌛</span> Checking...
                  </>
                ) : (
                  <>🔍 Check Usage</>
                )}
              </button>
            </div>

            {error ? (
              <div className="rounded-lg border-2 border-black dark:border-red-400 bg-red-400 text-black p-3 text-xs font-bold shadow-[3px_3px_0px_0px_#000] dark:shadow-[3px_3px_0px_0px_#fff]">
                ⚠️ {error}
              </div>
            ) : null}
          </div>
        </NeoCard>

        {/* Results Section */}
        {data ? (
          <div className="flex flex-col gap-6">
            
            {/* Key Information & Metrics Card */}
            <NeoCard bg="bg-white dark:bg-neutral-900">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b-2 border-black dark:border-white/30 pb-3">
                <div className="flex items-center gap-2">
                  <span className="inline-block h-3 w-3 rounded-full bg-emerald-400 border border-black" />
                  <span className="text-sm font-black uppercase tracking-wide text-black dark:text-white">
                    {data.key?.name || "Verified API Key"}
                  </span>
                </div>
                <span className="border-2 border-black dark:border-white bg-lime-400 text-black px-2 py-0.5 text-[11px] font-black uppercase rounded shadow-[2px_2px_0px_0px_#000]">
                  Period: Last {data.usage.period.days} Days
                </span>
              </div>

              {/* Grid 4 Stats */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <NeoStat
                  label="Rate Limit (RPM)"
                  value={data.limits.requestsPerMinute > 0 ? data.limits.requestsPerMinute : "∞"}
                  sub={data.limits.requestsPerMinute > 0 ? "Requests / min" : "Unlimited RPM"}
                  bg="bg-yellow-200 dark:bg-yellow-950/40"
                />
                <NeoStat
                  label="Requests"
                  value={fmt(data.usage.requests)}
                  sub={`in ${data.usage.period.days}d window`}
                  bg="bg-cyan-200 dark:bg-cyan-950/40"
                />
                <NeoStat
                  label="Tokens"
                  value={fmt(data.usage.totalTokens)}
                  sub={`in ${data.usage.period.days}d window`}
                  bg="bg-purple-200 dark:bg-purple-950/40"
                />
                <NeoStat
                  label="Token Quota"
                  value={quota > 0 ? fmt(quota) : "∞"}
                  sub={quota > 0 ? `${fmt(remaining)} left` : "Unlimited token cap"}
                  bg="bg-lime-200 dark:bg-lime-950/40"
                />
              </div>

              {/* Quota Progress Bar */}
              {quota > 0 ? (
                <div className="mt-5 pt-4 border-t-2 border-black dark:border-white/20">
                  <div className="flex justify-between items-center text-xs font-black uppercase mb-1.5">
                    <span>Quota Exhaustion</span>
                    <span className="tabular-nums">{pct}%</span>
                  </div>
                  <div className="h-5 w-full overflow-hidden rounded-md border-2 border-black dark:border-white bg-neutral-200 dark:bg-neutral-800 shadow-[2px_2px_0px_0px_#000]">
                    <div
                      className={`h-full border-r-2 border-black transition-all ${
                        pct >= 100
                          ? "bg-red-500"
                          : pct >= 80
                          ? "bg-amber-400"
                          : "bg-emerald-400"
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <p className="mt-2 text-xs font-bold text-neutral-600 dark:text-neutral-400">
                    {fmt(used)} / {fmt(quota)} tokens consumed all-time.
                  </p>
                </div>
              ) : null}
            </NeoCard>

            {/* Allowed Models Card */}
            <NeoCard bg="bg-white dark:bg-neutral-900">
              <div className="flex items-center justify-between mb-3 border-b-2 border-black dark:border-white/30 pb-2">
                <h3 className="text-xs font-black uppercase tracking-wider text-black dark:text-white">
                  Available Model Access
                </h3>
                <span className="text-[10px] font-black uppercase bg-neutral-100 dark:bg-neutral-800 border border-black dark:border-white px-2 py-0.5 rounded">
                  {data.access.restricted ? `${data.access.allowedModels.length} Models` : "Unrestricted"}
                </span>
              </div>

              {data.access.restricted ? (
                <div className="flex flex-wrap gap-2 pt-1">
                  {data.access.allowedModels.map((m) => (
                    <span
                      key={m}
                      className="rounded-md border-2 border-black dark:border-white bg-yellow-100 dark:bg-yellow-900/40 text-black dark:text-yellow-200 px-2.5 py-1 text-xs font-mono font-bold shadow-[2px_2px_0px_0px_#000] dark:shadow-[2px_2px_0px_0px_#fff]"
                    >
                      {m}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="flex items-center gap-2 p-3 bg-emerald-100 dark:bg-emerald-950/40 border-2 border-black dark:border-emerald-500/50 rounded-lg text-xs font-bold text-emerald-900 dark:text-emerald-300">
                  <span className="text-base">✅</span>
                  <span>Full access granted: All gateway models are available for this key.</span>
                </div>
              )}
            </NeoCard>

            {/* Breakdown by Model */}
            {models.length > 0 ? (
              <NeoCard bg="bg-white dark:bg-neutral-900">
                <div className="flex items-center justify-between mb-3 border-b-2 border-black dark:border-white/30 pb-2">
                  <h3 className="text-xs font-black uppercase tracking-wider text-black dark:text-white">
                    Usage by Model (Last {data.usage.period.days} Days)
                  </h3>
                  <span className="text-[10px] font-black uppercase bg-neutral-100 dark:bg-neutral-800 border border-black dark:border-white px-2 py-0.5 rounded">
                    {models.length} active
                  </span>
                </div>

                <div className="flex flex-col gap-2 pt-1">
                  {models
                    .sort(
                      (a, b) =>
                        b[1].promptTokens +
                        b[1].completionTokens -
                        (a[1].promptTokens + a[1].completionTokens)
                    )
                    .map(([m, v]) => (
                      <div
                        key={m}
                        className="flex items-center justify-between gap-3 p-2.5 rounded-lg border-2 border-black dark:border-white/60 bg-neutral-50 dark:bg-neutral-800/80 shadow-[2px_2px_0px_0px_#000] dark:shadow-[2px_2px_0px_0px_#fff]"
                      >
                        <span className="truncate font-mono text-xs font-bold text-black dark:text-white">
                          {m}
                        </span>
                        <div className="shrink-0 flex items-center gap-2">
                          <span className="border border-black dark:border-white/60 bg-cyan-300 dark:bg-cyan-900 text-black dark:text-cyan-200 px-1.5 py-0.5 rounded text-[11px] font-black font-mono">
                            {fmt(v.requests)} req
                          </span>
                          <span className="border border-black dark:border-white/60 bg-purple-300 dark:bg-purple-900 text-black dark:text-purple-200 px-1.5 py-0.5 rounded text-[11px] font-black font-mono">
                            {fmt(v.promptTokens + v.completionTokens)} tok
                          </span>
                        </div>
                      </div>
                    ))}
                </div>
              </NeoCard>
            ) : null}
          </div>
        ) : null}

        {/* Footer */}
        <div className="text-center pt-6 text-xs font-bold text-neutral-500 uppercase tracking-widest">
          Powered by 9Router · SantaiNetwork Infrastructure
        </div>

      </div>
    </div>
  );
}
