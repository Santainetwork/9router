// Per-account guard behaviour, run with node:test (no vitest dependency).
// Pure decision logic only: no DB, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideCreditGuard, AUTO_DISABLED_BY } from "../../src/sse/services/codebuddyCreditGuard.js";

const exhausted = { Monthly: { used: 95, total: 100, unlimited: false } };
const healthy = { Monthly: { used: 10, total: 100, unlimited: false } };
const seat = (over = {}) => ({ id: "s1", isActive: true, providerSpecificData: {}, ...over });

test("active seat at or below threshold is disabled", () => {
  assert.equal(decideCreditGuard({ connection: seat(), quotas: exhausted }).action, "disable");
});

test("healthy seat is left alone", () => {
  assert.equal(decideCreditGuard({ connection: seat(), quotas: healthy }).action, "none");
});

test("opted-out seat is never disabled even at 0%", () => {
  const c = seat({ providerSpecificData: { creditGuardOptOut: true } });
  assert.equal(decideCreditGuard({ connection: c, quotas: exhausted }).action, "none");
});

test("guard decides each seat on its own quotas (no cross-account sum)", () => {
  const a = decideCreditGuard({ connection: seat({ id: "a" }), quotas: exhausted });
  const b = decideCreditGuard({ connection: seat({ id: "b" }), quotas: healthy });
  assert.equal(a.action, "disable");
  assert.equal(b.action, "none");
});

test("guard-disabled seat is restored once it recovers", () => {
  const c = seat({ isActive: false, providerSpecificData: { creditGuard: { disabledBy: AUTO_DISABLED_BY } } });
  assert.equal(decideCreditGuard({ connection: c, quotas: healthy }).action, "enable");
});

test("manually disabled seat is never auto-enabled", () => {
  const c = seat({ isActive: false, providerSpecificData: {} });
  assert.equal(decideCreditGuard({ connection: c, quotas: healthy }).action, "none");
});
