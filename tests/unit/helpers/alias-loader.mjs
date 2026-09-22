// Node module-resolution hooks for unit tests that need to import product
// modules using the Next/jsconfig path aliases (`@/*`, `open-sse/*`) plus a few
// virtual stubs so the modules load without a full Next runtime or a database.
//
// Register from a test with:
//   import { register } from "node:module";
//   register(new URL("./helpers/alias-loader.mjs", import.meta.url));
//
// Two stubs are controlled through globalThis so tests can vary behavior:
//   globalThis.__TEST_LIMITS__        value returned by getApiKeyLimits()
//   globalThis.__TEST_ACQUIRE_ERROR__ error thrown by the limiter's acquire()

const ROOT = new URL("../../../", import.meta.url);

const VIRTUALS = {
  "@/lib/localDb": `
    export async function getSettings() { return globalThis.__TEST_SETTINGS__ ?? null; }
    export async function validateApiKey() { return globalThis.__TEST_API_KEY_VALID__ ?? false; }
    export async function getApiKeyLimits() { return globalThis.__TEST_LIMITS__ ?? null; }
    export async function getApiKeyTokenUsage() { return globalThis.__TEST_TOKEN_USAGE__ ?? 0; }
  `,
  "@/shared/utils/machineId": `
    export async function getConsistentMachineId() { return globalThis.__TEST_MACHINE_ID__ ?? "test-machine-id"; }
  `,
  "@/lib/auth/dashboardSession": `
    export async function verifyDashboardAuthToken() { return globalThis.__TEST_DASHBOARD_AUTH__ ?? false; }
  `,
  "@/lib/auth/trustedPeer": `
    export function hasTrustedPeerHeaders(request) {
      const token = process.env.NINEROUTER_PEER_TOKEN;
      return Boolean(token) && request.headers.get("x-9r-peer-token") === token;
    }
  `,
  "open-sse/services/rateLimiter.js": `
    export class RateLimitTimeoutError extends Error {
      constructor(message, retryAfter = 1) {
        super(message);
        this.name = "RateLimitTimeoutError";
        this.retryAfter = retryAfter;
      }
    }
    export async function acquire() {
      throw globalThis.__TEST_ACQUIRE_ERROR__ ?? new Error("__TEST_ACQUIRE_ERROR__ unset");
    }
  `,
};

export async function resolve(specifier, context, nextResolve) {
  if (specifier in VIRTUALS) {
    return { url: `virtual:${specifier}`, shortCircuit: true };
  }
  if (specifier.startsWith("@/")) {
    return nextResolve(new URL(`src/${specifier.slice(2)}`, ROOT).href, context);
  }
  // Next's exports map has no "./server" entry, so plain node cannot resolve
  // the bare specifier that app routes use.
  if (specifier === "next/server") {
    return nextResolve(new URL("node_modules/next/server.js", ROOT).href, context);
  }
  if (specifier === "open-sse") {
    return nextResolve(new URL("open-sse/index.js", ROOT).href, context);
  }
  if (specifier.startsWith("open-sse/")) {
    return nextResolve(new URL(specifier, ROOT).href, context);
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith("virtual:")) {
    const specifier = url.slice("virtual:".length);
    return { format: "module", shortCircuit: true, source: VIRTUALS[specifier] };
  }
  return nextLoad(url, context);
}
