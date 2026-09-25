// P3: custom-server.js cleared the force-exit timer BEFORE awaiting
// global.__stopSqliteMutationWriter, so a writer whose stop() blocks left the
// process alive with no timeout protection. The drain deadline must cover the
// writer stop too, without shortening the configured HTTP drain window.
//
// Real child processes: assert on actual exit codes and timing.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../../custom-server.js", import.meta.url));

// Child: boot custom-server.js, block the writer stop forever (keepalive handle
// stands in for the sockets a real blocking writer holds), then SIGTERM itself.
const CHILD = `
process.env.NINEROUTER_DRAIN_TIMEOUT_MS = process.env.TEST_DRAIN_MS;
require(${JSON.stringify(SERVER)});
const keepAlive = setInterval(() => {}, 1000);
global.__stopSqliteMutationWriter = () => new Promise(() => {});
const http = require("http");
const server = http.createServer((_req, res) => res.end("ok"));
server.listen(0, "127.0.0.1", () => process.kill(process.pid, "SIGTERM"));
`;

function runChild(env) {
  const child = spawn(process.execPath, ["-e", CHILD], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "ignore", "ignore"],
  });
  const started = Date.now();
  return new Promise((resolve) => {
    const guard = setTimeout(() => { child.kill("SIGKILL"); resolve({ code: null, hung: true, ms: Date.now() - started }); }, 8000);
    child.on("exit", (code) => { clearTimeout(guard); resolve({ code, hung: false, ms: Date.now() - started }); });
  });
}

test("drain timeout forces exit while the sqlite writer stop is still pending", async () => {
  const { code, hung, ms } = await runChild({ TEST_DRAIN_MS: "300" });
  assert.equal(hung, false, "process must not hang past the drain timeout when the writer stop blocks");
  assert.equal(code, 143, "SIGTERM drain timeout must force exit 143");
  assert.ok(ms < 5000, `forced exit must happen near the drain timeout, took ${ms}ms`);
});

test("quick writer stop exits without waiting out a long drain timeout", async () => {
  const child = spawn(process.execPath, ["-e", `
    process.env.NINEROUTER_DRAIN_TIMEOUT_MS = "30000";
    require(${JSON.stringify(SERVER)});
    global.__stopSqliteMutationWriter = () => Promise.resolve();
    const http = require("http");
    const server = http.createServer((_req, res) => res.end("ok"));
    server.listen(0, "127.0.0.1", () => process.kill(process.pid, "SIGTERM"));
  `], { env: { ...process.env }, stdio: ["ignore", "ignore", "ignore"] });
  const started = Date.now();
  const code = await new Promise((resolve) => {
    const guard = setTimeout(() => { child.kill("SIGKILL"); resolve(null); }, 8000);
    child.on("exit", (c) => { clearTimeout(guard); resolve(c); });
  });
  assert.equal(code, 143, "clean drain must still exit 143");
  assert.ok(Date.now() - started < 10000, "must not wait out the 30s drain timeout when the writer stops quickly");
});
