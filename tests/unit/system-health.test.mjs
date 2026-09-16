import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

// The collector imports "@/..." aliases + open-sse, so load the engine config
// util standalone (no aliases) and assert the collector/route wiring by source.
function loadUtil(relPath) {
  const src = readFileSync(join(root, relPath), "utf8");
  const module = { exports: {} };
  vm.runInNewContext(src.replace(/^export function (\w+)/gm, "function $1") + "\nmodule.exports = { getEngineConfig };", {
    module,
    exports: module.exports,
    process,
    URL,
    console,
    Number,
    String,
  });
  return module.exports;
}

const { getEngineConfig } = loadUtil("src/shared/utils/engineConfig.js");

test("engineConfig exposes gateway, limiter and public proxy ports", () => {
  const cfg = getEngineConfig({ ENABLE_GO_HYBRID: "true" });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.limiterPort, 20129);
  assert.equal(cfg.limiterUrl, "http://127.0.0.1:20129");
  assert.equal(cfg.gatewayPort, 20128);
  assert.equal(cfg.publicProxyPort, 20140);
  assert.equal(cfg.masterGateway, true);
  assert.equal(cfg.publicProxyEnabled, true);
  assert.equal(cfg.gatewayUrls.publicProxy, "http://127.0.0.1:20140");
});

test("engineConfig honours explicit env overrides", () => {
  const cfg = getEngineConfig({
    ENABLE_GO_HYBRID: "false",
    GO_ENGINE_URL: "http://10.0.0.5:2999",
    GO_ENGINE_PORT: "2999",
    GO_GATEWAY_PORT: "18080",
    GO_PROXY_PORT: "0",
    ENABLE_PUBLIC_PROXY: "false",
    PUBLIC_BASE_URL: "https://gw.example.com/",
    GO_ENGINE_SCOPE: "provider",
    GO_PROXY_CONCURRENCY: "12",
    GO_PROXY_RPM: "600",
    GO_PROXY_TIMEOUT: "30",
  });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.limiterUrl, "http://10.0.0.5:2999");
  assert.equal(cfg.gatewayPort, 18080);
  assert.equal(cfg.publicProxyEnabled, false);
  assert.equal(cfg.gatewayUrls.publicProxy, null);
  assert.equal(cfg.gatewayUrls.external, "https://gw.example.com");
  assert.equal(cfg.scope, "provider");
  assert.equal(cfg.proxyConcurrency, 12);
  assert.equal(cfg.proxyRpm, 600);
  assert.equal(cfg.queueTimeoutSec, 30);
});

test("health route keeps the public liveness shape and adds detail mode", () => {
  const src = readFileSync(join(root, "src/app/api/health/route.js"), "utf8");
  assert.match(src, /collectSystemHealth/);
  assert.match(src, /searchParams\.get\("detail"\) === "1"/);
  assert.match(src, /ok: true/);
  // Public payload must never leak process RSS/pid or DB credentials unmasked.
  assert.match(src, /detail\) Object\.assign\(body, health\)/);
});

test("system health collector reports engine, backend, limiter and database", () => {
  const src = readFileSync(join(root, "src/shared/utils/systemHealth.js"), "utf8");
  assert.match(src, /getDatabaseType/);
  assert.match(src, /isGoLimiterActive\(\{ force: true \}\)/);
  assert.match(src, /queueSnapshot/);
  assert.match(src, /goSnapshot/);
  assert.match(src, /rssMb/);
  assert.match(src, /heapUsedMb/);
  assert.match(src, /:\*\*\*@/);
  assert.match(src, /detail\) out\.process = getProcessInfo\(\)/);
  // Postgres password must be masked in the reported target.
  assert.match(src, /getDatabaseType\(\)[\s\S]*replace\(/);
});

test("system health panel is mounted on the admin dashboard profile page", () => {
  const profile = readFileSync(join(root, "src/app/(dashboard)/dashboard/profile/page.js"), "utf8");
  assert.match(profile, /SystemHealthPanel/);
  const panel = readFileSync(join(root, "src/shared/components/SystemHealthPanel.js"), "utf8");
  assert.match(panel, /fetch\("\/api\/health\?detail=1"/);
  assert.match(panel, /status === 401/);
  const barrel = readFileSync(join(root, "src/shared/components/index.js"), "utf8");
  assert.match(barrel, /SystemHealthPanel/);
});
