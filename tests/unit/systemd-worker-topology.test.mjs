/**
 * Task 1 focused tests for scripts/systemd-worker-topology.sh.
 *
 * Every case sources the helper in a real bash process (NOEXEC=1 so no Node is
 * spawned) and asserts on validation output, derived ports and generated env
 * files inside an mkdtemp sandbox. No root, no systemd.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HELPER = path.join(REPO_ROOT, "scripts/systemd-worker-topology.sh");

test("helper is valid bash", () => {
  execFileSync("bash", ["-n", HELPER], { stdio: "pipe" });
});

/** Source the helper, then run `body`, in a fresh bash process. */
function bash(body, extraEnv = {}) {
  const r = spawnSync("bash", ["-c", `set -euo pipefail\n. "$HELPER"\n${body}`], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 20000,
    env: { ...process.env, HELPER, NOEXEC: "1", ...extraEnv },
  });
  return { code: r.status, out: `${r.stdout || ""}`, err: `${r.stderr || ""}` };
}

function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), "9router-topo-"));
  return {
    dir,
    envDir: path.join(dir, "run", "9router-worker@"),
    unitDir: path.join(dir, "units"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function envFile(dir, i) {
  const raw = readFileSync(path.join(dir, `${i}.env`), "utf8");
  return Object.fromEntries(
    raw.split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
}

test("prepare rejects non-positive and out-of-range worker counts", () => {
  for (const bad of ["0", "-1", "", "9", "abc", "1.5"]) {
    const r = bash(`worker_env_prepare 20127 "${bad}"`);
    assert.notEqual(r.code, 0, `API_WORKERS='${bad}' must be rejected`);
    assert.match(r.err, /API_WORKERS/);
  }
  for (const ok of ["1", "2", "8"]) {
    const r = bash(`worker_env_prepare 20127 ${ok}`, { DATABASE_URL: "postgres://u:p@h:5432/9router" });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), ok);
  }
});

test("prepare rejects a backend port that overflows the TCP range", () => {
  const r = bash("worker_env_prepare 65526 8", { DATABASE_URL: "postgres://u:p@h:5432/9router" });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /overflow|port range/i);
  assert.equal(bash("worker_env_prepare 65525 8", { DATABASE_URL: "postgres://u:p@h:5432/9router" }).code, 0);
  assert.equal(bash("worker_env_prepare 65535 1").code, 0, "single-control mode has no derived worker port");
  assert.equal(bash("worker_env_prepare 20127 8", { DATABASE_URL: "postgres://u:p@h:5432/9router" }).code, 0);
});

test("prepare rejects a non-postgres DATABASE_URL even when DB_TYPE=postgres", () => {
  const r = bash("worker_env_prepare 20127 2", { DATABASE_URL: "mysql://u:p@h:3306/db", DB_TYPE: "postgres" });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /DATABASE_URL|postgres/i);
});

test("prepare requires PostgreSQL for multi-worker mode", () => {
  const missing = bash("worker_env_prepare 20127 3", { DATABASE_URL: "", DB_TYPE: "" });
  assert.notEqual(missing.code, 0);
  assert.match(missing.err, /PostgreSQL/i);

  for (const env of [{ DATABASE_URL: "postgres://u:p@h:5432/9router" }, { DATABASE_URL: "postgresql://u:p@h:5432/9router" }, { DATABASE_URL: "", DB_TYPE: "postgres" }]) {
    const r = bash("worker_env_prepare 20127 3", env);
    assert.equal(r.code, 0, `${JSON.stringify(env)}: ${r.err}`);
    assert.equal(r.out.trim(), "3");
  }
  // Single worker keeps SQLite.
  assert.equal(bash("worker_env_prepare 20127 1", { DATABASE_URL: "", DB_TYPE: "" }).code, 0);

  // Multi-worker SQLite allowed with SQLITE_MULTICORE=redis and valid REDIS_URL
  const redisOk = bash("worker_env_prepare 20127 3", {
    DATABASE_URL: "",
    DB_TYPE: "",
    SQLITE_MULTICORE: "redis",
    REDIS_URL: "redis://127.0.0.1:6379",
  });
  assert.equal(redisOk.code, 0, redisOk.err);
  assert.equal(redisOk.out.trim(), "3");

  const redisMissingUrl = bash("worker_env_prepare 20127 3", {
    DATABASE_URL: "",
    DB_TYPE: "",
    SQLITE_MULTICORE: "redis",
    REDIS_URL: "",
  });
  assert.notEqual(redisMissingUrl.code, 0);
  assert.match(redisMissingUrl.err, /REDIS_URL/i);
});

test("worker_env_write derives deterministic loopback ports for instances 1..N-1", () => {
  const sb = sandbox();
  try {
    const r = bash(`BACKEND_PORT=20127 worker_env_write "$DIR" 4`, { DIR: sb.envDir });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(readdirSync(sb.envDir).sort(), ["1.env", "2.env", "3.env"]);

    for (const i of [1, 2, 3]) {
      const e = envFile(sb.envDir, i);
      assert.equal(e.WORKER_ROLE, "api");
      assert.equal(e.NINEROUTER_WORKER_ROLE, "api");
      assert.equal(e.PORT, String(20127 + 3 + i));
      assert.equal(e.HOSTNAME, "127.0.0.1");
      assert.equal(e.API_WORKERS, "4");
    }
    assert.equal(envFile(sb.envDir, 1).PORT, "20131");
    assert.equal(envFile(sb.envDir, 3).PORT, "20133");
  } finally {
    sb.cleanup();
  }
});

test("worker_env_write drops stale instance files at or above the requested total", () => {
  const sb = sandbox();
  try {
    assert.equal(bash(`BACKEND_PORT=20127 worker_env_write "$DIR" 5`, { DIR: sb.envDir }).code, 0);
    assert.equal(bash(`BACKEND_PORT=20127 worker_env_write "$DIR" 2`, { DIR: sb.envDir }).code, 0);
    assert.deepEqual(readdirSync(sb.envDir).sort(), ["1.env"]);
  } finally {
    sb.cleanup();
  }
});

test("write-one command atomically recreates one valid runtime env", () => {
  const sb = sandbox();
  try {
    const r = spawnSync("bash", [HELPER, "write-one", sb.envDir, "20127", "4", "2"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readdirSync(sb.envDir), ["2.env"]);
    const e = envFile(sb.envDir, 2);
    assert.equal(e.WORKER_ROLE, "api");
    assert.equal(e.NINEROUTER_WORKER_ROLE, "api");
    assert.equal(e.PORT, "20132");
    assert.notEqual(spawnSync("bash", [HELPER, "write-one", sb.envDir, "20127", "4", "4"]).status, 0);
    const badPort = spawnSync("bash", [HELPER, "write-one", sb.envDir, "oops", "4", "1"], { encoding: "utf8" });
    assert.notEqual(badPort.status, 0);
    assert.match(badPort.stderr, /BACKEND_PORT/);
    const badTotal = spawnSync("bash", [HELPER, "write-one", sb.envDir, "20127", "oops", "1"], { encoding: "utf8" });
    assert.notEqual(badTotal.status, 0);
    assert.match(badTotal.stderr, /API_WORKERS/);
    writeFileSync(path.join(sb.envDir, "2.env"), "foreign\n");
    const foreign = spawnSync("bash", [HELPER, "write-one", sb.envDir, "20127", "4", "2"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(foreign.status, 0, foreign.stderr);
    assert.doesNotMatch(readFileSync(path.join(sb.envDir, "2.env"), "utf8"), /foreign/);
  } finally {
    sb.cleanup();
  }
});

test("worker_runtime_envs lists only existing instances below the total", () => {
  const sb = sandbox();
  try {
    assert.equal(bash(`BACKEND_PORT=20127 worker_env_write "$DIR" 4`, { DIR: sb.envDir }).code, 0);
    const r = bash(`worker_runtime_envs "$DIR" 4`, { DIR: sb.envDir });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), `${sb.envDir}/1.env ${sb.envDir}/2.env ${sb.envDir}/3.env`);

    const single = bash(`worker_runtime_envs "$DIR" 1`, { DIR: sb.envDir });
    assert.equal(single.out.trim(), "");
  } finally {
    sb.cleanup();
  }
});

test("worker_stale_units reports only numeric worker units above the total", () => {
  const sb = sandbox();
  try {
    mkdirSync(sb.unitDir, { recursive: true });
    for (const name of ["9router.service", "9router-worker@1.service", "9router-worker@3.service", "9router-worker@5.service", "9router-hybrid-engine.service", "9router-worker@9router.service", "other.service"]) {
      writeFileSync(path.join(sb.unitDir, name), "");
    }
    const r = bash(`worker_stale_units "$UNITS" 3`, { UNITS: sb.unitDir, RUN: sb.envDir });
    assert.equal(r.code, 0, r.err);
    const lines = r.out.trim().split("\n").filter(Boolean);
    assert.deepEqual(lines.map((l) => l.split(" ")[0]), ["3", "5"]);
    assert.ok(lines[0].endsWith("9router-worker@3.service"), lines[0]);
    assert.ok(lines[1].endsWith("9router-worker@5.service"), lines[1]);
    // Non-worker units must never be reported.
    assert.ok(!/9router\.service|hybrid-engine|other/.test(r.out), r.out);

    assert.equal(bash(`worker_stale_units "$UNITS" 8`, { UNITS: sb.unitDir, RUN: sb.envDir }).out.trim(), "");
    assert.equal(bash(`worker_stale_units "$MISSING" 2`, { MISSING: path.join(sb.dir, "nope"), RUN: sb.envDir }).code, 0);
  } finally {
    sb.cleanup();
  }
});

test("worker_stale_units finds instances enabled through target .wants symlinks", () => {
  const sb = sandbox();
  try {
    // systemctl enable on a template creates a symlink under the target's .wants
    // directory; no per-instance unit file exists in the unit directory.
    const wants = path.join(sb.unitDir, "9router-workers.target.wants");
    mkdirSync(wants, { recursive: true });
    for (const n of [1, 3]) writeFileSync(path.join(wants, `9router-worker@${n}.service`), "");
    writeFileSync(path.join(wants, "foreign.service"), "");
    const r = bash(`worker_stale_units "$UNITS" 2`, { UNITS: sb.unitDir, RUN: sb.envDir });
    assert.equal(r.code, 0, r.err);
    const lines = r.out.trim().split("\n").filter(Boolean);
    assert.deepEqual(lines.map((l) => l.split(" ")[0]), ["3"]);
    assert.ok(lines[0].endsWith("9router-worker@3.service"), lines[0]);
    assert.equal(bash(`worker_stale_units "$UNITS" 4`, { UNITS: sb.unitDir, RUN: sb.envDir }).out.trim(), "");
    assert.equal(readFileSync(path.join(wants, "foreign.service"), "utf8"), "");
  } finally {
    sb.cleanup();
  }
});
