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
    export async function getApiKeyLimits() { return globalThis.__TEST_LIMITS__ ?? null; }
    export async function getApiKeyTokenUsage() { return globalThis.__TEST_TOKEN_USAGE__ ?? 0; }
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