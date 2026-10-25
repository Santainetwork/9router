"use client";

import { useMemo, useState } from "react";
import { Card } from "@/shared/components";
import { CODEBUDDY_MULTIPLIERS } from "@/shared/constants/codebuddyMultipliers";

// Reference of CodeBuddy/WorkBuddy credit multipliers (积分倍率) so an operator
// can see at a glance which models burn credits fastest. Reference only:
// nothing here changes routing or billing.
export default function CodebuddyMultiplierCard() {
  const [sorted, setSorted] = useState(true);

  const rows = useMemo(() => {
    const list = [...CODEBUDDY_MULTIPLIERS];
    return sorted ? list.sort((a, b) => a.multiplier - b.multiplier) : list;
  }, [sorted]);

  return (
    <Card>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">Credit Multiplier</h2>
          <p className="mt-0.5 text-xs text-text-muted">
            Credits burned per request per model (积分倍率). Lower is cheaper.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setSorted((v) => !v)}
          className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-text-muted transition-colors hover:bg-black/5 hover:text-text-primary dark:hover:bg-white/5"
          title={sorted ? "Show as published order" : "Sort by multiplier (lowest first)"}
        >
          {sorted ? "Sort: multiplier" : "Sort: published"}
        </button>
      </div>
      <div className="max-h-80 overflow-auto rounded-lg border border-border-subtle">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-surface-2 text-text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Model</th>
              <th className="px-3 py-2 text-right font-medium">Multiplier</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {rows.map((m) => (
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
    </Card>
  );
}
