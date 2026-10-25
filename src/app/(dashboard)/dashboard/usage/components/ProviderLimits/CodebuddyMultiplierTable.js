"use client";

import { useMemo, useState } from "react";
import { CODEBUDDY_MULTIPLIERS } from "@/shared/constants/codebuddyMultipliers";

// Compact, sortable reference of CodeBuddy/WorkBuddy credit multipliers so an
// operator can see at a glance which models burn credits fastest. Reference
// only: nothing here changes routing or billing.
export default function CodebuddyMultiplierTable() {
  const [sorted, setSorted] = useState(false);

  const rows = useMemo(() => {
    const list = [...CODEBUDDY_MULTIPLIERS];
    return sorted ? list.sort((a, b) => a.multiplier - b.multiplier) : list;
  }, [sorted]);

  return (
    <div className="mt-3 border-t border-black/5 pt-3 dark:border-white/5">
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <div className="flex items-center gap-1.5">
          <span className="material-symbols-outlined text-[15px] text-text-muted">toll</span>
          <span className="text-[11px] font-semibold text-text-primary">
            Credit multiplier (积分倍率)
          </span>
        </div>
        <button
          type="button"
          onClick={() => setSorted((v) => !v)}
          className="rounded-md border border-black/10 px-1.5 py-0.5 text-[10px] text-text-muted transition-colors hover:bg-black/5 hover:text-text-primary dark:border-white/10 dark:hover:bg-white/5"
          title={sorted ? "Show as published order" : "Sort by multiplier (lowest first)"}
        >
          {sorted ? "by model" : "by multiplier"}
        </button>
      </div>
      <div className="max-h-56 overflow-auto rounded-md border border-black/5 dark:border-white/5">
        <table className="w-full text-left text-[11px]">
          <thead className="sticky top-0 bg-surface-2/60 text-text-muted">
            <tr>
              <th className="px-2 py-1 font-medium">Model</th>
              <th className="px-2 py-1 text-right font-medium">Multiplier</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr
                key={m.id}
                className="border-t border-black/5 hover:bg-black/[0.02] dark:border-white/5 dark:hover:bg-white/[0.03]"
              >
                <td className="px-2 py-1 font-mono text-text-primary">{m.label}</td>
                <td
                  className={`px-2 py-1 text-right font-mono font-medium ${
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
      <p className="mt-1.5 px-1 text-[10px] leading-relaxed text-text-muted">
        Credits per request scale with the multiplier. Helps sort cheap vs.
        expensive models.
      </p>
    </div>
  );
}
