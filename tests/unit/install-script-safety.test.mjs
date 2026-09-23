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

test("uninstall restores a displaced legacy main unit after removing managed units", () => {
  const sb = sandbox();
  try {
    const bin = path.join(sb.dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, "systemctl"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    mkdirSync(sb.env.SYSTEMD_UNIT_DIR, { recursive: true });
    mkdirSync(sb.env.STATE_DIR, { recursive: true });
    writeFileSync(path.join(sb.env.SYSTEMD_UNIT_DIR, "9router.service"), "managed\n");
    writeFileSync(path.join(sb.env.STATE_DIR, "legacy-9router.unit"), "legacy\n");

    const r = runInstaller(["--uninstall", "--yes"], {
      ...sb.env,
      PATH: `${bin}:${sb.env.PATH}`,
      WORKER_ENV_DIR: path.join(sb.dir, "worker-env"),
    });

    assert.equal(r.code, 0, r.out);
    const restored = path.join(sb.env.SYSTEMD_UNIT_DIR, "9router.service");
    assert.ok(existsSync(restored), "legacy main unit must remain installed");
    assert.equal(readFileSync(restored, "utf8"), "legacy\n");
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

test("configured listener and worker ports must be mutually distinct", () => {
  const sb = sandbox();
  try {
    const duplicateMain = runInstaller(["--dry-run"], { ...sb.env, GATEWAY_PORT: "20128", LIMITER_PORT: "20128" });
    assert.notEqual(duplicateMain.code, 0);
    assert.match(duplicateMain.out, /ports must be distinct/i);

    const workerCollision = runInstaller(["--dry-run"], {
      ...sb.env,
      BACKEND_PORT: "20127",
      PUBLIC_PORT: "20131",
      API_WORKERS: "2",
      DATABASE_URL: "postgres://u:p@127.0.0.1:5432/9router",
    });
    assert.notEqual(workerCollision.code, 0);
    assert.match(workerCollision.out, /ports must be distinct/i);
  } finally {
    sb.cleanup();
  }
});

test("DATABASE_URL cannot inject another EnvironmentFile assignment", () => {
  const sb = sandbox();
  try {
    const r = runInstaller(["--dry-run"], {
      ...sb.env,
      DATABASE_URL: "postgres://u:p@127.0.0.1:5432/db\nWORKER_ROLE=api",
    });
    assert.notEqual(r.code, 0);
    assert.match(r.out, /DATABASE_URL must be a single line/);
  } finally {
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
  const failFn = SRC.slice(SRC.indexOf("fail()"), SRC.indexOf("read_reply()"));
  assert.match(failFn, /ROLLBACK_ARMED.*rollback 1/s, "fail() must not bypass rollback after mutation");
});

test("fail() invokes rollback exactly once after mutation is armed", () => {
  const failFn = SRC.slice(SRC.indexOf("fail()"), SRC.indexOf("read_reply()"));
  const script = `${failFn}\nROLLBACK_ARMED=1\nC_RED= C_BOLD= C_RESET=\nrollback() { echo rollback >> "$LOG"; ROLLBACK_ARMED=0; exit "$1"; }\nfail simulated`;
  const dir = mkdtempSync(path.join(tmpdir(), "9router-fail-"));
  const log = path.join(dir, "calls.log");
  try {
    const r = spawnSync("bash", ["-c", script], { env: { ...process.env, LOG: log }, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.equal(readFileSync(log, "utf8"), "rollback\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test("generated systemd heredocs never execute comment text as shell commands", () => {
  const generatedUnits = SRC.slice(
    SRC.indexOf('cat > "${SYSTEMD_UNIT_DIR}/${SERVICE_ENGINE}.service"'),
    SRC.indexOf('ok "API worker units installed'),
  );
  assert.doesNotMatch(
    generatedUnits,
    /`[^`]+`/,
    "unquoted heredocs expand backticks, so comments inside generated units must not contain command substitutions",
  );
});

test("generated Node units treat a drained SIGTERM exit as successful", () => {
  const engine = SRC.slice(
    SRC.indexOf('cat > "${SYSTEMD_UNIT_DIR}/${SERVICE_ENGINE}.service"'),
    SRC.indexOf('cat > "${SYSTEMD_UNIT_DIR}/${SERVICE_MAIN}.service"'),
  );
  const main = SRC.slice(
    SRC.indexOf('cat > "${SYSTEMD_UNIT_DIR}/${SERVICE_MAIN}.service"'),
    SRC.indexOf('# Drop-in keeps port/host overrides'),
  );
  const worker = SRC.slice(
    SRC.indexOf('cat > "${SYSTEMD_UNIT_DIR}/${SERVICE_WORKER}@.service"'),
    SRC.indexOf('cat > "${SYSTEMD_UNIT_DIR}/${SERVICE_WORKER_ENV}@.service"'),
  );
  assert.match(main, /^SuccessExitStatus=143$/m, "control SIGTERM drain must not leave a failed unit");
  assert.match(worker, /^SuccessExitStatus=143$/m, "worker SIGTERM drain must not leave a failed unit");
  assert.doesNotMatch(engine, /^SuccessExitStatus=/m, "native Go shutdown must keep its own exit semantics");
});

test("engine staging skips self-copy during an in-place upgrade", () => {
  const stage = SRC.slice(SRC.indexOf('step "Staging install directory"'), SRC.indexOf('step "Preparing directories"'));
  assert.match(stage, /\[ "\$REPO_DIR" != "\$INSTALL_DIR" \]/, "in-place source/install path must skip same-file cp");
});

test("shipped engine binary supports the native API worker flag", () => {
  const engine = path.join(REPO_ROOT, "hybrid-engine/bin/router-engine");
  const r = spawnSync(engine, ["-h"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(`${r.stdout || ""}${r.stderr || ""}`, /-api-workers\b/);
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
  assert.ok(
    !SRC.includes('mkdir -p "$RELEASE_DIR" "$DATA_DIR"'),
    "fresh install must not pre-create RELEASE_DIR and nest the staged release inside it",
  );
});

test("secrets survive an upgrade", () => {
  assert.match(SRC, /^preserve_secret\(\)/m, "must have a secret-preservation helper");
  for (const key of ["JWT_SECRET", "MACHINE_ID_SALT", "API_KEY_SECRET", "DATABASE_URL"]) {
    assert.ok(SRC.includes(`preserve_secret ${key}`), `must preserve ${key} across upgrades`);
  }
});

test("systemd unit discovery does not use grep -q behind pipefail", () => {
  assert.doesNotMatch(
    SRC,
    /systemctl list-unit-files[^\n]*\|\s*grep -q/,
    "grep -q exits early and can turn a successful systemctl producer into SIGPIPE status 141 under pipefail",
  );
});

test("legacy units are backed up before removal, never silently deleted", () => {
  assert.match(SRC, /^retire_legacy_unit\(\)/m);
  const fn = SRC.slice(SRC.indexOf("retire_legacy_unit()"));
  assert.match(fn.slice(0, 800), /BACKUP_DIR\/retired/, "must copy the unit into the backup first");
});

test("native systemd installer keeps one control worker by default", () => {
  assert.match(SRC, /WORKER_ROLE=control/, "native service must declare control role");
  assert.match(SRC, /API_WORKERS=1/, "native service must remain single-process by default");
  assert.match(SRC, /API_WORKERS=1[\s\S]{0,300}EOF/, "generated env must pin native default worker count");
  assert.match(SRC, /WORKER_ROLE=control[\s\S]{0,300}EOF/, "generated env must pin native control role");
});

test("native systemd engine remains single-backend unless explicitly extended", () => {
  const engine = SRC.slice(SRC.indexOf('cat > "${SYSTEMD_UNIT_DIR}/${SERVICE_ENGINE}.service"'), SRC.indexOf('cat > "${SYSTEMD_UNIT_DIR}/${SERVICE_MAIN}.service"'));
  assert.doesNotMatch(engine, /-api-workers/, "native default must not invent API worker ports");
});

test("native PostgreSQL worker supervisor derives loopback workers and gateway URLs", () => {
  assert.match(SRC, /9router-worker@\.service/, "must install worker template");
  assert.match(SRC, /9router-workers\.target/, "must install worker target");
  assert.match(SRC, /API_WORKER_URLS/, "must generate gateway worker URLs");
  assert.match(SRC, /BACKEND_PORT \+ 3 \+ i|BACKEND_PORT\+3\+i/, "worker index i must map to backend + 4, matching Docker");
  // The api role cannot come from `Environment=WORKER_ROLE=api`: systemd lets
  // EnvironmentFile values win, so the worker role is written per instance by
  // the staged topology helper instead.
  assert.match(SRC, /scripts\/systemd-worker-topology\.sh/, "must stage the per-instance env helper");
  assert.match(SRC, /EnvironmentFile=-\$\{WORKER_ENV_DIR\}\/%i\.env/, "worker must read its private instance env last");
  assert.match(SRC, /DATABASE_URL.*postgres|DB_TYPE.*postgres/i, "worker path must require PostgreSQL");
  assert.match(SRC, /systemctl (enable|start|restart).*\$SERVICE_WORKERS_TARGET/, "installer must manage worker target");
  assert.match(SRC, /API_WORKERS=1[\s\S]{0,300}no worker|worker.*API_WORKERS.*1|API_WORKERS.*1.*worker/i, "default must keep one control process");
});

test("native worker supervisor has ordered lifecycle and loopback health checks", () => {
  assert.match(SRC, /After=.*(\$\{SERVICE_MAIN\}|9router)\.service/);
  assert.match(SRC, /Requires=.*(\$\{SERVICE_MAIN\}|9router)\.service/);
  assert.match(SRC, /-api-workers/);
  assert.match(SRC, /20131|BACKEND_PORT \+ 4\b|BACKEND_PORT \+ 3 \+ i/);
  assert.match(SRC, /worker.*api.*health|api.*worker.*health/i);
  const engine = SRC.slice(SRC.indexOf('cat > "${SYSTEMD_UNIT_DIR}/${SERVICE_ENGINE}.service"'), SRC.indexOf('cat > "${SYSTEMD_UNIT_DIR}/${SERVICE_MAIN}.service"'));
  assert.match(engine, /After=.*\$\{SERVICE_WORKERS_TARGET\}/, "on reboot the gateway must wait for an enabled worker target");
});

test("worker instance env overrides shared control env and is regenerated before start", () => {
  const worker = SRC.slice(
    SRC.indexOf('cat > "${SYSTEMD_UNIT_DIR}/${SERVICE_WORKER}@.service"'),
    SRC.indexOf('cat > "${SYSTEMD_UNIT_DIR}/${SERVICE_WORKERS_TARGET}"'),
  );
  const shared = worker.indexOf("EnvironmentFile=${ENV_FILE}");
  const instance = worker.indexOf("EnvironmentFile=-${WORKER_ENV_DIR}/%i.env");
  assert.ok(shared >= 0 && instance > shared, "later instance EnvironmentFile must override WORKER_ROLE=control");
  assert.doesNotMatch(worker, /ExecStartPre=/, "worker must not generate its own EnvironmentFile in the same unit state");
  assert.match(worker, /Requires=.*\$\{SERVICE_WORKER_ENV\}@%i\.service/, "worker must require the env generator");
  assert.match(worker, /After=.*\$\{SERVICE_WORKER_ENV\}@%i\.service/, "worker must start after the env generator completes");
  assert.doesNotMatch(worker, /^Environment=WORKER_ROLE=/m, "Environment= cannot override EnvironmentFile values");
  assert.match(SRC, /cp -a .*systemd-worker-topology\.sh/, "reboot path needs an installed topology helper");
  assert.doesNotMatch(worker, /CONTROL_PLANE_ORDER:.*date/, "generated unit must be deterministic");
  const generator = SRC.slice(
    SRC.indexOf('cat > "${SYSTEMD_UNIT_DIR}/${SERVICE_WORKER_ENV}@.service"'),
    SRC.indexOf('cat > "${SYSTEMD_UNIT_DIR}/${SERVICE_WORKERS_TARGET}"'),
  );
  assert.match(generator, /Type=oneshot/);
  assert.match(generator, /ExecStart=.*systemd-worker-topology\.sh write-one/);
});

test("backup and rollback preserve actual worker templates and remove failed topology", () => {
  assert.doesNotMatch(SRC, /systemctl cat "\$worker_unit"/, "snapshotting instantiated cat output creates bogus explicit units");
  assert.match(SRC, /\$\{SERVICE_WORKER\}@\.service/, "worker template must be backed up directly");
  assert.match(SRC, /\$\{SERVICE_WORKER_ENV\}@\.service/, "worker env template must be backed up directly");
  const rollback = SRC.slice(SRC.indexOf("rollback()"), SRC.indexOf("on_error()"));
  assert.match(rollback, /stop_all_worker_instances/, "rollback must stop and disable failed worker topology");
  assert.match(rollback, /restore_worker_topology/, "rollback must restore the prior worker count");
});

test("engine API worker arguments are omitted atomically for the single-control default", () => {
  assert.match(SRC, /API_WORKER_ARGS=/, "env must carry an optional complete argument list");
  assert.match(SRC, /\$API_WORKER_ARGS/, "ExecStart must expand the optional argument list");
  assert.doesNotMatch(SRC, /API_WORKER_ENGINE_FLAG/, "comment-prefixing one continued ExecStart line is unsafe");
});

test("upgrade preserves installed PostgreSQL worker topology unless caller overrides it", () => {
  const sb = sandbox();
  try {
    mkdirSync(sb.env.RELEASE_DIR, { recursive: true });
    writeFileSync(sb.env.ENV_FILE, "DATABASE_URL=postgres://u:p@127.0.0.1:5432/9router\nAPI_WORKERS=3\n");
    const inheritedEnv = { ...sb.env };
    delete inheritedEnv.API_WORKERS;
    delete inheritedEnv.DATABASE_URL;
    const inherited = runInstaller(["--upgrade", "--dry-run"], inheritedEnv);
    assert.equal(inherited.code, 0, inherited.out);
    assert.match(inherited.out, /api workers\s+3 total Node process/);

    const overridden = runInstaller(["--upgrade", "--dry-run"], { ...inheritedEnv, API_WORKERS: "1" });
    assert.equal(overridden.code, 0, overridden.out);
    assert.match(overridden.out, /api workers\s+1 total Node process/);

    writeFileSync(sb.env.ENV_FILE, "DB_TYPE=postgres\nAPI_WORKERS=2\n");
    const dbTypeOnly = runInstaller(["--upgrade", "--dry-run"], inheritedEnv);
    assert.equal(dbTypeOnly.code, 0, dbTypeOnly.out);
    assert.match(dbTypeOnly.out, /api workers\s+2 total Node process/);
  } finally {
    sb.cleanup();
  }
});

test("health checks cover every public surface and can trigger rollback", () => {
  for (const url of ["/api/health", "/login", "/usage-check", "/health"]) {
    assert.ok(SRC.includes(url), `health checks must cover ${url}`);
  }
  assert.match(SRC, /Health check failed — rolling back/, "an unhealthy upgrade must roll back");
});

test("control readiness waits on /api/ready, not liveness", () => {
  assert.match(SRC, /step "Waiting for control process readiness"/, "must have a control readiness step");
  const control = SRC.slice(SRC.indexOf("Waiting for control process readiness"), SRC.indexOf("Waiting for API worker readiness"));
  assert.match(control, /\/api\/ready/, "control readiness loop must probe /api/ready");
  assert.match(control, /"ready":true/, "control readiness must require the ready payload");
  assert.doesNotMatch(control, /\/api\/health/, "control readiness must not treat liveness as ready");
});

test("worker readiness waits on /api/ready", () => {
  const worker = SRC.slice(SRC.indexOf("check_worker_health()"), SRC.indexOf("resolve_install_mode()"));
  assert.match(worker, /\/api\/ready/, "worker health probe must use /api/ready");
  assert.match(worker, /"ready":true/, "worker readiness must require the ready payload");
  assert.doesNotMatch(worker, /\/api\/health/, "worker readiness must not probe liveness");
});

test("final readiness checks use /api/ready while public liveness keeps /api/health", () => {
  assert.match(SRC, /Hybrid engine readiness/, "must keep the engine readiness check");
  const final = SRC.slice(SRC.indexOf("Verifying health (control, workers, gateway)"));
  assert.match(final, /\/api\/ready/, "final control/worker checks must use /api/ready");
  assert.match(SRC, /"http:\/\/localhost:\$\{GATEWAY_PORT\}\/api\/health"/, "public gateway liveness smoke must remain /api/health");
});
