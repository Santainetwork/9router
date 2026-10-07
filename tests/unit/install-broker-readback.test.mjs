// Behavioral test of the broker read-back guard in scripts/install.sh.
// Extracts the guard block verbatim from the installer and executes it against
// synthetic env files, so the test tracks the real shell source, not a copy.
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

const SRC = readFileSync("scripts/install.sh", "utf8");

// Pull the broker read-back block out of the installer's env-file guard. The
// first column-0 `fi` after the start closes the OUTER `if [ -f "$ENV_FILE" ]`,
// which the testbed does not provide, so cut right before it and keep only the
// self-contained inner guard.
const start = SRC.indexOf("if [ \"$API_WORKERS\" -gt 1 ]");
assert.ok(start > 0, "the broker read-back guard must live in the installer");
const end = SRC.indexOf("\nfi\n", start);
assert.ok(end > start, "the read-back block must sit inside a larger guard");
let block = SRC.slice(start, end);
// The block is indented inside `if [ -f "$ENV_FILE" ]`; the testbed supplies
// ENV_FILE and the topology vars itself, so drop the leading indentation only.
block = block.split("\n").map((l) => l.replace(/^ {1,2}/, "")).join("\n");

function run(envFileContent, vars) {
  const dir = mkdtempSync(path.join(tmpdir(), "9router-broker-"));
  try {
    const envFile = path.join(dir, "9router.env");
    writeFileSync(envFile, envFileContent);
    const env = { ...process.env, ENV_FILE: envFile, ...vars };
    for (const k of ["SQLITE_MULTICORE", "REDIS_URL", "REDIS_KEY_PREFIX", "REDIS_PASSWORD", "SQLITE_QUEUE_ENCRYPTION_KEY"]) {
      if (!(k in vars)) delete env[k];
    }
    const out = execFileSync("bash", ["-c", `${block}\n` + [
      "for K in SQLITE_MULTICORE REDIS_URL REDIS_KEY_PREFIX REDIS_PASSWORD SQLITE_QUEUE_ENCRYPTION_KEY; do",
      '  if [ -n "${!K+x}" ]; then echo "$K=${!K}"; fi',
      "done",
    ].join("\n")], { env, cwd: process.cwd(), stdio: "pipe" }).toString();
    return Object.fromEntries(out.split("\n").filter(Boolean).map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const MULTICORE_ENV = [
  "API_WORKERS=3",
  "DB_TYPE=sqlite",
  "SQLITE_MULTICORE=redis",
  "REDIS_URL=redis://127.0.0.1:6379/0",
  "REDIS_KEY_PREFIX=9router:sqlite",
  `SQLITE_QUEUE_ENCRYPTION_KEY=${"a".repeat(64)}`,
].join("\n") + "\n";

test("upgrade of an installed multicore topology inherits the broker keys", () => {
  const keys = run(MULTICORE_ENV, { API_WORKERS: "3" });
  assert.equal(keys.SQLITE_MULTICORE, "redis");
  assert.equal(keys.REDIS_URL, "redis://127.0.0.1:6379/0");
  assert.equal(keys.REDIS_KEY_PREFIX, "9router:sqlite");
  assert.equal(keys.SQLITE_QUEUE_ENCRYPTION_KEY, "a".repeat(64));
});

test("rollback to a single worker drops the broker instead of resurrecting it", () => {
  const keys = run(MULTICORE_ENV, { API_WORKERS: "1" });
  assert.deepEqual(keys, {}, "no broker key may survive a rollback to one process");
});

test("scaling workers up keeps the broker", () => {
  const keys = run(MULTICORE_ENV, { API_WORKERS: "8" });
  assert.equal(keys.SQLITE_MULTICORE, "redis");
  assert.equal(keys.REDIS_URL, "redis://127.0.0.1:6379/0");
});

test("a broker key set in the installer environment wins over the file", () => {
  const keys = run(MULTICORE_ENV, {
    API_WORKERS: "3",
    REDIS_URL: "rediss://broker.internal:6380/1",
    SQLITE_MULTICORE: "redis",
  });
  assert.equal(keys.REDIS_URL, "rediss://broker.internal:6380/1");
});

test("clearing a broker key with an empty value stays cleared", () => {
  const keys = run(MULTICORE_ENV, {
    API_WORKERS: "3",
    REDIS_URL: "",
    SQLITE_QUEUE_ENCRYPTION_KEY: "",
  });
  assert.equal(keys.REDIS_URL, "", "an explicit empty value must not be overwritten by the file");
  assert.equal(keys.SQLITE_QUEUE_ENCRYPTION_KEY, "");
  assert.equal(keys.SQLITE_MULTICORE, "redis", "untouched keys are still inherited");
});

test("a missing env file yields no broker keys", () => {
  const keys = run("", { API_WORKERS: "3" });
  assert.deepEqual(keys, {}, "a read-back must not invent keys without a file");
});
