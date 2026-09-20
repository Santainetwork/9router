/**
 * Guards the operational safety and correctness of scripts/install-docker.sh
 * and Docker deployment artifacts (Dockerfile, docker-compose.yml).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DOCKER_INSTALL_SH = path.join(REPO_ROOT, "scripts/install-docker.sh");
const ROOT_WRAPPER_SH = path.join(REPO_ROOT, "install-docker.sh");
const DOCKERFILE = path.join(REPO_ROOT, "Dockerfile");
const COMPOSE_YML = path.join(REPO_ROOT, "docker-compose.yml");
const ENTRYPOINT_SH = path.join(REPO_ROOT, "deploy/docker-entrypoint.sh");

const SCRIPT_SRC = readFileSync(DOCKER_INSTALL_SH, "utf8");

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
