/**
 * Guards the operational safety properties of scripts/install.sh.
 *
 * These are static + sandboxed behavioural checks. They deliberately never run
 * the installer for real: every behavioural case points INSTALL_DIR/RELEASE_DIR/
 * DATA_DIR/ENV_FILE at a temp sandbox and asserts on dry-run or refusal paths.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const INSTALL_SH = path.join(REPO_ROOT, "scripts/install.sh");
const SRC = readFileSync(INSTALL_SH, "utf8");

function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), "9router-install-"));
  return {
    dir,
    env: {
      ...process.env,
      INSTALL_DIR: path.join(dir, "inst"),
      RELEASE_DIR: path.join(dir, "rel"),
      DATA_DIR: path.join(dir, "data"),
      ENV_FILE: path.join(dir, "9router.env"),
      BACKUP_ROOT: path.join(dir, "backups"),
      STATE_DIR: path.join(dir, "state"),
      NO_COLOR: "1",
      // Sandboxes must not be affected by 9Router units on the build host.
      SYSTEMD_UNIT_DIR: path.join(dir, "units"),
      SKIP_SYSTEMD_UNIT_PROBE: "1",
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function runInstaller(args, env) {
  const r = spawnSync("bash", [INSTALL_SH, ...args], {
    env,
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
  });
  return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}

test("install.sh is valid bash", () => {
  execFileSync("bash", ["-n", INSTALL_SH], { stdio: "pipe" });
});

test("install.sh declares strict-mode and does not use eval", () => {
  assert.match(SRC, /^set -euo pipefail$/m, "must run under set -euo pipefail");
  assert.ok(!/\beval\b/.test(SRC), "must not eval untrusted input");
  assert.ok(!/curl[^\n]*\|\s*(ba)?sh/.test(SRC), "must not pipe curl into a shell");
});

test("production guard: refuses to overwrite an existing install without an explicit flag", () => {
  const sb = sandbox();
  try {
    // Simulate an existing install in the sandbox.
    mkdirSync(sb.env.RELEASE_DIR, { recursive: true });
    const r = runInstaller([], sb.env);
    assert.equal(r.code, 3, "must exit 3 when an existing install is detected");
    assert.match(r.out, /existing 9Router installation was detected/i);
    assert.match(r.out, /--upgrade/);
    assert.match(r.out, /--uninstall/);
    assert.match(r.out, /--force-reinstall/);
  } finally {
    sb.cleanup();
  }
});

test("--upgrade is accepted and describes backup + rollback", () => {
  const sb = sandbox();
  try {
    mkdirSync(sb.env.RELEASE_DIR, { recursive: true });
    const r = runInstaller(["--upgrade", "--dry-run"], sb.env);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Upgrade mode/);
    assert.match(r.out, /automatic rollback armed|backup/i);
  } finally {
    sb.cleanup();
  }
});

test("--dry-run on a clean host changes nothing", () => {
  const sb = sandbox();
  try {
    const r = runInstaller(["--dry-run"], sb.env);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Dry run complete/);
    assert.ok(!existsSync(sb.env.RELEASE_DIR), "dry-run must not create the release dir");
    assert.ok(!existsSync(sb.env.INSTALL_DIR), "dry-run must not create the install dir");
    assert.ok(!existsSync(sb.env.ENV_FILE), "dry-run must not write the env file");
  } finally {
    sb.cleanup();
  }
});

test("uninstall demands explicit confirmation instead of auto-confirming from piped stdin", () => {
  const sb = sandbox();
  try {
    const r = runInstaller(["--uninstall"], sb.env);
    assert.notEqual(r.code, 0, "uninstall without consent must not succeed");
    assert.match(r.out, /Uninstall cancelled/i);
    assert.match(r.out, /--yes/, "must point at --yes for unattended use");
  } finally {
    sb.cleanup();
  }
});

test("uninstall supports a non-destructive preview", () => {
  const sb = sandbox();
  try {
    const r = runInstaller(["--uninstall", "--dry-run"], sb.env);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /\[dry-run\]/);
  } finally {
    sb.cleanup();
  }
});

test("--restore-backup requires a path and rejects a missing directory", () => {
  const sb = sandbox();
  try {
    const missing = runInstaller(["--restore-backup"], sb.env);
    assert.equal(missing.code, 2, "missing path must be a usage error");

    const bad = runInstaller(["--restore-backup", "/nonexistent/9router-backup-xyz"], sb.env);
    assert.notEqual(bad.code, 0);
    assert.match(bad.out, /Backup directory not found|Restore cancelled/i);
  } finally {
    sb.cleanup();
  }
});

test("a foreign listener on a required port is a hard failure", async () => {
  const net = await import("node:net");
  const sb = sandbox();
  // Bind an ephemeral port, then ask the installer to use it.
  const server = net.createServer();
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  const taken = server.address().port;
  try {
    const r = runInstaller(["--dry-run"], { ...sb.env, PUBLIC_PORT: String(taken) });
    assert.notEqual(r.code, 0, "must fail rather than silently collide");
    assert.match(r.out, /Port conflict detected/);
    assert.match(r.out, new RegExp(`Port ${taken} is already in use`));
  } finally {
    await new Promise((res) => server.close(res));
    sb.cleanup();
  }
});

test("port ownership detection ignores generic node listeners", () => {
  // A bare `node` process is NOT treated as ours, otherwise the installer could
  // overwrite an unrelated service that happens to share a port.
  const ours = SRC.slice(SRC.indexOf("port_is_ours()"), SRC.indexOf("require_free_ports()"));
  assert.ok(ours.includes("router-engine"), "must recognise the engine process");
  assert.ok(ours.includes("next-server"), "must recognise the Next.js process");
  assert.ok(!/^\s*\*node\*/.test(ours) && !ours.includes("*node*"), "must not treat any node process as ours");
});

test("unknown flags are rejected with a usage error", () => {
  const sb = sandbox();
  try {
    const r = runInstaller(["--nope"], sb.env);
    assert.equal(r.code, 2);
    assert.match(r.out, /Unknown option: --nope/);
  } finally {
    sb.cleanup();
  }
});

test("--help documents every safety flag", () => {
  const sb = sandbox();
  try {
    const r = runInstaller(["--help"], sb.env);
    assert.equal(r.code, 0);
    for (const flag of ["--upgrade", "--force-reinstall", "--restore-backup", "--uninstall", "--purge", "--dry-run", "--yes"]) {
      assert.ok(r.out.includes(flag), `--help must document ${flag}`);
    }
  } finally {
    sb.cleanup();
  }
});

test("backup/rollback plumbing exists and is wired to the error trap", () => {
  assert.match(SRC, /^rollback\(\)/m, "rollback() must exist");
  assert.match(SRC, /^on_error\(\)/m, "on_error() must exist");
  assert.match(SRC, /trap on_error ERR/, "ERR trap must be installed");
  assert.match(SRC, /set -E/, "errtrace must be enabled so the trap fires inside functions");
  assert.match(SRC, /ROLLBACK_ARMED=1/, "rollback must be armed during upgrade/reinstall");
  assert.match(SRC, /BACKUP_ROOT.*\/var\/backups\/9router/, "must default to /var/backups/9router");
});

test("port conflicts are validated before any mutating step", () => {
  assert.match(SRC, /^require_free_ports\(\)/m, "require_free_ports() must exist");
  assert.match(SRC, /Port conflict detected/, "must explain the conflict clearly");
  const validate = SRC.indexOf("require_free_ports \"$GATEWAY_PORT\"");
  const build = SRC.indexOf("step \"Installing Node dependencies\"");
  assert.ok(validate > 0 && build > 0 && validate < build, "port validation must precede npm install");
});

test("generated systemd units are complete and current", () => {
  assert.match(SRC, /\[Unit\]/);
  assert.match(SRC, /\[Service\]/);
  assert.match(SRC, /\[Install\]/);
  assert.match(SRC, /WantedBy=multi-user\.target/);
  assert.match(SRC, /EnvironmentFile=\$\{ENV_FILE\}/, "units must consume the generated env file");
  assert.match(SRC, /Environment=PORT=\$\{BACKEND_PORT\}/, "backend port must come from the env file");
  assert.match(SRC, /Environment=HOSTNAME=127\.0\.0\.1/, "backend must bind loopback only");
  assert.match(SRC, /-gateway-port/, "engine must be started with the gateway port");
  assert.match(SRC, /-proxy-port/, "engine must be started with the public proxy port");
  assert.ok(SRC.includes("service.d/override.conf"), "must manage the backend drop-in");
  assert.ok(SRC.includes("${SERVICE_MAIN}.service.d"), "drop-in path must derive from the service name");
  assert.match(SRC, /Restart=on-failure/);
  assert.match(SRC, /Restart=always/);
});

test("engine staging skips self-copy during an in-place upgrade", () => {
  const stage = SRC.slice(SRC.indexOf('step "Staging install directory"'), SRC.indexOf('step "Preparing directories"'));
  assert.match(stage, /\[ "\$REPO_DIR" != "\$INSTALL_DIR" \]/, "in-place source/install path must skip same-file cp");
});

test("upgrade rollback restores the engine binary and preserves the failing exit code", () => {
  assert.ok(SRC.includes('backup_paths engine "$INSTALL_DIR/hybrid-engine/bin/router-engine"'));
  assert.ok(SRC.includes('cp -a "$BACKUP_DIR/engine/router-engine" "$INSTALL_DIR/hybrid-engine/bin/router-engine"'));
  assert.match(SRC, /rollback "\$rc"/, "on_error must pass the original failure code into rollback");
});

test("release staging is atomic and keeps a rollback copy", () => {
  assert.ok(SRC.includes("\.staging.$$"), "staging dir must be pid-scoped");
  assert.ok(SRC.includes("\.previous"), "previous release must be retained");
  const stage = SRC.indexOf("STAGE_DIR=");
  const swap = SRC.indexOf("mv \"$STAGE_DIR\" \"$RELEASE_DIR\"");
  assert.ok(stage > 0 && swap > 0 && stage < swap, "release must be staged before swap");
});

test("secrets survive an upgrade", () => {
  assert.match(SRC, /^preserve_secret\(\)/m, "must have a secret-preservation helper");
  for (const key of ["JWT_SECRET", "MACHINE_ID_SALT", "API_KEY_SECRET", "DATABASE_URL"]) {
    assert.ok(SRC.includes(`preserve_secret ${key}`), `must preserve ${key} across upgrades`);
  }
});

test("legacy units are backed up before removal, never silently deleted", () => {
  assert.match(SRC, /^retire_legacy_unit\(\)/m);
  const fn = SRC.slice(SRC.indexOf("retire_legacy_unit()"));
  assert.match(fn.slice(0, 800), /BACKUP_DIR\/retired/, "must copy the unit into the backup first");
});

test("health checks cover every public surface and can trigger rollback", () => {
  for (const url of ["/api/health", "/login", "/usage-check", "/health"]) {
    assert.ok(SRC.includes(url), `health checks must cover ${url}`);
  }
  assert.match(SRC, /Health check failed — rolling back/, "an unhealthy upgrade must roll back");
});
