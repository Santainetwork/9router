import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const base = { WORKER_ROLE: "control", API_WORKERS: "2", DB_TYPE: "sqlite", SQLITE_MULTICORE: "redis", REDIS_URL: "redis://cache:6379/0", ENABLE_GO_HYBRID: "true" };

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../custom-server.js");
function check(env) {
  return spawnSync(process.execPath, [server, "--check-config"], {
    env: { ...process.env, DATABASE_URL: "", ...env }, encoding: "utf8",
  });
}

test("SQLite multicore requires explicit opt-in, Redis URL, and Go limiter", () => {
  assert.equal(check(base).status, 0);
  for (const env of [
    { ...base, SQLITE_MULTICORE: "" },
    { ...base, REDIS_URL: "" },
    { ...base, ENABLE_GO_HYBRID: "false" },
    { ...base, REDIS_URL: "http://cache:6379" },
    { ...base, REDIS_URL: "redis://" },
    { ...base, REDIS_URL: "redis://cache:6379/not-a-db" },
  ]) assert.equal(check(env).status, 1);
});

test("SQLite singleton remains unchanged and PostgreSQL config remains unchanged", () => {
  assert.equal(check({ API_WORKERS: "1", DB_TYPE: "sqlite" }).status, 0);
  assert.equal(check({ API_WORKERS: "2", DATABASE_URL: "postgres://db/app" }).status, 0);
});

test("SQLite API role with one process remains prohibited", () => {
  assert.equal(check({ WORKER_ROLE: "api", API_WORKERS: "1", DB_TYPE: "sqlite" }).status, 1);
});
