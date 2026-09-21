/**
 * Guards the operational safety and correctness of scripts/install-docker.sh
 * and Docker deployment artifacts (Dockerfile, docker-compose.yml).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DOCKER_INSTALL_SH = path.join(REPO_ROOT, "scripts/install-docker.sh");
const ROOT_WRAPPER_SH = path.join(REPO_ROOT, "install-docker.sh");
const DOCKERFILE = path.join(REPO_ROOT, "Dockerfile");
const COMPOSE_YML = path.join(REPO_ROOT, "docker-compose.yml");
const ENTRYPOINT_SH = path.join(REPO_ROOT, "deploy/docker-entrypoint.sh");
const CUSTOM_SERVER_JS = path.join(REPO_ROOT, "custom-server.js");

const SCRIPT_SRC = readFileSync(DOCKER_INSTALL_SH, "utf8");

function checkWorkerConfig(env) {
  return spawnSync(process.execPath, [CUSTOM_SERVER_JS, "--check-config"], {
    encoding: "utf8",
    env: { ...process.env, WORKER_ROLE: "", API_WORKERS: "", DB_TYPE: "", DATABASE_URL: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runEntrypointForInvalidConfig(env) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "9r-entrypoint-test-"));
  try {
    const suExec = path.join(tempDir, "su-exec");
    execFileSync("sh", ["-c", 'printf \'#!/bin/sh\\nexit 0\\n\' > "$1" && chmod +x "$1"', "sh", suExec]);
    return spawnSync("sh", [ENTRYPOINT_SH, "run"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH}`,
        DATA_DIR: path.join(tempDir, "data"),
        ENABLE_GO_HYBRID: "false",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function runEntrypointHarness({ apiWorkers = "1", failRole = "" } = {}) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "9r-entrypoint-test-"));
  const logPath = path.join(tempDir, "processes.log");
  const suExec = path.join(tempDir, "su-exec");
  writeFileSync(suExec, `#!/bin/sh
echo "start role=\${WORKER_ROLE:-} port=\${PORT:-}" >> "$PROCESS_LOG"
trap 'echo "term role=\${WORKER_ROLE:-} port=\${PORT:-}" >> "$PROCESS_LOG"; exit 0' TERM INT
if [ "\${WORKER_ROLE:-}" = "$FAIL_ROLE" ]; then exit 7; fi
while :; do sleep 1; done
`);
  chmodSync(suExec, 0o755);

  const result = spawnSync("sh", [ENTRYPOINT_SH, "run"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${tempDir}:${process.env.PATH}`,
      DATA_DIR: path.join(tempDir, "data"),
      ENABLE_GO_HYBRID: "false",
      DB_TYPE: "postgres",
      API_WORKERS: apiWorkers,
      PROCESS_LOG: logPath,
      FAIL_ROLE: failRole,
    },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
  const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  rmSync(tempDir, { recursive: true, force: true });
  return { result, log };
}

test("install-docker.sh is valid bash syntax", () => {
  execFileSync("bash", ["-n", DOCKER_INSTALL_SH], { stdio: "pipe" });
  execFileSync("bash", ["-n", ROOT_WRAPPER_SH], { stdio: "pipe" });
  execFileSync("sh", ["-n", ENTRYPOINT_SH], { stdio: "pipe" });
});

test("root installer delegates from the repository root", () => {
  const rootWrapper = readFileSync(ROOT_WRAPPER_SH, "utf8");
  assert.match(rootWrapper, /scripts\/install-docker\.sh/);
  assert.match(rootWrapper, /exec\s+bash/);
});

test("install-docker.sh enforces strict mode and avoids eval", () => {
  assert.match(SCRIPT_SRC, /^set -euo pipefail$/m, "must run under set -euo pipefail");
  assert.ok(!/\beval\b/.test(SCRIPT_SRC), "must not eval untrusted input");
});

test("install-docker.sh does not pass a blank command to Docker Compose without profiles", () => {
  assert.doesNotMatch(
    SCRIPT_SRC,
    /COMPOSE_PROFILE_ARGS\[@\]:-/,
    "empty array expansion must not create a blank Compose argument",
  );
});

test("install-docker.sh --help displays usage and critical options", () => {
  const r = spawnSync("bash", [DOCKER_INSTALL_SH, "--help"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /9Router SantaiNetwork Edition — Docker Installer/);
  assert.match(r.stdout, /--yes/);
  assert.match(r.stdout, /--upgrade/);
  assert.match(r.stdout, /--stop/);
  assert.match(r.stdout, /--restart/);
  assert.match(r.stdout, /--uninstall/);
  assert.match(r.stdout, /--dry-run/);
});

test("install-docker.sh --dry-run performs non-destructive simulation", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "9r-docker-test-"));
  try {
    const r = spawnSync("bash", [DOCKER_INSTALL_SH, "--dry-run", "--yes", "--dir", tempDir], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /\[dry-run\]/i);
    assert.match(r.stdout, /9Router Docker Stack is Ready/);
    assert.ok(!existsSync(path.join(tempDir, ".env")), "dry-run must not write .env");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Dockerfile defines multi-stage Go hybrid engine and Next.js standalone", () => {
  const dockerfileContent = readFileSync(DOCKERFILE, "utf8");
  assert.match(dockerfileContent, /FROM \$\{GO_IMAGE\} AS engine-builder/, "must build Go engine");
  assert.match(dockerfileContent, /router-engine/, "must copy router-engine");
  assert.match(dockerfileContent, /EXPOSE 20128 20140 20129/, "must expose gateway, proxy, and limiter ports");
  assert.match(dockerfileContent, /ENTRYPOINT \["\/entrypoint.sh"\]/);
  assert.match(dockerfileContent, /sed -i .*\\r.*\/entrypoint\.sh/, "must normalize entrypoint line endings");
});

test("docker-compose.yml configures gateway and public proxy ports and persistent volume", () => {
  const composeContent = readFileSync(COMPOSE_YML, "utf8");
  assert.match(composeContent, /GATEWAY_PORT:-20128/);
  assert.match(composeContent, /PUBLIC_PORT:-20140/);
  assert.match(composeContent, /9router-data:/);
  assert.match(composeContent, /ENABLE_GO_HYBRID=true/);
  assert.match(composeContent, /profiles:\s*\["postgres"\]/);
});

test("entrypoint validates API worker roles and preserves singleton defaults", () => {
  const source = readFileSync(ENTRYPOINT_SH, "utf8");
  assert.match(source, /WORKER_ROLE/);
  assert.match(source, /API_WORKERS/);
  assert.match(source, /postgres(?:ql)?:\/\//);
  assert.match(source, /DB_TYPE/);
  assert.match(source, /API_WORKER_URLS/);
  assert.match(source, /WORKER_ROLE=control/);
  assert.match(source, /API_WORKERS:-1/);
  assert.match(source, /API_WORKERS.*-gt 1/);
  assert.match(source, /-api-workers\s+"\$API_WORKER_URLS"/);
  assert.match(source, /BACKEND_PORT\s*\+\s*4\s*\+\s*i/);
});

test("docker entrypoint remains valid POSIX sh", () => {
  execFileSync("sh", ["-n", ENTRYPOINT_SH], { stdio: "pipe" });
});

test("custom-server refuses SQLite multi-worker configuration", () => {
  const result = checkWorkerConfig({ WORKER_ROLE: "control", API_WORKERS: "2", DB_TYPE: "sqlite" });
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}\n${result.stderr}`, /API_WORKERS.*PostgreSQL|PostgreSQL.*API_WORKERS/i);
});

test("custom-server refuses API role without PostgreSQL", () => {
  const result = checkWorkerConfig({ WORKER_ROLE: "api", API_WORKERS: "1", DB_TYPE: "sqlite" });
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}\n${result.stderr}`, /WORKER_ROLE=api.*PostgreSQL|PostgreSQL.*WORKER_ROLE=api/i);
});

test("custom-server marks API workers and skips background token refresh", () => {
  const source = readFileSync(CUSTOM_SERVER_JS, "utf8");
  assert.match(source, /NINEROUTER_WORKER_ROLE\s*=\s*["']api["']/);
  assert.match(source, /workerConfig\.role\s*!==\s*["']api["'][^\n]*startBackgroundTokenRefreshFromCustomServer/);
  const result = spawnSync(process.execPath, ["-e", `
    require(process.argv[1]);
    process.stdout.write(JSON.stringify({
      role: process.env.NINEROUTER_WORKER_ROLE,
      refreshDisabled: process.env.DISABLE_BACKGROUND_TOKEN_REFRESH,
      controlPlaneBootstrapped: global.__appBootstrapped,
    }));
  `, CUSTOM_SERVER_JS], {
    encoding: "utf8",
    env: { ...process.env, WORKER_ROLE: "api", API_WORKERS: "1", DB_TYPE: "postgres", DATABASE_URL: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    role: "api",
    refreshDisabled: "true",
    controlPlaneBootstrapped: true,
  });
});

test("custom-server accepts only decimal positive-integer API_WORKERS values", () => {
  for (const value of ["0", "-1", "1.5", "1e2", "not-a-number"]) {
    const result = checkWorkerConfig({ API_WORKERS: value });
    assert.equal(result.status, 1, `API_WORKERS=${value} unexpectedly passed`);
    assert.match(result.stderr, /API_WORKERS must be a positive integer/);
  }
  assert.equal(checkWorkerConfig({}).status, 0);
  assert.equal(checkWorkerConfig({ API_WORKERS: "2", DATABASE_URL: "postgresql://db/app" }).status, 0);
});

test("entrypoint rejects invalid WORKER_ROLE before launching services", () => {
  const result = runEntrypointForInvalidConfig({ WORKER_ROLE: "worker", API_WORKERS: "1" });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /WORKER_ROLE must be control or api/);
});

test("entrypoint rejects API role backed by SQLite", () => {
  const result = runEntrypointForInvalidConfig({
    WORKER_ROLE: "api",
    API_WORKERS: "1",
    DB_TYPE: "sqlite",
    DATABASE_URL: "",
  });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /WORKER_ROLE=api.*PostgreSQL|PostgreSQL.*WORKER_ROLE=api/i);
});

test("entrypoint starts one control process by default", () => {
  const { result, log } = runEntrypointHarness({ failRole: "control" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(log, /start role=control port=20128/);
  assert.doesNotMatch(log, /start role=api/);
});

test("entrypoint starts and terminates every configured API worker", () => {
  const { result, log } = runEntrypointHarness({ apiWorkers: "3", failRole: "control" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(log, /start role=control port=20128/);
  assert.match(log, /start role=api port=20131/);
  assert.match(log, /start role=api port=20132/);
  assert.match(log, /term role=api port=20131/);
  assert.match(log, /term role=api port=20132/);
});

test("entrypoint exits when an API worker dies", () => {
  const { result, log } = runEntrypointHarness({ apiWorkers: "2", failRole: "api" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(log, /start role=api port=20131/);
  assert.match(log, /term role=control port=20128/);
});
