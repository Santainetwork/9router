// CodeBuddy credit guard sweep — periodic, DB-aware wrapper around the pure
// decision logic in codebuddyCreditGuard.js.
//
// Runs on its own interval (not the OAuth token-refresh tick, which only sees
// OAuth connections; CodeBuddy seats here are apikey connections). Each tick:
//   1. load active CodeBuddy connections
//   2. fetch each one's usage
//   3. apply decideCreditGuard() and, when it says so, flip isActive
//
// Fail-open: a tick error or a single connection's fetch error never kills the
// interval, and never disables an account on bad data.

import * as log from "../utils/logger.js";
import { getProviderConnections, updateProviderConnection, getSettings } from "../../lib/localDb.js";
import { getUsageForProvider } from "../../../open-sse/services/usage.js";
import { resolveConnectionProxyConfig } from "../../lib/network/connectionProxy.js";
import { decideCreditGuard, AUTO_DISABLED_BY, CREDIT_GUARD_THRESHOLD, thresholdFromPercent } from "./codebuddyCreditGuard.js";

export const CODEBUDDY_PROVIDERS = new Set(["codebuddy-intl", "codebuddy-cn"]);

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const INITIAL_DELAY_MS = 30 * 1000;

const g = (global.__codebuddyCreditGuard ??= {
  interval: null,
  initial: null,
  running: false,
});

function buildProxyOptions(cfg) {
  return {
    connectionProxyEnabled: cfg.connectionProxyEnabled === true,
    connectionProxyUrl: cfg.connectionProxyUrl || "",
    connectionNoProxy: cfg.connectionNoProxy || "",
    vercelRelayUrl: cfg.vercelRelayUrl || "",
    strictProxy: false,
  };
}

/**
 * Apply the guard to one connection. Returns the decision, and performs the DB
 * write when one is needed. Never throws for a single account.
 * @param {object} connection
 * @param {{ threshold?: number, getUsage?: Function, resolveProxy?: Function, update?: Function }} deps
 */
export async function applyCreditGuardToConnection(connection, deps = {}) {
  const getUsage = deps.getUsage || ((conn, proxyOptions) => getUsageForProvider(conn, proxyOptions));
  const resolveProxy = deps.resolveProxy || resolveConnectionProxyConfig;
  const update = deps.update || updateProviderConnection;
  const threshold = deps.threshold ?? CREDIT_GUARD_THRESHOLD;

  const proxyCfg = await resolveProxy(connection.providerSpecificData || {});
  const proxyOptions = buildProxyOptions(proxyCfg);
  const usage = await getUsage(connection, proxyOptions);

  const decision = decideCreditGuard({ connection, quotas: usage?.quotas, threshold });
  if (decision.action === "none") return decision;

  const label = connection.email || connection.name || connection.id;
  const at = new Date().toISOString();

  if (decision.action === "disable") {
    await update(connection.id, {
      isActive: false,
      providerSpecificData: {
        ...(connection.providerSpecificData || {}),
        creditGuard: { disabledBy: AUTO_DISABLED_BY, reason: decision.reason, at },
      },
      updatedAt: at,
    });
    log.warn("CREDIT_GUARD", `disabled ${connection.provider}:${label} — ${decision.reason}`);
  } else if (decision.action === "enable") {
    const next = { ...(connection.providerSpecificData || {}) };
    delete next.creditGuard;
    await update(connection.id, {
      isActive: true,
      providerSpecificData: next,
      updatedAt: at,
    });
    log.info("CREDIT_GUARD", `re-enabled ${connection.provider}:${label} — ${decision.reason}`);
  }
  return decision;
}

/**
 * One sweep tick. Fail-open.
 * @param {{ getConnections?: Function, threshold?: number } & object} [deps]
 */
export async function runCodebuddyCreditGuardTick(deps = {}) {
  if (g.running) return;
  g.running = true;
  try {
    const getConnections = deps.getConnections || ((filter) => getProviderConnections(filter));
    // Read the dashboard settings each tick, so a changed threshold or a disabled
    // guard takes effect without a restart.
    const settings = deps.getSettings ? await deps.getSettings() : await getSettings();
    const guardCfg = settings?.codebuddyCreditGuard || {};
    if (guardCfg.enabled === false) return;
    const threshold = deps.threshold ?? thresholdFromPercent(guardCfg.thresholdPercent);
    for (const provider of CODEBUDDY_PROVIDERS) {
      let conns = [];
      try {
        conns = await getConnections({ provider, isActive: true });
      } catch (e) {
        log.warn("CREDIT_GUARD", `load ${provider} failed (swallowed): ${e.message}`);
        continue;
      }
      for (const conn of conns) {
        // Per-seat opt-out is decided inside decideCreditGuard (it never disables an opted-out seat).
        try {
          await applyCreditGuardToConnection(conn, { ...deps, threshold });
        } catch (e) {
          log.warn("CREDIT_GUARD", `${provider}:${conn.id} sweep failed (swallowed): ${e.message}`);
        }
      }
    }
  } catch (e) {
    log.warn("CREDIT_GUARD", `tick error (swallowed): ${e.message}`);
  } finally {
    g.running = false;
  }
}

function isNonServerRuntime() {
  if (typeof window !== "undefined") return true;
  if (process.env.NEXT_RUNTIME === "edge") return true;
  const phase = process.env.NEXT_PHASE || "";
  return phase === "phase-production-build" || phase === "phase-export" || phase === "phase-static";
}

function isTruthyEnv(value) {
  if (value == null || value === "") return false;
  const v = String(value).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function startCodebuddyCreditGuard({ intervalMs } = {}) {
  if (g.interval) return false;
  if (isNonServerRuntime()) return false;
  if (isTruthyEnv(process.env.DISABLE_CODEBUDDY_CREDIT_GUARD)) return false;

  const period = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_INTERVAL_MS;
  const safeTick = () => {
    runCodebuddyCreditGuardTick().catch((e) => log.warn("CREDIT_GUARD", `unhandled tick rejection: ${e.message}`));
  };

  g.initial = setTimeout(safeTick, INITIAL_DELAY_MS);
  if (g.initial.unref) g.initial.unref();
  g.interval = setInterval(safeTick, period);
  if (g.interval.unref) g.interval.unref();
  console.log("[CreditGuard] scheduler started");
  return true;
}

export function stopCodebuddyCreditGuard() {
  if (g.initial) { clearTimeout(g.initial); g.initial = null; }
  if (g.interval) { clearInterval(g.interval); g.interval = null; }
}

export function resetCodebuddyCreditGuardState() {
  g.running = false;
}
