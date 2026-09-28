import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const base = { WORKER_ROLE: "control", API_WORKERS: "2", DB_TYPE: "sqlite", SQLITE_MULTICORE: "redis", REDIS_URL: "redis://cache:6379/0", ENABLE_GO_HYBRID: "true", SQLITE_QUEUE_ENCRYPTION_KEY: "a".repeat(64) };

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

test("SQLite multicore requires a valid dedicated SQLITE_QUEUE_ENCRYPTION_KEY at boot", () => {
  const validKey = "a".repeat(64);
  // No key: token-bearing sync mutations would throw at request time instead
  // of failing startup. Fail closed at boot.
  const unset = { ...base }; delete unset.SQLITE_QUEUE_ENCRYPTION_KEY;
  for (const env of [
    unset,
    { ...base, SQLITE_QUEUE_ENCRYPTION_KEY: "" },
    { ...base, SQLITE_QUEUE_ENCRYPTION_KEY: "tooshort" },
    { ...base, SQLITE_QUEUE_ENCRYPTION_KEY: "z".repeat(64) }, // non-hex
  ]) assert.equal(check(env).status, 1, JSON.stringify(env.SQLITE_QUEUE_ENCRYPTION_KEY));
  assert.equal(check({ ...base, SQLITE_QUEUE_ENCRYPTION_KEY: validKey }).status, 0);
});
