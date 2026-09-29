// Task 6: worker eligibility enforcement. In SQLite multicore, reject an
// unknown/stateful provider before auth selection or dispatch with a typed
// fail-closed signal the gateway can route back to control. Single-process and
// Postgres are unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const CHAT_HANDLER_SOURCE = readFileSync(new URL("../../src/sse/handlers/chat.js", import.meta.url), "utf8");

const {
  isProviderWorkerSafe,
  assertProviderWorkerSafe,
  ProviderNotWorkerSafeError,
  ELIGIBILITY_ERROR,
} = await import("../../src/lib/db/providerEligibility.js");

test("assertProviderWorkerSafe allows stateless allowlisted providers in worker mode", () => {
  for (const provider of ["openai", "anthropic", "claude", "google", "gemini"]) {
    assert.doesNotThrow(() => assertProviderWorkerSafe(provider, { isWorker: () => true }));
  }
});

test("assertProviderWorkerSafe rejects unknown and stateful providers with a typed signal", () => {
  for (const provider of ["perplexity-web", "xiaomi-mimo", "opencode", "some-unknown-provider", null, undefined]) {
    try {
      assertProviderWorkerSafe(provider, { isWorker: () => true });
      assert.fail(`expected ${provider} to be rejected`);
    } catch (error) {
      assert.ok(error instanceof ProviderNotWorkerSafeError);
      assert.equal(error.code, ELIGIBILITY_ERROR);
    }
  }
});

test("assertProviderWorkerSafe is a no-op outside worker mode (single-process/Postgres)", () => {
  assert.doesNotThrow(() => assertProviderWorkerSafe("perplexity-web", { isWorker: () => false }));
  assert.doesNotThrow(() => assertProviderWorkerSafe("some-unknown-provider", { isWorker: () => false }));
});

test("worker refusal response exposes a typed internal header without leaking provider names", async () => {
  const { providerNotWorkerSafeResponse } = await import("../../src/lib/db/providerEligibility.js");
  const response = providerNotWorkerSafeResponse(new ProviderNotWorkerSafeError("perplexity-web"));
  assert.equal(response.status, 409);
  assert.equal(response.headers.get("x-9router-worker-refusal"), ELIGIBILITY_ERROR);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.error.code, ELIGIBILITY_ERROR);
  assert.equal(JSON.stringify(body).includes("perplexity-web"), false);
});

test("worker refusal helper ignores unrelated errors", async () => {
  const { providerNotWorkerSafeResponse } = await import("../../src/lib/db/providerEligibility.js");
  assert.equal(providerNotWorkerSafeResponse(new Error("boom")), null);
});

test("chat HTTP boundary converts provider refusal before generic exception handling", () => {
  assert.match(CHAT_HANDLER_SOURCE, /providerNotWorkerSafeResponse\(err\)/);
  assert.match(CHAT_HANDLER_SOURCE, /const refusal = providerNotWorkerSafeResponse\(err\);[\s\S]*if \(refusal\) \{[\s\S]*log\.warn\("CHAT", "worker refusal[\s\S]*return refusal;[\s\S]*\}/);
});

test("isProviderWorkerSafe is strict: only explicit allowlist entries pass", () => {
  assert.equal(isProviderWorkerSafe("openai"), true);
  assert.equal(isProviderWorkerSafe("openai-web"), false);
  assert.equal(isProviderWorkerSafe(""), false);
  assert.equal(isProviderWorkerSafe(undefined), false);
});
