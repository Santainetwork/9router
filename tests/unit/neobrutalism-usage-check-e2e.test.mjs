import test from "node:test";
import assert from "node:assert/strict";

const BASE_URL_GATEWAY = "http://localhost:20128";
const BASE_URL_PUBLIC = "http://localhost:20140";
const TEST_API_KEY = "sk-1e48d47cf89b675d-n5h2n3-4a0fba81"; // adita

test("Public proxy (:20140) serves Neobrutalist usage-check HTML with concrete design tokens", async () => {
  const res = await fetch(`${BASE_URL_PUBLIC}/usage-check`);
  assert.equal(res.status, 200);
  const html = await res.text();

  // Assert Neobrutalism tokens in CSS/HTML
  assert.ok(html.includes("border: 2px solid var(--border)"), "must have 2px solid borders");
  assert.ok(html.includes("box-shadow: 4px 4px 0 var(--shadow)"), "must have 4px 4px 0 hard offset shadow");
  assert.ok(html.includes("badge-yellow"), "must have yellow neobrutalist badge");
  assert.ok(html.includes("badge-cyan"), "must have cyan neobrutalist badge");
  assert.ok(html.includes("Live Concurrency Tracker"), "must render live concurrency tracker");
  assert.ok(html.includes("Traffic Throttle Parameters"), "must render traffic throttle parameters");

  // Assert Token Breakdown by Model is removed per user request
  assert.ok(!html.includes("Token Breakdown by Model"), "Token Breakdown by Model must be removed");
});

test("Next.js App Router (:20128) renders /usage-check route successfully", async () => {
  const res = await fetch(`${BASE_URL_GATEWAY}/usage-check`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("Usage") || html.includes("usage-check"), "must serve usage-check page");
});

test("/api/v1/usage returns accurate concurrency and allowedModels for API key", async () => {
  const res = await fetch(`${BASE_URL_GATEWAY}/api/v1/usage?period=7d`, {
    headers: { Authorization: `Bearer ${TEST_API_KEY}` }
  });
  assert.equal(res.status, 200);
  const data = await res.json();

  // Concurrency check
  assert.equal(typeof data.limits.concurrency, "number", "concurrency must be number");
  assert.equal(data.limits.concurrency, 5, "adita key concurrency matches database value 5");
  assert.ok(data.live, "response must include live concurrency data");
  assert.equal(typeof data.live.activeConcurrency, "number", "live.activeConcurrency must be number");
  assert.equal(typeof data.live.queuedRequests, "number", "live.queuedRequests must be number");

  // Fast path /api/v1/usage?live=1 check
  const tStart = Date.now();
  const liveRes = await fetch(`${BASE_URL_GATEWAY}/api/v1/usage?live=1`, {
    headers: { Authorization: `Bearer ${TEST_API_KEY}` }
  });
  const tElapsed = Date.now() - tStart;
  assert.equal(liveRes.status, 200);
  assert.ok(tElapsed < 500, `fast path should respond promptly (took ${tElapsed}ms)`);
  const liveData = await liveRes.json();
  assert.ok(liveData.live, "fast path must return live object");
  assert.equal(typeof liveData.live.activeConcurrency, "number");
  assert.equal(typeof liveData.live.queuedRequests, "number");
  assert.equal(typeof liveData.live.requestsInWindow, "number");
  assert.ok(typeof liveData.live.updatedAt === "string", "updatedAt must be string");
  assert.ok(!isNaN(Date.parse(liveData.live.updatedAt)), "updatedAt must parse as valid timestamp");

  // Allowed models check
  const allowed = data.access?.allowedModels || data.limits?.allowedModels;
  assert.ok(Array.isArray(allowed), "allowedModels must be array");
  assert.ok(allowed.includes("hx/*"), "allowedModels must contain hx/* wildcard");
});
