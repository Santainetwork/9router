/**
 * Task 8: opt-in `sqlite-multicore` Docker Redis profile.
 *
 * Covers the Redis Compose service, the app-side wiring, and the installer
 * opt-in path (`--sqlite-redis`): generated secrets, no secret on stdout,
 * profile only when opted in, and refusal of unsafe external Redis URLs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DOCKER_INSTALL_SH = path.join(REPO_ROOT, "scripts/install-docker.sh");
const COMPOSE_YML = path.join(REPO_ROOT, "docker-compose.yml");
const COMPOSE_SRC = readFileSync(COMPOSE_YML, "utf8");
const SCRIPT_SRC = readFileSync(DOCKER_INSTALL_SH, "utf8");
const DOCKER_MD_SRC = readFileSync(path.join(REPO_ROOT, "DOCKER.md"), "utf8");

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

function renderCompose(profiles = [], env = {}) {
  const args = ["compose", ...profiles.flatMap((p) => ["--profile", p]), "config", "--format", "json"];
  const r = spawnSync("docker", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (r.status !== 0) return { error: `${r.stdout}\n${r.stderr}` };
  return { config: JSON.parse(r.stdout) };
}

const dockerReady = spawnSync("docker", ["compose", "version"], { encoding: "utf8" }).status === 0;

function installWithStubs(installDir, extraEnv = {}, extraArgs = []) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "9r-redis-stubs-"));
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

// ---------------------------------------------------------------------------
// Compose profile
// ---------------------------------------------------------------------------

test("compose declares an opt-in sqlite-multicore Redis service with safe persistence", () => {
  const redis = extractServiceBlock(COMPOSE_SRC, "redis");
  assert.notEqual(redis, "", "redis service must exist");
  assert.match(redis, /profiles:\s*\["sqlite-multicore"\]/, "redis must only run behind the sqlite-multicore profile");
  assert.equal(publishedPorts(redis).length, 0, "redis must never publish a host port");
  assert.match(redis, /appendonly\s+yes|--appendonly/);
  assert.match(redis, /appendfsync\s+everysec|--appendfsync/);
  assert.match(redis, /noeviction/);
  assert.match(redis, /maxmemory/);
  assert.match(redis, /9router-redis-data:\/data/);
  assert.match(redis, /healthcheck:[\s\S]*redis-cli[\s\S]*PONG/);
  assert.match(redis, /REDIS_PASSWORD is required/, "an unauthenticated broker must refuse to start");
  assert.match(redis, /--requirepass/, "the broker must require the ACL password");
  assert.match(COMPOSE_SRC, /^ {2}9router-redis-data:/m, "AOF volume must be declared");
});

test("compose wires SQLite multicore env and an optional Redis readiness dependency", () => {
  const app = extractServiceBlock(COMPOSE_SRC, "9router");
  assert.match(app, /SQLITE_MULTICORE=\$\{SQLITE_MULTICORE:-\}/);
  assert.match(app, /REDIS_URL=\$\{REDIS_URL:-\}/);
  assert.match(app, /SQLITE_QUEUE_ENCRYPTION_KEY=\$\{SQLITE_QUEUE_ENCRYPTION_KEY:-\}/);
  assert.match(
    app,
    /REDIS_KEY_PREFIX=\$\{REDIS_KEY_PREFIX:-\}/,
    "the deployment namespace must be configurable so two stacks on one Redis never collide",
  );
  assert.match(
    app,
    /depends_on:[\s\S]*redis:[\s\S]*condition:\s*service_healthy[\s\S]*required:\s*false/,
    "redis dependency must be optional so the default profile is unchanged",
  );
});

test("rendered compose exposes Redis only under the sqlite-multicore profile", { skip: !dockerReady }, () => {
  const off = renderCompose([], { SQLITE_MULTICORE: "", REDIS_URL: "", SQLITE_QUEUE_ENCRYPTION_KEY: "" });
  assert.ok(!off.error, off.error);
  assert.equal(off.config.services.redis, undefined, "redis must not render without the profile");

  const on = renderCompose(["sqlite-multicore"], {
    SQLITE_MULTICORE: "redis",
    REDIS_URL: "redis://:unit-test-secret@redis:6379/0",
    REDIS_PASSWORD: "unit-test-secret",
    SQLITE_QUEUE_ENCRYPTION_KEY: "a".repeat(64),
  });
  assert.ok(!on.error, on.error);
  const redis = on.config.services.redis;
  assert.ok(redis, "redis service must render with the profile");
  assert.deepEqual(redis.ports ?? [], [], "redis must not publish ports");
  assert.equal(on.config.services["9router"].environment.SQLITE_MULTICORE, "redis");
  assert.equal(on.config.services["9router"].environment.REDIS_URL, "redis://:unit-test-secret@redis:6379/0");
  assert.equal(on.config.services["9router"].environment.SQLITE_QUEUE_ENCRYPTION_KEY, "a".repeat(64));
  assert.equal(on.config.services["9router"].depends_on.redis.condition, "service_healthy");
  assert.equal(on.config.services["9router"].depends_on.redis.required, false);
  assert.ok(on.config.volumes["9router-redis-data"], "redis volume must be declared");
});

// ---------------------------------------------------------------------------
// Installer
// ---------------------------------------------------------------------------

test("installer documents and accepts --sqlite-redis", () => {
  const help = spawnSync("bash", [DOCKER_INSTALL_SH, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--sqlite-redis/);
  assert.match(SCRIPT_SRC, /--sqlite-redis\)\s*USE_SQLITE_REDIS=1/);
});

test("installer default install stays single-process SQLite with no Redis wiring", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "9r-redis-default-"));
  try {
    const result = installWithStubs(tempDir);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const env = readFileSync(path.join(tempDir, ".env"), "utf8");
    assert.match(env, /^API_WORKERS=1$/m);
    assert.doesNotMatch(env, /^SQLITE_MULTICORE=/m);
    assert.doesNotMatch(env, /^REDIS_URL=/m);
    assert.doesNotMatch(env, /^SQLITE_QUEUE_ENCRYPTION_KEY=/m);
    assert.doesNotMatch(result.dockerLog, /--profile sqlite-multicore/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("installer --sqlite-redis generates distinct secrets and enables only the Redis profile", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "9r-redis-optin-"));
  try {
    const result = installWithStubs(tempDir, { DATABASE_URL: "", API_WORKERS: "" }, ["--sqlite-redis"]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const envPath = path.join(tempDir, ".env");
    const env = readFileSync(envPath, "utf8");

    const redisPassword = env.match(/^REDIS_PASSWORD=(.+)$/m)?.[1];
    const queueKey = env.match(/^SQLITE_QUEUE_ENCRYPTION_KEY=(.+)$/m)?.[1];
    const redisUrl = env.match(/^REDIS_URL=(.+)$/m)?.[1];
    assert.match(redisPassword || "", /^[a-f0-9]{64}$/, "Redis ACL password must be 32 bytes of hex");
    assert.match(queueKey || "", /^[a-f0-9]{64}$/, "queue encryption key must be 64 hex chars");
    assert.notEqual(redisPassword, queueKey, "queue key must not reuse the Redis ACL password");
    assert.match(env, /^SQLITE_MULTICORE=redis$/m);
    assert.equal(redisUrl, `redis://:${redisPassword}@redis:6379/0`);
    assert.match(env, /^API_WORKERS=2$/m);
    assert.equal(statSync(envPath).mode & 0o777, 0o600, ".env must stay private");
    assert.match(result.dockerLog, /--profile sqlite-multicore/);
    assert.doesNotMatch(result.dockerLog, /--profile postgres/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("installer --sqlite-redis never echoes generated Redis secrets", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "9r-redis-redact-"));
  try {
    const result = installWithStubs(tempDir, { DATABASE_URL: "", API_WORKERS: "" }, ["--sqlite-redis"]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const env = readFileSync(path.join(tempDir, ".env"), "utf8");
    const redisPassword = env.match(/^REDIS_PASSWORD=(.+)$/m)?.[1];
    const queueKey = env.match(/^SQLITE_QUEUE_ENCRYPTION_KEY=(.+)$/m)?.[1];
    assert.ok(redisPassword && queueKey);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.ok(!output.includes(redisPassword), "Redis ACL password must never be printed");
    assert.ok(!output.includes(queueKey), "queue encryption key must never be printed");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("installer --sqlite-redis --dry-run renders the profile without writing .env", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "9r-redis-dryrun-"));
  try {
    const result = spawnSync("bash", [DOCKER_INSTALL_SH, "--dry-run", "--yes", "--sqlite-redis", "--dir", tempDir], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1", DATABASE_URL: "", API_WORKERS: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /\[dry-run\]/i);
    assert.match(result.stdout, /--profile sqlite-multicore/);
    assert.ok(!existsSync(path.join(tempDir, ".env")), "dry-run must not write .env");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("installer refuses --sqlite-redis combined with PostgreSQL", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "9r-redis-conflict-"));
  try {
    const result = installWithStubs(tempDir, { DATABASE_URL: "", API_WORKERS: "" }, ["--sqlite-redis", "--postgres"]);
    assert.notEqual(result.status, 0, "conflicting database modes must fail");
    assert.match(`${result.stdout}\n${result.stderr}`, /--sqlite-redis.*--postgres|--postgres.*--sqlite-redis/i);
    assert.ok(!existsSync(path.join(tempDir, ".env")));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("installer refuses --redis-url combined with PostgreSQL", () => {
  // --redis-url implies --sqlite-redis later in the script; the mutual-exclusion
  // gate must catch this combination, not just the explicit --sqlite-redis flag.
  const tempDir = mkdtempSync(path.join(tmpdir(), "9r-redis-url-conflict-"));
  try {
    const result = installWithStubs(tempDir, { DATABASE_URL: "", API_WORKERS: "" }, ["--postgres", "--redis-url", "rediss://:pw123@cache.example.com:6380/0"]);
    assert.notEqual(result.status, 0, "conflicting database modes must fail");
    assert.match(`${result.stdout}\n${result.stderr}`, /mutually exclusive/i);
    assert.ok(!existsSync(path.join(tempDir, ".env")));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("installer refuses unsafe external Redis URLs and accepts TLS or private hosts", () => {
  const insecure = installWithStubs(mkdtempSync(path.join(tmpdir(), "9r-redis-insecure-")), { API_WORKERS: "" }, ["--redis-url", "redis://cache.example.com:6379/0"]);
  assert.notEqual(insecure.status, 0, "plaintext remote Redis must be refused");
  assert.match(`${insecure.stdout}\n${insecure.stderr}`, /rediss:\/\//);

  // A deep public hostname must not be mistaken for an RFC1918 literal: the
  // private-host check has to be an explicit IP-range match, not a dotted-shape
  // wildcard, or plaintext redis:// silently reaches the public internet.
  const deepPublic = installWithStubs(mkdtempSync(path.join(tmpdir(), "9r-redis-deeppublic-")), { API_WORKERS: "" }, ["--redis-url", "redis://:pw123@redis.internal.corp.example.com:6379/0"]);
  assert.notEqual(deepPublic.status, 0, "plaintext deep public hostname must be refused");

  const privateHost = installWithStubs(mkdtempSync(path.join(tmpdir(), "9r-redis-private-")), { API_WORKERS: "" }, ["--redis-url", "redis://:pw123@127.0.0.1:6379/0"]);
  assert.equal(privateHost.status, 0, `${privateHost.stdout}\n${privateHost.stderr}`);

  const tls = installWithStubs(mkdtempSync(path.join(tmpdir(), "9r-redis-tls-")), { API_WORKERS: "" }, ["--redis-url", "rediss://:pw123@cache.example.com:6380/0"]);
  assert.equal(tls.status, 0, `${tls.stdout}\n${tls.stderr}`);
});

test("installer refuses external Redis URLs without credentials", () => {
  // The broker carries encrypted tokens and accepts mutation commands: a
  // passwordless URL lets any peer on the network read the stream or inject
  // forged mutations. Credentials are mandatory for external Redis.
  const noCredTls = installWithStubs(mkdtempSync(path.join(tmpdir(), "9r-redis-nocred-")), { API_WORKERS: "" }, ["--redis-url", "rediss://cache.example.com:6380/0"]);
  assert.notEqual(noCredTls.status, 0, "rediss:// without a password must be refused");
  assert.match(`${noCredTls.stdout}\n${noCredTls.stderr}`, /credential|password/i);

  const withCredTls = installWithStubs(mkdtempSync(path.join(tmpdir(), "9r-redis-cred-")), { API_WORKERS: "" }, ["--redis-url", "rediss://:pw123@cache.example.com:6380/0"]);
  assert.equal(withCredTls.status, 0, `${withCredTls.stdout}\n${withCredTls.stderr}`);
});

test("installer --sqlite-redis generates a deployment-scoped REDIS_KEY_PREFIX and preserves it on upgrade", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "9r-redis-ns-"));
  try {
    const first = installWithStubs(tempDir, { DATABASE_URL: "", API_WORKERS: "" }, ["--sqlite-redis"]);
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    const envPath = path.join(tempDir, ".env");
    const env = readFileSync(envPath, "utf8");
    const prefix = env.match(/^REDIS_KEY_PREFIX=(.+)$/m)?.[1];
    assert.match(prefix || "", /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/, "prefix must be a safe Redis namespace");

    const second = installWithStubs(tempDir, {}, ["--upgrade"]);
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    const after = readFileSync(envPath, "utf8");
    assert.match(after, new RegExp(`^REDIS_KEY_PREFIX=${prefix}$`, "m"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("installer bare upgrade preserves the Redis profile and its secrets", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "9r-redis-upgrade-"));
  try {
    writeFileSync(path.join(tempDir, ".env"), [
      "JWT_SECRET=keepme",
      "WORKER_ROLE=control",
      "API_WORKERS=2",
      "SQLITE_MULTICORE=redis",
      "REDIS_PASSWORD=keep-redis-secret",
      "REDIS_URL=redis://:keep-redis-secret@redis:6379/0",
      "SQLITE_QUEUE_ENCRYPTION_KEY=keep-queue-key",
      "BUNDLED_SQLITE_REDIS=1",
      "",
    ].join("\n"));
    const result = installWithStubs(tempDir, {}, ["--upgrade"]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const env = readFileSync(path.join(tempDir, ".env"), "utf8");
    assert.match(env, /^REDIS_PASSWORD=keep-redis-secret$/m);
    assert.match(env, /^SQLITE_QUEUE_ENCRYPTION_KEY=keep-queue-key$/m);
    assert.match(env, /^REDIS_URL=redis:\/\/:keep-redis-secret@redis:6379\/0$/m);
    assert.match(env, /^SQLITE_MULTICORE=redis$/m);
    assert.match(result.dockerLog, /--profile sqlite-multicore/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("compose stops Redis only after the app has drained", () => {
  const redis = extractServiceBlock(COMPOSE_SRC, "redis");
  assert.match(redis, /stop_grace_period:\s*60s/, "Redis needs time to flush AOF on SIGTERM");
  // Compose stops services in reverse dependency order: the app (which depends on
  // redis) receives SIGTERM first, drains streams, then Redis is signalled.
  const app = extractServiceBlock(COMPOSE_SRC, "9router");
  assert.match(app, /depends_on:[\s\S]*redis:/, "app must depend on redis to enforce stop ordering");
  assert.match(DOCKER_MD_SRC, /drain[\s\S]{0,200}Redis|Redis[\s\S]{0,200}drain/i);
});

test("installer stop/restart/uninstall re-enable the installed Redis profile", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "9r-redis-stop-"));
  try {
    writeFileSync(path.join(tempDir, "docker-compose.yml"), "services: {}\n");
    writeFileSync(path.join(tempDir, ".env"), "BUNDLED_SQLITE_REDIS=1\nSQLITE_MULTICORE=redis\nAPI_WORKERS=2\n");
    for (const flag of ["--stop", "--restart", "--uninstall"]) {
      const result = installWithStubs(tempDir, {}, [flag, "--yes"]);
      assert.equal(result.status, 0, `${flag}: ${result.stdout}\n${result.stderr}`);
      assert.match(result.dockerLog, /--profile sqlite-multicore/, `${flag} must enable the installed profile`);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("installer stop path on a plain SQLite install passes no profile", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "9r-redis-stop-plain-"));
  try {
    writeFileSync(path.join(tempDir, "docker-compose.yml"), "services: {}\n");
    writeFileSync(path.join(tempDir, ".env"), "API_WORKERS=1\nWORKER_ROLE=control\n");
    const result = installWithStubs(tempDir, {}, ["--stop", "--yes"]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(result.dockerLog, /--profile/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("installer --redis-url enables multicore without the bundled Redis profile", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "9r-redis-external-"));
  try {
    const url = "rediss://default:s3cret@cache.example.com:6380/0";
    const result = installWithStubs(tempDir, { DATABASE_URL: "", API_WORKERS: "" }, ["--redis-url", url]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const env = readFileSync(path.join(tempDir, ".env"), "utf8");
    assert.match(env, /^SQLITE_MULTICORE=redis$/m);
    assert.match(env, new RegExp(`^REDIS_URL=${url.replace(/[/.]/g, "\\$&")}$`, "m"));
    assert.match(env, /^API_WORKERS=2$/m);
    assert.doesNotMatch(env, /^BUNDLED_SQLITE_REDIS=/m, "external Redis needs no bundled service");
    assert.doesNotMatch(result.dockerLog, /--profile sqlite-multicore/);
    assert.ok(!`${result.stdout}\n${result.stderr}`.includes("s3cret"), "external credentials must not be echoed");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("installer ignores an ambient REDIS_URL when not opted in", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "9r-redis-ambient-"));
  try {
    const result = installWithStubs(tempDir, { REDIS_URL: "redis://127.0.0.1:6379/0", API_WORKERS: "" });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const env = readFileSync(path.join(tempDir, ".env"), "utf8");
    assert.match(env, /^API_WORKERS=1$/m, "an ambient REDIS_URL must not switch to multicore");
    assert.doesNotMatch(env, /^SQLITE_MULTICORE=/m);
    assert.doesNotMatch(result.dockerLog, /--profile sqlite-multicore/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("rendered Redis entrypoint is valid POSIX sh and fails closed without a password", { skip: !dockerReady }, () => {
  const rendered = renderCompose(["sqlite-multicore"], { REDIS_PASSWORD: "", REDIS_MAXMEMORY: "128mb" });
  assert.ok(!rendered.error, rendered.error);
  // `docker compose config` prints the source form; Compose unescapes `$$` to a
  // literal `$` before handing the script to the container, so emulate that.
  const script = rendered.config.services.redis.entrypoint.at(-1).replaceAll("$$", "$");
  const scriptPath = path.join(mkdtempSync(path.join(tmpdir(), "9r-redis-sh-")), "entrypoint.sh");
  try {
    writeFileSync(scriptPath, script);
    const syntax = spawnSync("sh", ["-n", scriptPath], { encoding: "utf8" });
    assert.equal(syntax.status, 0, syntax.stderr);
    // Without REDIS_PASSWORD the script must exit non-zero before exec'ing redis.
    const missing = spawnSync("sh", [scriptPath], { encoding: "utf8", env: { ...process.env, REDIS_PASSWORD: "" } });
    assert.equal(missing.status, 1, "empty password must refuse to start");
    assert.match(missing.stderr, /REDIS_PASSWORD is required/);
  } finally {
    rmSync(path.dirname(scriptPath), { recursive: true, force: true });
  }
});

test("installer-generated multicore secrets pass the application's own validators", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "9r-redis-validators-"));
  try {
    const result = installWithStubs(tempDir, { DATABASE_URL: "", API_WORKERS: "" }, ["--sqlite-redis"]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const env = readFileSync(path.join(tempDir, ".env"), "utf8");
    const read = (key) => env.match(new RegExp(`^${key}=(.+)$`, "m"))?.[1];
    const redisUrl = read("REDIS_URL");
    const queueKey = read("SQLITE_QUEUE_ENCRYPTION_KEY");
    const apiKeySecret = read("API_KEY_SECRET");

    // custom-server.js is the fail-closed gate the container runs at boot.
    const check = spawnSync(process.execPath, [path.join(REPO_ROOT, "custom-server.js"), "--check-config"], {
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: "",
        DB_TYPE: "sqlite",
        WORKER_ROLE: "control",
        API_WORKERS: read("API_WORKERS"),
        SQLITE_MULTICORE: read("SQLITE_MULTICORE"),
        REDIS_URL: redisUrl,
        ENABLE_GO_HYBRID: "true",
        SQLITE_QUEUE_ENCRYPTION_KEY: queueKey,
      },
    });
    assert.equal(check.status, 0, `generated multicore env must pass --check-config: ${check.stdout}${check.stderr}`);

    const { normalizeQueueEncryptionKey } = await import(
      pathToFileURL(path.join(REPO_ROOT, "src/lib/db/queueEncryption.js")).href
    );
    const key = normalizeQueueEncryptionKey(queueKey, { apiKeySecret, redisUrl });
    assert.equal(key.length, 32, "generated queue key must be 32 bytes");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("installer writes REDIS_MAXMEMORY to .env and preserves a custom value on upgrade", () => {
  const fresh = mkdtempSync(path.join(tmpdir(), "9r-redis-maxmem-"));
  try {
    const result = installWithStubs(fresh, { DATABASE_URL: "", API_WORKERS: "", REDIS_MAXMEMORY: "512mb" }, ["--sqlite-redis"]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const env = readFileSync(path.join(fresh, ".env"), "utf8");
    assert.match(env, /^REDIS_MAXMEMORY=512mb$/m, "custom maxmemory must be persisted to .env");

    // Upgrade with no ambient REDIS_MAXMEMORY: the existing .env value wins.
    const upgrade = installWithStubs(fresh, { DATABASE_URL: "", API_WORKERS: "", REDIS_MAXMEMORY: "" }, ["--sqlite-redis", "--upgrade"]);
    assert.equal(upgrade.status, 0, `${upgrade.stdout}\n${upgrade.stderr}`);
    const env2 = readFileSync(path.join(fresh, ".env"), "utf8");
    assert.match(env2, /^REDIS_MAXMEMORY=512mb$/m, "upgrade must preserve the operator's maxmemory");
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
});

test("entrypoint signals the gateway before the Node processes drain", () => {
  const src = readFileSync(path.join(REPO_ROOT, "deploy/docker-entrypoint.sh"), "utf8");
  const fn = src.slice(src.indexOf("terminate_children()"), src.indexOf("# TERM/INT is an operator-requested stop"));
  const engineKill = fn.indexOf('kill -TERM "$ENGINE_PID"');
  const apiKill = fn.indexOf('kill -TERM "$pid"');
  const controlKill = fn.indexOf('kill -TERM "$NODE_PID"');
  assert.ok(engineKill > 0 && apiKill > 0 && controlKill > 0, "all managed processes must be signalled");
  assert.ok(engineKill < apiKill, "the gateway must stop admitting traffic before workers drain");
  assert.ok(engineKill < controlKill, "the gateway must stop admitting traffic before the writer drains");
  // Redis is never touched here: Compose owns its lifecycle after the app exits.
  assert.doesNotMatch(fn, /redis/i, "the app container must not stop Redis itself");
});

test("DOCKER.md documents SQLite Redis multicore operations and rollback", () => {
  assert.match(DOCKER_MD_SRC, /--sqlite-redis/);
  assert.match(DOCKER_MD_SRC, /SQLITE_MULTICORE=redis/);
  assert.match(DOCKER_MD_SRC, /SQLITE_QUEUE_ENCRYPTION_KEY/);
  assert.match(DOCKER_MD_SRC, /appendfsync|AOF/i);
  assert.match(DOCKER_MD_SRC, /noeviction/i);
  assert.match(DOCKER_MD_SRC, /rollback|API_WORKERS=1/i);
});
