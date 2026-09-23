/**
 * Guards the operational safety and correctness of scripts/install-docker.sh
 * and Docker deployment artifacts (Dockerfile, docker-compose.yml).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DOCKER_INSTALL_SH = path.join(REPO_ROOT, "scripts/install-docker.sh");
const ROOT_WRAPPER_SH = path.join(REPO_ROOT, "install-docker.sh");
const START_SH = path.join(REPO_ROOT, "start.sh");
const DOCKERFILE = path.join(REPO_ROOT, "Dockerfile");
const COMPOSE_YML = path.join(REPO_ROOT, "docker-compose.yml");
const ENTRYPOINT_SH = path.join(REPO_ROOT, "deploy/docker-entrypoint.sh");
const CUSTOM_SERVER_JS = path.join(REPO_ROOT, "custom-server.js");
const INSTRUMENTATION_JS = path.join(REPO_ROOT, "src/instrumentation.js");

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
    execFileSync("sh", ["-c", 'printf \'#!/bin/sh\\nshift\\nexec "$@"\\n\' > "$1" && chmod +x "$1"', "sh", suExec]);
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
if [ "\${3:-}" = "custom-server.js" ] && [ "\${4:-}" = "--check-config" ]; then exit 0; fi
echo "start role=\${WORKER_ROLE:-} port=\${PORT:-} host=\${HOSTNAME:-}" >> "$PROCESS_LOG"
trap 'echo "term role=\${WORKER_ROLE:-} port=\${PORT:-} host=\${HOSTNAME:-}" >> "$PROCESS_LOG"; exit 0' TERM INT
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

// Live (non-crashing) harness: keeps every child alive so a test can send TERM
// and observe the entrypoint's clean-shutdown exit code and termination logs.
function launchEntrypointHarness({ apiWorkers = "1" } = {}) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "9r-entrypoint-live-"));
  const logPath = path.join(tempDir, "processes.log");
  const suExec = path.join(tempDir, "su-exec");
  writeFileSync(suExec, `#!/bin/sh
if [ "\${3:-}" = "custom-server.js" ] && [ "\${4:-}" = "--check-config" ]; then exit 0; fi
echo "start role=\${WORKER_ROLE:-} port=\${PORT:-} host=\${HOSTNAME:-}" >> "$PROCESS_LOG"
trap 'echo "term role=\${WORKER_ROLE:-} port=\${PORT:-} host=\${HOSTNAME:-}" >> "$PROCESS_LOG"; exit 0' TERM INT
while :; do sleep 1; done
`);
  chmodSync(suExec, 0o755);

  const child = spawn("sh", [ENTRYPOINT_SH, "run"], {
    env: {
      ...process.env,
      PATH: `${tempDir}:${process.env.PATH}`,
      DATA_DIR: path.join(tempDir, "data"),
      ENABLE_GO_HYBRID: "false",
      DB_TYPE: "postgres",
      API_WORKERS: apiWorkers,
      PROCESS_LOG: logPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const readLog = () => (existsSync(logPath) ? readFileSync(logPath, "utf8") : "");
  const waitFor = async (predicate, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate(readLog())) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`timed out waiting for entrypoint; log=${readLog()}\nstderr=${stderr}`);
  };
  const stop = async () => {
    child.kill("SIGTERM");
    const [code] = await once(child, "exit");
    return code;
  };
  return {
    child,
    readLog,
    waitFor,
    stop,
    getStderr: () => stderr,
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
  };
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
  const appBlock = extractServiceBlock(composeContent, "9router");
  const drainMs = Number(readFileSync(CUSTOM_SERVER_JS, "utf8").match(/NINEROUTER_DRAIN_TIMEOUT_MS \|\| (\d+)/)?.[1]);
  const graceSeconds = Number(appBlock.match(/stop_grace_period:\s*(\d+)s/)?.[1]);
  assert.ok(graceSeconds * 1000 > drainMs, "Docker grace must exceed the application drain timeout");
});

test("bundled PostgreSQL profile wires app readiness and multicore defaults", () => {
  const compose = readFileSync(COMPOSE_YML, "utf8");
  const app = extractServiceBlock(compose, "9router");
  const postgres = extractServiceBlock(compose, "postgres");

  assert.match(app, /DATABASE_URL=.*BUNDLED_DATABASE_URL/);
  assert.match(app, /API_WORKERS=.*BUNDLED_API_WORKERS/);
  assert.match(app, /depends_on:[\s\S]*postgres:[\s\S]*condition:\s*service_healthy/);
  assert.match(postgres, /healthcheck:[\s\S]*pg_isready/);

  const rendered = execFileSync("docker", ["compose", "--profile", "postgres", "config", "--format", "json"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_URL: "",
      API_WORKERS: "",
      POSTGRES_PASSWORD: "test-secret",
      BUNDLED_DATABASE_URL: "postgres://9router:test-secret@postgres:5432/9router",
      BUNDLED_API_WORKERS: "3",
    },
  });
  const config = JSON.parse(rendered);
  assert.equal(config.services["9router"].environment.DATABASE_URL, "postgres://9router:test-secret@postgres:5432/9router");
  assert.equal(config.services["9router"].environment.API_WORKERS, "3");
  assert.equal(config.services["9router"].depends_on.postgres.condition, "service_healthy");
});

test("Docker installer --postgres creates an internal database URL and multicore env", () => {
  assert.match(SCRIPT_SRC, /--postgres/);
  assert.match(SCRIPT_SRC, /POSTGRES_PASSWORD/);
  assert.match(SCRIPT_SRC, /postgres:\/\/9router:\$\{POSTGRES_PASSWORD\}@postgres:5432\/9router/);
  assert.match(SCRIPT_SRC, /API_WORKERS=.*3/);
  assert.match(SCRIPT_SRC, /DB_TYPE=postgres/);
  assert.match(SCRIPT_SRC, /USE_BUNDLED_POSTGRES/);
});

test("Docker installer enables the postgres profile only for its bundled database", () => {
  const bundled = spawnSync("bash", [DOCKER_INSTALL_SH, "--dry-run", "--yes", "--postgres", "--dir", path.join(tmpdir(), "9r-pg-profile")], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", DATABASE_URL: "", API_WORKERS: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(bundled.status, 0, `${bundled.stdout}\n${bundled.stderr}`);
  assert.match(bundled.stdout, /docker compose --profile postgres up -d --build/);

  const external = spawnSync("bash", [DOCKER_INSTALL_SH, "--dry-run", "--yes", "--database-url", "postgres://u:p@db.example/app", "--dir", path.join(tmpdir(), "9r-pg-external")], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", API_WORKERS: "3" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(external.status, 0, `${external.stdout}\n${external.stderr}`);
  assert.doesNotMatch(external.stdout, /--profile postgres/);
});

test("direct Docker launcher preserves the application drain window", () => {
  const source = readFileSync(START_SH, "utf8");
  const drainMs = Number(readFileSync(CUSTOM_SERVER_JS, "utf8").match(/NINEROUTER_DRAIN_TIMEOUT_MS \|\| (\d+)/)?.[1]);
  const stopSeconds = Number(source.match(/docker stop -t (\d+) 9router/)?.[1]);
  const runSeconds = Number(source.match(/docker run[^\n]*--stop-timeout (\d+)/)?.[1]);
  assert.ok(stopSeconds * 1000 > drainMs);
  assert.ok(runSeconds * 1000 > drainMs);
});

test("documented direct Docker stop commands preserve the drain window", () => {
  const files = execFileSync("git", ["ls-files", "*.md"], { cwd: REPO_ROOT, encoding: "utf8" }).trim().split("\n");
  let directRuns = 0;
  for (const file of files) {
    const source = readFileSync(path.join(REPO_ROOT, file), "utf8");
    assert.doesNotMatch(source, /docker stop 9router\b/, `${file} must preserve the 330s drain timeout`);
    for (const block of source.split("```").filter((_, index) => index % 2 === 1)) {
      if (!/docker run -d\b/.test(block)) continue;
      directRuns++;
      assert.match(block, /--stop-timeout 330/, `${file} must configure the 330s stop timeout`);
    }
  }
  assert.ok(directRuns > 0, "expected documented direct Docker run commands");
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

test("custom-server honors NINEROUTER_WORKER_ROLE alias for the API role", () => {
  // The driver/engine role detection (isApiWorker/isApiWorkerRole) accepts either
  // env var; validateWorkerConfig must agree, otherwise an alias-only API worker
  // silently passes the SQLite guard and then shares state across replicas.
  const rejected = checkWorkerConfig({ NINEROUTER_WORKER_ROLE: "api", API_WORKERS: "1", DB_TYPE: "sqlite" });
  assert.equal(rejected.status, 1, `${rejected.stdout}\n${rejected.stderr}`);
  assert.match(`${rejected.stdout}\n${rejected.stderr}`, /requires PostgreSQL/);

  const accepted = checkWorkerConfig({ NINEROUTER_WORKER_ROLE: "api", API_WORKERS: "1", DATABASE_URL: "postgres://db/app" });
  assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`);

  const invalid = checkWorkerConfig({ NINEROUTER_WORKER_ROLE: "bogus" });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /WORKER_ROLE must be control or api/);
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

test("entrypoint rejects unsafe API_WORKERS integers before arithmetic", () => {
  for (const value of ["08", "999999999999999999999999999"]) {
    const result = runEntrypointForInvalidConfig({ API_WORKERS: value });
    assert.equal(result.status, 1, `API_WORKERS=${value} unexpectedly passed`);
    assert.match(result.stderr, /API_WORKERS must be a positive integer/);
  }
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

test("entrypoint starts one control process by default and stops cleanly on TERM", async () => {
  const h = launchEntrypointHarness({ apiWorkers: "1" });
  try {
    await h.waitFor((log) => /start role=control port=20128/.test(log));
    const code = await h.stop();
    const log = h.readLog();
    assert.equal(code, 0, `expected clean exit 0; log=${log}\nstderr=${h.getStderr()}`);
    assert.doesNotMatch(log, /start role=api/);
    assert.match(log, /term role=control port=20128/);
  } finally {
    h.cleanup();
  }
});

test("entrypoint terminates every configured API worker on clean shutdown", async () => {
  const h = launchEntrypointHarness({ apiWorkers: "3" });
  try {
    await h.waitFor((log) => /start role=api port=20132/.test(log));
    const code = await h.stop();
    const log = h.readLog();
    assert.equal(code, 0, `expected clean exit 0; log=${log}\nstderr=${h.getStderr()}`);
    assert.match(log, /start role=control port=20128/);
    assert.match(log, /start role=api port=20131/);
    assert.match(log, /start role=api port=20132/);
    assert.match(log, /term role=control port=20128/);
    assert.match(log, /term role=api port=20131/);
    assert.match(log, /term role=api port=20132/);
  } finally {
    h.cleanup();
  }
});

test("API workers bind loopback even when the engine is disabled and control binds 0.0.0.0", async () => {
  const h = launchEntrypointHarness({ apiWorkers: "2" });
  try {
    await h.waitFor((log) => /start role=api port=20131 host=127\.0\.0\.1/.test(log));
    const log = h.readLog();
    assert.match(log, /start role=control port=20128 host=0\.0\.0\.0/);
    assert.match(log, /start role=api port=20131 host=127\.0\.0\.1/);
    assert.equal(await h.stop(), 0, `expected clean exit; log=${log}`);
  } finally {
    h.cleanup();
  }
});

test("entrypoint exits non-zero when the control process crashes", () => {
  const { result, log } = runEntrypointHarness({ failRole: "control" });
  assert.equal(result.status, 1, `expected non-zero exit; stderr=${result.stderr}`);
  assert.match(log, /start role=control port=20128/);
});

test("entrypoint exits non-zero when an API worker dies", () => {
  const { result, log } = runEntrypointHarness({ apiWorkers: "2", failRole: "api" });
  assert.equal(result.status, 1, `expected non-zero exit; stderr=${result.stderr}`);
  assert.match(log, /start role=api port=20131/);
  assert.match(log, /term role=control port=20128/);
});

test("custom-server caps API_WORKERS at 8", () => {
  const over = checkWorkerConfig({ API_WORKERS: "9", DATABASE_URL: "postgres://db/app" });
  assert.equal(over.status, 1);
  assert.match(over.stderr, /API_WORKERS must not exceed 8/);
  assert.equal(
    checkWorkerConfig({ API_WORKERS: "8", DATABASE_URL: "postgres://db/app" }).status,
    0,
    "8 API workers must remain valid",
  );
});

test("entrypoint rejects API_WORKERS above the shared cap of 8", () => {
  const result = runEntrypointForInvalidConfig({ API_WORKERS: "9" });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /API_WORKERS must not exceed 8/);
});

test("API workers skip the model catalog sync", async () => {
  const src = readFileSync(INSTRUMENTATION_JS, "utf8");
  assert.match(
    src,
    /if\s*\(\s*!isApiWorkerRole\(\)\s*\)\s*\{[\s\S]*?startModelCatalogSync\(\)/,
    "startModelCatalogSync must be guarded by isApiWorkerRole",
  );
  const { isApiWorkerRole } = await import(
    pathToFileURL(path.join(REPO_ROOT, "src/shared/utils/engineConfig.js")).href
  );
  assert.equal(isApiWorkerRole({ WORKER_ROLE: "api" }), true);
  assert.equal(isApiWorkerRole({ NINEROUTER_WORKER_ROLE: "api" }), true);
  assert.equal(isApiWorkerRole({ WORKER_ROLE: "control" }), false);
  assert.equal(isApiWorkerRole({}), false);
});

// ---------------------------------------------------------------------------
// Task 6: deployment wiring for WORKER_ROLE / API_WORKERS
// ---------------------------------------------------------------------------

const DOCKER_MD = path.join(REPO_ROOT, "DOCKER.md");
const COMPOSE_SRC = readFileSync(COMPOSE_YML, "utf8");
const DOCKER_MD_SRC = readFileSync(DOCKER_MD, "utf8");

function extractServiceBlock(content, name) {
  const re = new RegExp(`^ {2}${name}:\\s*$`, "m");
  const start = content.search(re);
  if (start < 0) return "";
  const rest = content.slice(start);
  const next = rest.slice(1).search(/\n {2}[A-Za-z0-9_-]+:\s*(\n|$)/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

function publishedPorts(serviceBlock) {
  const portsMatch = serviceBlock.match(/\n {4}ports:\n([\s\S]*?)(?=\n {4}[A-Za-z0-9_-]+:|\s*$)/);
  if (!portsMatch) return [];
  return [...portsMatch[1].matchAll(/-\s*["']?([^"'\n]+)["']?/g)].map((m) => m[1].trim());
}

function installWithStubs(installDir, extraEnv = {}, extraArgs = []) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "9r-install-stubs-"));
  const docker = path.join(tempDir, "docker");
  writeFileSync(docker, `#!/bin/sh
if [ -n "$STUB_DOCKER_LOG" ]; then echo "$@" >> "$STUB_DOCKER_LOG"; fi
if [ "$1" = "--version" ]; then echo "Docker version 24.0.0, build test"; exit 0; fi
if [ "$1" = "compose" ] && [ "$2" = "version" ]; then echo "Docker Compose version v2.0.0"; exit 0; fi
if [ "$1" = "info" ]; then exit 0; fi
exit 0
`);
  chmodSync(docker, 0o755);
  const curl = path.join(tempDir, "curl");
  writeFileSync(curl, `#!/bin/sh
for a in "$@"; do case "$a" in -w) ;; *\\%\\{http_code\\}*) echo 200; exit 0 ;; esac; done
echo 200
`);
  chmodSync(curl, 0o755);
  const dockerLogPath = path.join(tempDir, "docker-args.log");
  const result = spawnSync("bash", [DOCKER_INSTALL_SH, "--yes", "--dir", installDir, ...extraArgs], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${tempDir}:${process.env.PATH}`,
      NO_COLOR: "1",
      INSTALL_DIR: installDir,
      STUB_DOCKER_LOG: dockerLogPath,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  try { result.dockerLog = readFileSync(dockerLogPath, "utf8"); } catch { result.dockerLog = ""; }
  rmSync(tempDir, { recursive: true, force: true });
  return result;
}

test("docker-compose.yml propagates WORKER_ROLE and API_WORKERS with single-process defaults", () => {
  const appBlock = extractServiceBlock(COMPOSE_SRC, "9router");
  assert.match(appBlock, /WORKER_ROLE=\$\{WORKER_ROLE:-control\}/);
  assert.match(appBlock, /API_WORKERS=\$\{API_WORKERS:-\$\{BUNDLED_API_WORKERS:-1\}\}/);
  assert.match(appBlock, /DATABASE_URL=\$\{DATABASE_URL:-\$\{BUNDLED_DATABASE_URL:-\}\}/, "SQLite stays the default database");
});

test("docker-compose.yml publishes only gateway and public proxy ports", () => {
  const appBlock = extractServiceBlock(COMPOSE_SRC, "9router");
  const ports = publishedPorts(appBlock);
  assert.equal(ports.length, 2, `expected exactly two published ports, got ${JSON.stringify(ports)}`);
  assert.deepEqual(ports.sort(), ["${GATEWAY_PORT:-20128}:20128", "${PUBLIC_PORT:-20140}:20140"].sort());
  for (const internal of ["20127", "20129", "20131", "20132"]) {
    assert.ok(
      !ports.some((p) => p.includes(internal)),
      `internal port ${internal} must not be published`,
    );
  }
  assert.ok(!/\/ready/.test(appBlock), "internal /ready must not be exposed in compose");
});

test("docker-compose.yml stays valid Compose when Docker is available", () => {
  const probe = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
  if (probe.status !== 0) {
    console.error("[install-docker-safety] docker unavailable; compose validation skipped");
    return;
  }
  const r = spawnSync("docker", ["compose", "config", "--quiet"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
});

test("installer emits WORKER_ROLE/API_WORKERS defaults into generated .env", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "9r-install-env-"));
  try {
    const result = installWithStubs(tempDir);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const env = readFileSync(path.join(tempDir, ".env"), "utf8");
    assert.match(env, /^WORKER_ROLE=control$/m);
    assert.match(env, /^API_WORKERS=1$/m);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("installer --postgres writes a secure bundled PostgreSQL multicore environment", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "9r-install-postgres-"));
  try {
    const result = installWithStubs(tempDir, { DATABASE_URL: "", API_WORKERS: "" }, ["--postgres"]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const env = readFileSync(path.join(tempDir, ".env"), "utf8");
    const password = env.match(/^POSTGRES_PASSWORD=(.+)$/m)?.[1];
    assert.match(password || "", /^[a-f0-9]{64}$/);
    assert.match(env, new RegExp(`^DATABASE_URL=postgres://9router:${password}@postgres:5432/9router$`, "m"));
    assert.match(env, /^BUNDLED_DATABASE_URL=postgres:\/\/9router:.+@postgres:5432\/9router$/m);
    assert.match(env, /^DB_TYPE=postgres$/m);
    assert.match(env, /^API_WORKERS=3$/m);
    assert.match(env, /^BUNDLED_API_WORKERS=3$/m);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("installer bare upgrade preserves the bundled PostgreSQL profile", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "9r-install-postgres-upgrade-"));
  try {
    writeFileSync(path.join(tempDir, ".env"), [
      "POSTGRES_PASSWORD=keep-postgres-secret",
      "DATABASE_URL=postgres://9router:keep-postgres-secret@postgres:5432/9router",
      "BUNDLED_DATABASE_URL=postgres://9router:keep-postgres-secret@postgres:5432/9router",
      "BUNDLED_API_WORKERS=3",
      "API_WORKERS=3",
      "WORKER_ROLE=control",
      "",
    ].join("\n"));
    const result = installWithStubs(tempDir, {}, ["--upgrade"]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const env = readFileSync(path.join(tempDir, ".env"), "utf8");
    assert.match(env, /^POSTGRES_PASSWORD=keep-postgres-secret$/m);
    assert.match(env, /^BUNDLED_DATABASE_URL=postgres:\/\/9router:keep-postgres-secret@postgres:5432\/9router$/m);
    assert.match(result.dockerLog, /compose --profile postgres up -d --build/);
    assert.match(result.stdout, /Docker container started/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("installer preserves existing WORKER_ROLE/API_WORKERS during upgrade", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "9r-install-preserve-"));
  try {
    writeFileSync(
      path.join(tempDir, ".env"),
      "JWT_SECRET=keepme\nWORKER_ROLE=api\nAPI_WORKERS=3\nDATABASE_URL=postgres://u:p@db:5432/app\n",
    );
    const result = installWithStubs(tempDir);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const env = readFileSync(path.join(tempDir, ".env"), "utf8");
    assert.match(env, /^WORKER_ROLE=api$/m, "user WORKER_ROLE must survive upgrade");
    assert.match(env, /^API_WORKERS=3$/m, "user API_WORKERS must survive upgrade");
    assert.match(env, /^JWT_SECRET=keepme$/m, "existing secrets must survive upgrade");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("DOCKER.md documents PostgreSQL multiworker semantics, isolation, and rollback", () => {
  const doc = DOCKER_MD_SRC;
  assert.match(doc, /WORKER_ROLE/);
  assert.match(doc, /API_WORKERS/);
  assert.match(doc, /API_WORKERS=3/, "must show the two-API-worker example");
  assert.match(doc, /1 control process .*2 API worker|1 control \+ .*API_WORKERS.*- 1/, "must state total-process semantics");
  assert.match(doc, /PostgreSQL/i);
  assert.match(doc, /systemd/i, "must document the systemd environment override");
  assert.match(doc, /rollback|API_WORKERS=1/i);
});

test("DOCKER.md documents SQLite single-process default and internal port isolation", () => {
  const doc = DOCKER_MD_SRC;
  assert.match(doc, /SQLite/i);
  assert.match(doc, /20128/);
  assert.match(doc, /20140/);
  assert.doesNotMatch(doc, /publish(?:ed|es)?[^\n]*20127/i, "must not advertise internal backend port");
  assert.doesNotMatch(doc, /publish(?:ed|es)?[^\n]*20129/i, "must not advertise internal limiter port");
});
