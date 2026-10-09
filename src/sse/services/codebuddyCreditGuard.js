// CodeBuddy credit guard: pure decision logic (no I/O).
//
// CodeBuddy accounts draw from several packages (a recurring "Monthly" refill
// plus one-shot "Bonus Pack N" credits). When the total remaining balance across
// those packages falls to THRESHOLD of the total, the account is taken out of
// rotation so it does not run dry mid-request. Restoring it is only done for
// accounts this guard disabled itself; a manual disable is never overridden.

export const CREDIT_GUARD_THRESHOLD = 0.1;
export const AUTO_DISABLED_BY = "creditGuard";

// Settings store the threshold as a whole percent. Clamp to a sane band so a
// mistyped value cannot disable every seat (100) or none at all (0 means never).
export const CREDIT_GUARD_MIN_PERCENT = 1;
export const CREDIT_GUARD_MAX_PERCENT = 90;
export function thresholdFromPercent(percent) {
  const n = Number(percent);
  if (percent === null || percent === undefined || percent === "" || !Number.isFinite(n)) return CREDIT_GUARD_THRESHOLD;
  const clamped = Math.min(CREDIT_GUARD_MAX_PERCENT, Math.max(CREDIT_GUARD_MIN_PERCENT, n));
  return clamped / 100;
}

// Number(null) is 0, so a missing usage value would read as "fully unused" and
// hide consumption. Only real numbers (or numeric strings) count.
function finite(n) {
  if (n === null || n === undefined || n === "" || typeof n === "boolean") return null;
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}

/**
 * Remaining credits across all packages.
 * @param {Record<string, {used?: number, total?: number, unlimited?: boolean}>} quotas
 * @returns {{ remaining: number, total: number, ratio: number, unlimited: boolean, packages: number } | null}
 *   null when no usable package exists (the guard must then do nothing).
 */
export function summarizeCredits(quotas) {
  const entries = Object.values(quotas || {});
  let total = 0;
  let remaining = 0;
  let packages = 0;
  for (const q of entries) {
    if (!q) continue;
    if (q.unlimited === true) return { remaining: Infinity, total: Infinity, ratio: 1, unlimited: true, packages: entries.length };
    const t = finite(q.total);
    const u = finite(q.used);
    if (t === null || t <= 0 || u === null) continue;
    total += t;
    remaining += Math.max(0, t - u);
    packages += 1;
  }
  if (packages === 0) return null;
  return { remaining, total, ratio: remaining / total, unlimited: false, packages };
}

/**
 * Decide what to do with one connection.
 * @param {object} args
 * @param {object} args.connection  current connection (isActive, providerSpecificData)
 * @param {object} args.quotas      usage quotas from the CodeBuddy usage handler
 * @param {number} [args.threshold] fraction of total at or below which to disable
 * @returns {{ action: "disable"|"enable"|"none", reason: string, summary: object|null }}
 */
export function decideCreditGuard({ connection, quotas, threshold = CREDIT_GUARD_THRESHOLD }) {
  // Per-account opt-out (set from the dashboard): the guard must leave this seat alone.
  // A guard-disabled seat that was opted out mid-way is restored, so the account does
  // not stay stuck off with a marker the user no longer wants.
  if (connection?.providerSpecificData?.creditGuardOptOut === true) {
    const optedOut = connection.providerSpecificData?.creditGuard?.disabledBy === AUTO_DISABLED_BY;
    return optedOut && connection.isActive === false
      ? { action: "enable", reason: "credit guard opted out for this seat", summary: null }
      : { action: "none", reason: "credit guard opted out for this seat", summary: null };
  }

  const summary = summarizeCredits(quotas);
  const guard = connection?.providerSpecificData?.creditGuard || null;
  const autoDisabled = guard?.disabledBy === AUTO_DISABLED_BY;

  if (!summary) return { action: "none", reason: "no usable credit package", summary };
  if (summary.unlimited) {
    // Unlimited plan: never disable. If the guard disabled this account earlier, restore it.
    return autoDisabled && connection.isActive === false
      ? { action: "enable", reason: "plan is unlimited", summary }
      : { action: "none", reason: "unlimited plan", summary };
  }

  const low = summary.ratio <= threshold;
  if (low) {
    // Only disable accounts that are currently active. A manual disable (isActive=false
    // without our marker) stays untouched, and we never double-disable.
    if (connection.isActive === false) return { action: "none", reason: "already inactive", summary };
    return { action: "disable", reason: `remaining ${(summary.ratio * 100).toFixed(1)}% <= ${(threshold * 100).toFixed(0)}%`, summary };
  }

  // Recovered above the threshold: re-enable only what this guard disabled.
  if (autoDisabled && connection.isActive === false) {
    return { action: "enable", reason: `remaining ${(summary.ratio * 100).toFixed(1)}% recovered`, summary };
  }
  return { action: "none", reason: "above threshold", summary };
}
