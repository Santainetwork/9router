// Go hybrid engine topology/configuration. Shared by the limiter client, the
// admin System Health panel, and tests so ports and URLs have one source.

function envInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envFlag(value) {
  return String(value ?? "").toLowerCase() === "true";
}

// True when this process is a horizontally-scaled API worker. Such workers
// must not fall back to a per-process JS limiter: concurrency accounting would
// diverge across replicas. Mirrors src/lib/db/driver.js#isApiWorker.
export function isApiWorkerRole(env = process.env) {
  const role = env.WORKER_ROLE || env.NINEROUTER_WORKER_ROLE || "control";
  return String(role).toLowerCase() === "api";
}

export function getEngineConfig(env = process.env) {
  const limiterPort = envInt(env.GO_ENGINE_PORT, 20129);
  const gatewayPort = envInt(env.GO_GATEWAY_PORT, 20128);
  const publicProxyPort = envInt(env.GO_PROXY_PORT, 20140);
  const publicProxyEnabled = envFlag(env.ENABLE_PUBLIC_PROXY) || publicProxyPort > 0;
  const masterGateway = envFlag(env.ENABLE_MASTER_GATEWAY) || gatewayPort > 0;
  const limiterUrl = env.GO_ENGINE_URL || `http://127.0.0.1:${limiterPort}`;

  // Public, externally reachable URLs (used by the endpoint page / tunnels).
  const publicBase = env.PUBLIC_BASE_URL ? env.PUBLIC_BASE_URL.replace(/\/$/, "") : null;

  return {
    enabled: envFlag(env.ENABLE_GO_HYBRID),
    limiterPort,
    limiterUrl,
    gatewayPort,
    gatewayUrl: `http://127.0.0.1:${gatewayPort}`,
    masterGateway,
    publicProxyPort,
    publicProxyEnabled,
    publicProxyUrl: `http://127.0.0.1:${publicProxyPort}`,
    gatewayUrls: {
      internal: `http://127.0.0.1:${originHostPort(env, gatewayPort)}`,
      publicProxy: publicProxyEnabled ? `http://127.0.0.1:${publicProxyPort}` : null,
      external: publicBase,
    },
    scope: env.GO_ENGINE_SCOPE || "apikey",
    proxyConcurrency: envInt(env.GO_PROXY_CONCURRENCY, 0),
    proxyRpm: envInt(env.GO_PROXY_RPM, 0),
    queueTimeoutSec: envInt(env.GO_PROXY_TIMEOUT, 60),
  };
}

function originHostPort(env, fallbackPort) {
  const url = env.APP_BASE_URL || env.UPSTREAM_URL;
  if (!url) return fallbackPort;
  try {
    return new URL(url).port || fallbackPort;
  } catch {
    return fallbackPort;
  }
}
