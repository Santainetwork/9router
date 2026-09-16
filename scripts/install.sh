#!/usr/bin/env bash
#
# 9Router SantaiNetwork Edition — One-Line Installer
# ==================================================
#
# Installs and runs the complete hardened 9Router stack:
#   • Golang Master Gateway   :20128  (front-door proxy + gating)
#   • Golang Limiter RPC      :20129  (concurrency semaphore)
#   • Golang Public Proxy     :20140  (usage-check portal)
#   • Next.js backend         :20127  (internal loopback only)
#
# Usage:
#   # Interactive install (asks for a dashboard password)
#   sudo bash scripts/install.sh
#
#   # Non-interactive / automated
#   sudo ROUTER_PASSWORD="your-password" bash scripts/install.sh --yes
#
#   # A specific release directory / port layout
#   sudo INSTALL_DIR=/opt/9router bash scripts/install.sh --yes
#
#   # Upgrade an existing install (backup first, auto-rollback on failure)
#   sudo bash scripts/install.sh --upgrade
#
#   # Reinstall over an existing install (destructive, takes a backup first)
#   sudo bash scripts/install.sh --force-reinstall
#
#   # Inspect what would happen, changing nothing
#   sudo bash scripts/install.sh --dry-run
#
#   # Roll a failed upgrade back manually
#   sudo bash scripts/install.sh --restore-backup /var/backups/9router/<stamp>-upgrade
#
#   # Uninstall (removes units + config; keeps data unless --purge)
#   sudo bash scripts/install.sh --uninstall
#   sudo bash scripts/install.sh --uninstall --purge
#
# Requirements: Linux + systemd, Node.js >= 20, Go >= 1.21 (build only),
# at least 2 GB RAM and 3 GB free disk. Validated on Debian 12/13 and Ubuntu 22.04+.
#
# Safety model:
#   • A fresh install onto a machine with NO existing 9Router install proceeds.
#   • A fresh install onto a machine that ALREADY has 9Router units/data REFUSES
#     and tells you which of --upgrade / --uninstall / --force-reinstall to use.
#   • --upgrade and --force-reinstall back up config, units and release first, and
#     automatically roll back if any post-install health check fails.
#   • --uninstall requires typed confirmation (or an explicit --yes).
#   • Destructive steps never auto-confirm from piped stdin.
#   • Every step is idempotent: re-running converges to the same state.
#
set -euo pipefail

# ─── Configuration (env-overridable) ─────────────────────────────────────────
REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
INSTALL_DIR="${INSTALL_DIR:-/opt/9router}"
RELEASE_DIR="${RELEASE_DIR:-/opt/9router-release}"
DATA_DIR="${DATA_DIR:-/var/lib/9router}"

GATEWAY_PORT="${GATEWAY_PORT:-20128}"
LIMITER_PORT="${LIMITER_PORT:-20129}"
BACKEND_PORT="${BACKEND_PORT:-20127}"
PUBLIC_PORT="${PUBLIC_PORT:-20140}"

SERVICE_MAIN="9router"
SERVICE_ENGINE="9router-hybrid-engine"

ASSUME_YES=0
DO_UNINSTALL=0
DO_PURGE=0
SKIP_BUILD=0
UPGRADE=0
DRY_RUN=0
FORCE_REINSTALL=0
RESTORE_FROM=""
INSTALL_MODE="install"

CONFIRM_PHRASE="yes-9router"

while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes)          ASSUME_YES=1 ;;
    --upgrade)         UPGRADE=1 ;;
    --force-reinstall) FORCE_REINSTALL=1 ;;
    --restore-backup)  shift; RESTORE_FROM="${1:-}"
                       if [ -z "$RESTORE_FROM" ]; then echo "--restore-backup requires a backup directory" >&2; exit 2; fi ;;
    --uninstall)       DO_UNINSTALL=1 ;;
    --purge)           DO_PURGE=1 ;;
    --skip-build)      SKIP_BUILD=1 ;;
    --dry-run)         DRY_RUN=1 ;;
    -h|--help)         sed -n '2,48p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

ENV_FILE="${ENV_FILE:-/etc/9router.env}"

# ─── Output helpers ──────────────────────────────────────────────────────────
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_CYAN=$'\033[36m'
else
  C_RESET=""; C_BOLD=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_CYAN=""
fi

step()  { printf '\n%s==> %s%s\n' "$C_BOLD$C_CYAN" "$*" "$C_RESET"; }
info()  { printf '    %s\n' "$*"; }
ok()    { printf '    %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn()  { printf '    %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
fail()  { printf '\n%s✗ %s%s\n' "$C_RED$C_BOLD" "$*" "$C_RESET" >&2; exit 1; }

read_reply() { # read_reply <timeout> <varname> — prefer the controlling tty
  local t="$1" __out="$2" __v=""
  # Only touch /dev/tty when there is one; otherwise fall back to stdin.
  if [ -e /dev/tty ] && [ -r /dev/tty ] && [ -w /dev/tty ] 2>/dev/null; then
    if read -r -t "$t" __v 2>/dev/null </dev/tty; then printf -v "$__out" '%s' "$__v"; return 0; fi
    printf -v "$__out" '%s' "$__v"; return 1
  fi
  if read -r -t "$t" __v; then printf -v "$__out" '%s' "$__v"; return 0; fi
  printf -v "$__out" '%s' "$__v"; return 1
}

confirm() {
  # confirm "question" -> 0 if yes.
  # Explicit consent required: --yes, or an interactive terminal. A piped/heredoc
  # stdin does NOT auto-confirm a destructive action.
  [ "${ASSUME_YES:-0}" = 1 ] && return 0
  printf '    %s [y/N] ' "$1"
  local reply=""
  read_reply 120 reply || reply=""
  case "$reply" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

require_typed_confirmation() {
  # require_typed_confirmation "question" "PHRASE" -> 0 only on the exact phrase.
  [ "${ASSUME_YES:-0}" = 1 ] && return 0
  printf '    %s\n' "$1"
  printf '    Type exactly "%s" to continue: ' "$2"
  local reply=""
  read_reply 180 reply || reply=""
  [ "$reply" = "$2" ] || return 1
  return 0
}

run() {
  # run <cmd...> — because the installer never executes when --dry-run is set.
  if [ "$DRY_RUN" = 1 ]; then printf '    [dry-run] %s\n' "$*"; return 0; fi
  "$@"
}

need_root() {
  [ "$(id -u)" = "0" ] || fail "This installer must run as root. Try: sudo bash $0"
}

# ─── Safety helpers ──────────────────────────────────────────────────────────
SYSTEMD_UNIT_DIR="${SYSTEMD_UNIT_DIR:-/etc/systemd/system}"

unit_installed() { # unit base name (no .service)
  [ -f "${SYSTEMD_UNIT_DIR}/$1.service" ] && return 0
  # Test/sandbox escape hatch: never consult the host's unit list.
  [ "${SKIP_SYSTEMD_UNIT_PROBE:-0}" = 1 ] && return 1
  systemctl list-unit-files --no-legend --no-pager 2>/dev/null | grep -q "^$1\.service"
}

existing_install_detected() {
  local d
  for d in "$INSTALL_DIR" "$RELEASE_DIR" "$DATA_DIR/.9router/db/data.sqlite" "$ENV_FILE"; do
    [ -e "$d" ] && return 0
  done
  unit_installed "$SERVICE_MAIN" && return 0
  unit_installed "$SERVICE_ENGINE" && return 0
  return 1
}

port_owner() { # port -> process name holding the LISTEN socket ("" when free)
  # Column-agnostic: match the local-address field, which is always ":PORT".
  ss -tlnpH 2>/dev/null | awk -v p=":$1" '
    { for (i = 1; i <= NF; i++) if ($i ~ (p "$")) { print $0; exit } }' \
    | sed -n 's/.*users:((\"\([^\"]*\)\".*/\1/p'
}

port_is_ours() { # port -> 0 only for the processes 9Router itself runs
  # Deliberately narrow: a generic `node` listener is NOT ours, because treating
  # it as ours would let us overwrite a foreign service on our port.
  case "$(port_owner "$1")" in
    "" )                    return 1 ;;
    router-engine)          return 0 ;;
    next-server*)           return 0 ;;
    9router|9router-*)      return 0 ;;
    custom-server*)         return 0 ;;
    *)                      return 1 ;;
  esac
}

require_free_ports() { # hard-fail when a foreign process holds one of our ports
  local p owner bad=0
  for p in "$@"; do
    owner="$(port_owner "$p")"
    if [ -z "$owner" ]; then
      info "Port $p free"
      continue
    fi
    if port_is_ours "$p"; then
      info "Port $p held by an existing 9Router process (will be replaced)"
      continue
    fi
    warn "Port $p is already in use by: $owner"
    bad=1
  done
  if [ "$bad" != 0 ]; then
    fail "Port conflict detected. Stop the processes above, or override GATEWAY_PORT/LIMITER_PORT/BACKEND_PORT/PUBLIC_PORT."
  fi
}

backup_paths() { # backup_paths <tag> <path...>
  local tag="$1"; shift
  local p base dest
  for p in "$@"; do
    [ -e "$p" ] || continue
    base="$(basename "$p")"
    dest="${BACKUP_DIR}/${tag}/${base}"
    if [ "$DRY_RUN" = 1 ]; then printf '    [dry-run] backup %s -> %s\n' "$p" "$dest"; continue; fi
    mkdir -p "$(dirname "$dest")"
    cp -a "$p" "$dest"
  done
}

snapshot_systemd_units() {
  # Persist live units so rollback (and --restore-backup) can bring them back.
  if [ "$DRY_RUN" = 1 ]; then printf '    [dry-run] snapshot systemd units -> %s\n' "$BACKUP_DIR/systemd"; return 0; fi
  mkdir -p "$BACKUP_DIR/systemd"
  local u
  for u in "$SERVICE_ENGINE" "$SERVICE_MAIN" 9router-public-proxy 9router-rl; do
    systemctl cat "$u" > "$BACKUP_DIR/systemd/$u.service" 2>/dev/null || true
    [ -s "$BACKUP_DIR/systemd/$u.service" ] || rm -f "$BACKUP_DIR/systemd/$u.service"
  done
}

STATE_DIR="${STATE_DIR:-/var/lib/9router-installer}"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/9router}"
BACKUP_DIR=""
ROLLBACK_ARMED=0

rollback() {
  local rc=$?
  if [ "$ROLLBACK_ARMED" != 1 ]; then exit "$rc"; fi
  ROLLBACK_ARMED=0
  printf '\n%s!! install failed (exit %s) — rolling back%s\n' "$C_RED$C_BOLD" "$rc" "$C_RESET" >&2
  if [ -z "$BACKUP_DIR" ] || [ ! -d "$BACKUP_DIR" ]; then
    RESCUE="${RELEASE_DIR}.previous"
    if [ -d "$RESCUE" ]; then
      printf '   no backup dir; restoring %s from %s\n' "$RELEASE_DIR" "$RESCUE" >&2
      rm -rf "${RELEASE_DIR}.failed"
      [ -d "$RELEASE_DIR" ] && mv "$RELEASE_DIR" "${RELEASE_DIR}.failed"
      mv "$RESCUE" "$RELEASE_DIR"
      systemctl restart "$SERVICE_MAIN" 2>/dev/null || true
      systemctl restart "$SERVICE_ENGINE" 2>/dev/null || true
    else
      printf '   no backup dir and no previous release; nothing to restore\n' >&2
    fi
    exit "$rc"
  fi

  local p base
  if [ -d "$BACKUP_DIR/systemd" ]; then
    for p in "$BACKUP_DIR"/systemd/*.service; do
      [ -e "$p" ] || continue
      base="$(basename "$p")"
      cp -a "$p" "${SYSTEMD_UNIT_DIR}/$base" 2>/dev/null && printf '   restored unit %s\n' "$base" >&2
    done
  fi
  if [ -f "$BACKUP_DIR/env/9router.env" ]; then
    cp -a "$BACKUP_DIR/env/9router.env" "$ENV_FILE" 2>/dev/null && printf '   restored %s\n' "$ENV_FILE" >&2
    chmod 600 "$ENV_FILE" 2>/dev/null || true
  fi
  local src="$BACKUP_DIR/release-live"
  [ -d "$src" ] || src=""
  if [ -n "$src" ]; then
    rm -rf "${RELEASE_DIR}.restoring"
    cp -a "$src" "${RELEASE_DIR}.restoring" 2>/dev/null || true
    if [ -d "${RELEASE_DIR}.restoring" ]; then
      rm -rf "${RELEASE_DIR}.failed"
      [ -d "$RELEASE_DIR" ] && mv "$RELEASE_DIR" "${RELEASE_DIR}.failed"
      mv "${RELEASE_DIR}.restoring" "$RELEASE_DIR"
      printf '   restored release dir\n' >&2
    fi
  elif [ -d "${RELEASE_DIR}.previous" ]; then
    rm -rf "${RELEASE_DIR}.failed"
    [ -d "$RELEASE_DIR" ] && mv "$RELEASE_DIR" "${RELEASE_DIR}.failed"
    mv "${RELEASE_DIR}.previous" "$RELEASE_DIR"
    printf '   restored release dir from .previous\n' >&2
  fi

  systemctl daemon-reload 2>/dev/null || true
  systemctl restart "$SERVICE_MAIN" 2>/dev/null || true
  systemctl restart "$SERVICE_ENGINE" 2>/dev/null || true
  printf '   rollback complete. Backup retained at %s\n' "$BACKUP_DIR" >&2
  exit "$rc"
}

on_error() {
  local rc=$?
  [ "$rc" = 0 ] && return 0
  printf '\n%s✗ aborted at line %s (exit %s)%s\n' "$C_RED$C_BOLD" "${BASH_LINENO[0]:-?}" "$rc" "$C_RESET" >&2
  rollback
  exit "$rc"
}

install_error_traps() {
  # set -E so the ERR trap also fires inside functions and subshells.
  set -E
  trap on_error ERR
}

cleanup_stage() {
  local d
  for d in "${RELEASE_DIR}.staging."*; do
    [ -e "$d" ] || continue
    printf '    removing leftover staging dir %s\n' "$d"
    rm -rf "$d"
  done
}

# ─── Install-mode resolution ─────────────────────────────────────────────────
resolve_install_mode() {
  if [ -n "$RESTORE_FROM" ]; then
    INSTALL_MODE="restore"
    return 0
  fi
  if [ "$FORCE_REINSTALL" = 1 ]; then
    INSTALL_MODE="reinstall"
    if existing_install_detected; then
      require_typed_confirmation \
        "--force-reinstall OVERWRITES the release dir $RELEASE_DIR and replaces its units. Data at $DATA_DIR is preserved and a backup is taken first." \
        "$CONFIRM_PHRASE" || fail "Reinstall cancelled (confirmation not given)."
    else
      warn "--force-reinstall requested but no existing install was found; continuing as a fresh install."
      INSTALL_MODE="install"
    fi
    return 0
  fi
  if [ "$UPGRADE" = 1 ]; then
    if existing_install_detected; then
      INSTALL_MODE="upgrade"
    else
      warn "--upgrade requested but no existing install was found; continuing as a fresh install."
      INSTALL_MODE="install"
    fi
    return 0
  fi
  if existing_install_detected; then
    INSTALL_MODE="blocked"
    printf '\n%s✗ An existing 9Router installation was detected.%s\n\n' "$C_RED$C_BOLD" "$C_RESET" >&2
    printf '    Detected one or more of:\n' >&2
    [ -e "$ENV_FILE" ]               && printf '      • config   %s\n' "$ENV_FILE" >&2
    [ -e "$RELEASE_DIR" ]            && printf '      • release  %s\n' "$RELEASE_DIR" >&2
    [ -e "$DATA_DIR" ]               && printf '      • data     %s\n' "$DATA_DIR" >&2
    unit_installed "$SERVICE_MAIN"   && printf '      • unit     %s.service\n' "$SERVICE_MAIN" >&2
    unit_installed "$SERVICE_ENGINE" && printf '      • unit     %s.service\n' "$SERVICE_ENGINE" >&2
    printf '\n    Refusing to overwrite anything automatically.\n\n' >&2
    printf '    Upgrade in place (backup first, automatic rollback on failure):\n' >&2
    printf '      sudo bash %s --upgrade\n\n' "$0" >&2
    printf '    Remove the existing install:\n' >&2
    printf '      sudo bash %s --uninstall          # keeps data\n' "$0" >&2
    printf '      sudo bash %s --uninstall --purge  # deletes data\n\n' "$0" >&2
    printf '    Overwrite it in place (destructive; backup still taken):\n' >&2
    printf '      sudo bash %s --force-reinstall\n\n' "$0" >&2
    exit 3
  fi
  INSTALL_MODE="install"
}

# ─── Restore path ────────────────────────────────────────────────────────────
if [ -n "$RESTORE_FROM" ]; then
  need_root
  step "Restoring from backup: $RESTORE_FROM"
  [ -d "$RESTORE_FROM" ] || fail "Backup directory not found: $RESTORE_FROM"
  [ -f "$RESTORE_FROM/env/9router.env" ] || [ -d "$RESTORE_FROM/release-live" ] || \
    warn "Backup looks incomplete (no env and no release snapshot)"

  if ! require_typed_confirmation \
      "This REPLACES the live config, systemd units and release dir with the contents of $RESTORE_FROM, then restarts the services." \
      "$CONFIRM_PHRASE"; then
    fail "Restore cancelled (confirmation not given)."
  fi

  BACKUP_DIR="$RESTORE_FROM"

  if [ -f "$BACKUP_DIR/env/9router.env" ]; then
    info "restoring $ENV_FILE"
    cp -a "$BACKUP_DIR/env/9router.env" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
  else
    warn "no env snapshot in $BACKUP_DIR/env — keeping the current $ENV_FILE"
  fi

  RESTORED_UNIT=0
  for f in "$BACKUP_DIR"/systemd/*.service; do
    [ -s "$f" ] || continue
    base="$(basename "$f")"
    cp -a "$f" "${SYSTEMD_UNIT_DIR}/$base"
    info "restored unit $base"
    RESTORED_UNIT=1
  done
  [ "$RESTORED_UNIT" = 1 ] || warn "no systemd units in $BACKUP_DIR/systemd"

  RESTORED_RELEASE=0
  for src in "$BACKUP_DIR/release-live" "$BACKUP_DIR/release"; do
    if [ -d "$src" ] && [ -n "$(ls -A "$src" 2>/dev/null)" ]; then
      rm -rf "${RELEASE_DIR}.restoring"
      cp -a "$src" "${RELEASE_DIR}.restoring"
      rm -rf "${RELEASE_DIR}.failed"
      [ -d "$RELEASE_DIR" ] && mv "$RELEASE_DIR" "${RELEASE_DIR}.failed"
      mv "${RELEASE_DIR}.restoring" "$RELEASE_DIR"
      info "restored release dir $RELEASE_DIR (previous kept at ${RELEASE_DIR}.failed)"
      RESTORED_RELEASE=1
      break
    fi
  done
  [ "$RESTORED_RELEASE" = 1 ] || warn "no release snapshot in $BACKUP_DIR — release dir left untouched"

  systemctl daemon-reload
  systemctl restart "$SERVICE_ENGINE" 2>/dev/null || true
  systemctl restart "$SERVICE_MAIN" 2>/dev/null || systemctl start "$SERVICE_MAIN" 2>/dev/null || true
  sleep 3
  if curl -fsS --max-time 5 "http://127.0.0.1:${BACKEND_PORT}/api/health" 2>/dev/null | grep -q '"ok":true'; then
    ok "Restore complete and backend healthy"
  else
    warn "Restore applied, but the backend is not reporting healthy yet."
    warn "Inspect: journalctl -u $SERVICE_MAIN -n 50"
  fi
  printf '\n%sRestore finished.%s\n' "$C_GREEN$C_BOLD" "$C_RESET"
  exit 0
fi

# ─── Uninstall path ──────────────────────────────────────────────────────────
if [ "$DO_UNINSTALL" = 1 ]; then
  need_root
  step "Uninstalling 9Router services"

  if [ "$DRY_RUN" = 1 ]; then
    info "[dry-run] would remove units: $SERVICE_ENGINE $SERVICE_MAIN 9router-public-proxy 9router-rl"
    info "[dry-run] would remove ${SYSTEMD_UNIT_DIR}/${SERVICE_MAIN}.service.d"
    if [ "$DO_PURGE" = 1 ]; then
      info "[dry-run] would delete $RELEASE_DIR, $DATA_DIR and $ENV_FILE"
    else
      info "[dry-run] would keep $DATA_DIR and back up $ENV_FILE + units"
    fi
    exit 0
  fi

  SCOPE=""
  if [ "$DO_PURGE" = 1 ]; then
    SCOPE="It also DELETES $RELEASE_DIR, $DATA_DIR and $ENV_FILE. This is irreversible."
  else
    SCOPE="Data at $DATA_DIR is kept, and the config + units are backed up first."
  fi
  if ! require_typed_confirmation \
      "This STOPS and REMOVES every 9Router systemd unit. $SCOPE" \
      "$CONFIRM_PHRASE"; then
    fail "Uninstall cancelled (confirmation not given). Pass --yes for an unattended uninstall."
  fi

  if [ "$DO_PURGE" != 1 ]; then
    BACKUP_DIR="${BACKUP_ROOT}/uninstall-$(date +%Y%m%d-%H%M%S)"
    info "Backing up config + units to $BACKUP_DIR"
    mkdir -p "$BACKUP_DIR"
    backup_paths env "$ENV_FILE" || true
    snapshot_systemd_units || true
  else
    warn "Purging: no backup will be retained."
  fi

  # Put back any legacy npm-global unit this installer displaced.
  if [ -f "$STATE_DIR/legacy-9router.unit" ]; then
    info "Restoring pre-install ${SERVICE_MAIN}.service from $STATE_DIR"
    cp -a "$STATE_DIR/legacy-9router.unit" "${SYSTEMD_UNIT_DIR}/${SERVICE_MAIN}.service" || true
  fi

  for unit in "$SERVICE_ENGINE" "$SERVICE_MAIN" 9router-public-proxy 9router-rl; do
    if systemctl list-unit-files 2>/dev/null | grep -q "^${unit}\.service"; then
      systemctl disable --now "$unit" 2>/dev/null || true
      rm -f "${SYSTEMD_UNIT_DIR}/${unit}.service"
      ok "removed $unit"
    fi
  done
  rm -rf "${SYSTEMD_UNIT_DIR}/${SERVICE_MAIN}.service.d"
  systemctl daemon-reload
  if [ "$DO_PURGE" = 1 ]; then
    warn "Purging release dir $RELEASE_DIR and data dir $DATA_DIR (--purge)"
    rm -rf "$RELEASE_DIR" "${RELEASE_DIR}.previous" "$DATA_DIR"
    rm -f "$ENV_FILE"
    ok "purged release, data and config"
  else
    info "Data kept at $DATA_DIR (use --purge to delete)"
    [ -n "$BACKUP_DIR" ] && info "Backup at $BACKUP_DIR"
  fi
  printf '\n%sUninstall complete.%s\n' "$C_GREEN$C_BOLD" "$C_RESET"
  exit 0
fi

# ─── 0. Preflight ────────────────────────────────────────────────────────────
need_root
install_error_traps
step "Preflight checks"

[ -f "$REPO_DIR/package.json" ] || fail "Run this from the 9Router repo (expected package.json at $REPO_DIR)"
[ -f "$REPO_DIR/hybrid-engine/go.mod" ] || fail "hybrid-engine/go.mod missing — is this the full repo checkout?"

# Safety gate: never touch an existing install unless the user explicitly asked.
resolve_install_mode
case "$INSTALL_MODE" in
  install)   ok "No existing install detected — fresh install" ;;
  upgrade)   ok "Upgrade mode — existing install is backed up, then replaced" ;;
  reinstall) ok "Forced reinstall — existing install is backed up, then replaced" ;;
esac

if [ "$INSTALL_MODE" = "upgrade" ] || [ "$INSTALL_MODE" = "reinstall" ]; then
  info "Config overwritten: $ENV_FILE (secrets preserved)"
  info "Release replaced:   $RELEASE_DIR"
  info "Data preserved:     $DATA_DIR"
fi

# Port validation — a foreign listener is a hard failure, not a warning, and it
# must surface in --dry-run too (that is the point of a preview).
step "Validating ports"
require_free_ports "$GATEWAY_PORT" "$LIMITER_PORT" "$BACKEND_PORT" "$PUBLIC_PORT"
ok "Ports validated"

if [ "$DRY_RUN" = 1 ]; then
  step "Dry run — nothing will be changed"
  info "mode          $INSTALL_MODE"
  info "repo          $REPO_DIR"
  info "install dir   $INSTALL_DIR"
  info "release dir   $RELEASE_DIR"
  info "data dir      $DATA_DIR"
  info "env file      $ENV_FILE"
  info "backup root   $BACKUP_ROOT"
  info "ports         gateway $GATEWAY_PORT · limiter $LIMITER_PORT · backend $BACKEND_PORT · public $PUBLIC_PORT"
  info "units         ${SERVICE_ENGINE}.service · ${SERVICE_MAIN}.service · ${SERVICE_MAIN}.service.d/override.conf"
  info "steps         preflight → backup → npm install → go build → next build → stage release → env → units → start → health"
  printf '\n%sDry run complete. Re-run without --dry-run to apply.%s\n' "$C_GREEN$C_BOLD" "$C_RESET"
  exit 0
fi

command -v node >/dev/null 2>&1 || fail "Node.js not found. Install Node.js >= 20 first (https://nodejs.org)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || fail "Node.js >= 20 required (found $(node -v))."
ok "Node.js $(node -v)"

command -v npm >/dev/null 2>&1 || fail "npm not found."
ok "npm $(npm -v)"

command -v systemctl >/dev/null 2>&1 || fail "systemd not found — this installer targets systemd Linux."
systemctl list-units >/dev/null 2>&1 || fail "systemd is not running as init — cannot install services here."
ok "systemd available"

command -v curl >/dev/null 2>&1 || fail "curl not found; required for health checks."
command -v ss >/dev/null 2>&1 || fail "ss (iproute2) not found; required for port validation."

# Memory / disk sanity
AVAIL_MB="$(free -m | awk '/^Mem:/{print $7}')"
if [ -n "$AVAIL_MB" ] && [ "$AVAIL_MB" -lt 1200 ]; then
  warn "Only ${AVAIL_MB} MB RAM available; recommend >= 2 GB for the build step."
fi
AVAIL_KB="$(df -Pk "$REPO_DIR" | awk 'NR==2{print $4}')"
if [ -n "$AVAIL_KB" ] && [ "$AVAIL_KB" -lt 2500000 ]; then
  warn "Less than 2.5 GB free disk at $REPO_DIR; the build may fail."
fi

# Go is only needed when we have to compile the engine binary.
HAVE_GO=0
if command -v go >/dev/null 2>&1; then
  HAVE_GO=1
  ok "Go $(go version | awk '{print $3}')"
else
  warn "Go toolchain not found (only needed to rebuild the engine binary)"
fi

# Leftovers from a build that died mid-copy must not confuse deployment.
cleanup_stage

ok "Preflight complete"

# ─── 0b. Backup (upgrade / reinstall only) ───────────────────────────────────
if [ "$INSTALL_MODE" = "upgrade" ] || [ "$INSTALL_MODE" = "reinstall" ]; then
  step "Backing up the existing install"
  BACKUP_DIR="${BACKUP_ROOT}/$(date +%Y%m%d-%H%M%S)-${INSTALL_MODE}"
  mkdir -p "$BACKUP_DIR"
  backup_paths env "$ENV_FILE"
  snapshot_systemd_units
  if [ -d "$RELEASE_DIR" ]; then
    info "snapshotting $RELEASE_DIR (this keeps a rollback copy)"
    cp -a "$RELEASE_DIR" "$BACKUP_DIR/release-live"
  fi
  mkdir -p "$STATE_DIR"
  if [ -f "${SYSTEMD_UNIT_DIR}/${SERVICE_MAIN}.service" ] &&
     ! grep -q '9router-release' "${SYSTEMD_UNIT_DIR}/${SERVICE_MAIN}.service" 2>/dev/null; then
    cp -a "${SYSTEMD_UNIT_DIR}/${SERVICE_MAIN}.service" "$STATE_DIR/legacy-9router.unit" 2>/dev/null || true
    info "Noted a legacy ${SERVICE_MAIN}.service for later restoration"
  fi
  printf '%s\n' "$BACKUP_DIR" > "$STATE_DIR/last-backup" 2>/dev/null || true
  ROLLBACK_ARMED=1
  ok "Backup written to $BACKUP_DIR (automatic rollback armed)"
  info "Manual rollback: sudo bash $0 --restore-backup $BACKUP_DIR"
fi

# ─── 1. Dashboard password ───────────────────────────────────────────────────
step "Dashboard credentials"
ROUTER_PASSWORD="${ROUTER_PASSWORD:-}"
if [ -z "$ROUTER_PASSWORD" ] && [ -f "$DATA_DIR/.9router/db/data.sqlite" ]; then
  info "Existing installation detected at $DATA_DIR — keeping current password."
elif [ -z "$ROUTER_PASSWORD" ]; then
  if [ "$ASSUME_YES" = 1 ] || [ ! -t 0 ]; then
    ROUTER_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | head -c 16)"
    warn "No ROUTER_PASSWORD supplied; generated one."
  else
    printf '    Choose a dashboard password (min 8 chars): '
    read -rs ROUTER_PASSWORD; echo
    printf '    Confirm password: '
    read -rs CONFIRM; echo
    [ "$ROUTER_PASSWORD" = "$CONFIRM" ] || fail "Passwords did not match."
    [ "${#ROUTER_PASSWORD}" -ge 8 ] || fail "Password must be at least 8 characters."
  fi
fi

# ─── 2. Install dependencies + build ─────────────────────────────────────────
step "Installing Node dependencies"
cd "$REPO_DIR"
if [ -d node_modules ] && [ -f node_modules/.package-lock.json ]; then
  info "node_modules present — running incremental install"
fi
npm install --no-audit --no-fund
ok "Node dependencies ready"

step "Building engine binary (Go)"
if [ "$SKIP_BUILD" = 1 ]; then
  info "Skipped (--skip-build)"
elif [ "$HAVE_GO" = 1 ]; then
  ( cd hybrid-engine && go build -o bin/router-engine ./cmd/engine )
  ok "router-engine built ($(du -h hybrid-engine/bin/router-engine | cut -f1))"
elif [ -x hybrid-engine/bin/router-engine ] && [ -x "$RELEASE_DIR/hybrid-engine/bin/router-engine" ]; then
  warn "Go not installed — reusing the pre-built bin/router-engine from the current install"
elif [ -x hybrid-engine/bin/router-engine ]; then
  warn "Go not installed — using the pre-built bin/router-engine shipped in the repo"
else
  fail "No Go toolchain and no prebuilt hybrid-engine/bin/router-engine. Install Go >= 1.21."
fi

# The binary must live inside INSTALL_DIR because that is what the unit runs.
mkdir -p "$INSTALL_DIR"
if [ "$SKIP_BUILD" != 1 ] && [ -x "$RELEASE_DIR/hybrid-engine/bin/router-engine" ] && [ ! -x hybrid-engine/bin/router-engine ]; then
  info "Refreshing $INSTALL_DIR/hybrid-engine/bin/router-engine from the previous install"
fi

step "Building Next.js standalone bundle"
if [ "$SKIP_BUILD" = 1 ]; then
  info "Skipped (--skip-build)"
  [ -d "$REPO_DIR/.next/standalone" ] || fail "--skip-build needs an existing .next/standalone build in $REPO_DIR"
else
  npm run build
  ok "Next.js build complete"
fi

# ─── 2b. Lay out the install dir (engine binary + deploy assets) ─────────────
step "Staging install directory"
mkdir -p "$INSTALL_DIR/hybrid-engine/bin" "$INSTALL_DIR/deploy"
cp -a "$REPO_DIR/hybrid-engine/pkg" "$INSTALL_DIR/hybrid-engine/" 2>/dev/null || true
cp -a "$REPO_DIR/hybrid-engine/cmd" "$INSTALL_DIR/hybrid-engine/" 2>/dev/null || true
cp -a "$REPO_DIR/hybrid-engine/go.mod" "$INSTALL_DIR/hybrid-engine/" 2>/dev/null || true
if [ -x "$REPO_DIR/hybrid-engine/bin/router-engine" ]; then
  cp -a "$REPO_DIR/hybrid-engine/bin/router-engine" "$INSTALL_DIR/hybrid-engine/bin/router-engine"
elif [ -x "$RELEASE_DIR/hybrid-engine/bin/router-engine" ]; then
  cp -a "$RELEASE_DIR/hybrid-engine/bin/router-engine" "$INSTALL_DIR/hybrid-engine/bin/router-engine"
else
  fail "No router-engine binary available to install."
fi
cp -a "$REPO_DIR/deploy/." "$INSTALL_DIR/deploy/" 2>/dev/null || true
[ -x "$INSTALL_DIR/hybrid-engine/bin/router-engine" ] || fail "engine binary not executable at $INSTALL_DIR/hybrid-engine/bin/router-engine"
ok "Install dir ready at $INSTALL_DIR"

# ─── 3. Lay out release + data dirs ──────────────────────────────────────────
step "Preparing directories"
mkdir -p "$RELEASE_DIR" "$DATA_DIR"

# Stage into a sibling dir first so a failed copy never leaves a half-written
# release the service would pick up on its next restart.
STAGE_DIR="${RELEASE_DIR}.staging.$$"
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"
cp -a "$REPO_DIR/.next/standalone/." "$STAGE_DIR/"
mkdir -p "$STAGE_DIR/.next"
cp -a "$REPO_DIR/.next/static" "$STAGE_DIR/.next/static"
cp -a "$REPO_DIR/public" "$STAGE_DIR/public"
cp -a "$REPO_DIR/custom-server.js" "$STAGE_DIR/custom-server.js"
[ -f "$STAGE_DIR/custom-server.js" ] || fail "custom-server.js missing from the staged release"

# Atomic swap; keep the previous release so rollback has something to restore.
rm -rf "${RELEASE_DIR}.previous"
if [ -d "$RELEASE_DIR" ] && [ -n "$(ls -A "$RELEASE_DIR" 2>/dev/null)" ]; then
  mv "$RELEASE_DIR" "${RELEASE_DIR}.previous"
fi
mv "$STAGE_DIR" "$RELEASE_DIR"
ok "Release staged at $RELEASE_DIR"
info "Data dir: $DATA_DIR"

# ─── 4. Generate environment file ────────────────────────────────────────────
step "Writing environment configuration"
JWT_SECRET="$(head -c 48 /dev/urandom | base64 | tr -d '/+=' | head -c 48)"
MACHINE_SALT="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 24)"
API_KEY_SECRET="$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 32)"

# Preserve existing secrets across upgrades; rotating them logs everyone out.
preserve_secret() { # preserve_secret VARNAME
  local name="$1" current
  [ -f "$ENV_FILE" ] || return 0
  current="$(grep -E "^${name}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)"
  [ -n "$current" ] && printf '%s' "$current"
}
EXISTING_JWT="$(preserve_secret JWT_SECRET)";       [ -n "$EXISTING_JWT" ] && JWT_SECRET="$EXISTING_JWT"
EXISTING_SALT="$(preserve_secret MACHINE_ID_SALT)"; [ -n "$EXISTING_SALT" ] && MACHINE_SALT="$EXISTING_SALT"
EXISTING_AKS="$(preserve_secret API_KEY_SECRET)";   [ -n "$EXISTING_AKS" ] && API_KEY_SECRET="$EXISTING_AKS"
EXISTING_DBURL="$(preserve_secret DATABASE_URL)"

# Refuse to hand the backend a config file with a literal unset port.
[ -n "$GATEWAY_PORT" ] && [ -n "$LIMITER_PORT" ] && [ -n "$BACKEND_PORT" ] && [ -n "$PUBLIC_PORT" ] || fail "Port variables must not be empty."

cat > "$ENV_FILE" <<EOF
# 9Router environment — generated by scripts/install.sh on $(date -Is)
# Edit freely, then: systemctl restart ${SERVICE_ENGINE} ${SERVICE_MAIN}

# ── Gateway ports ───────────────────────────────────────────────────────────
GATEWAY_PORT=${GATEWAY_PORT}
LIMITER_PORT=${LIMITER_PORT}
BACKEND_PORT=${BACKEND_PORT}
PUBLIC_PORT=${PUBLIC_PORT}

# ── Secrets (rotating JWT_SECRET logs every user out) ───────────────────────
JWT_SECRET=${JWT_SECRET}
MACHINE_ID_SALT=${MACHINE_SALT}
API_KEY_SECRET=${API_KEY_SECRET}

# ── Storage ─────────────────────────────────────────────────────────────────
DATA_DIR=${DATA_DIR}
INSTALL_DIR=${INSTALL_DIR}
RELEASE_DIR=${RELEASE_DIR}

# ── Database backend: SQLite (default) or PostgreSQL ────────────────────────
# Set DATABASE_URL to switch to PostgreSQL and restart the backend.
${EXISTING_DBURL:+DATABASE_URL=${EXISTING_DBURL}}
${EXISTING_DBURL:-# DATABASE_URL=postgres://user:password@localhost:5432/9router}

# ── Feature toggles ─────────────────────────────────────────────────────────
ENABLE_GO_HYBRID=true
GO_ENGINE_URL=http://127.0.0.1:${LIMITER_PORT}
NODE_OPTIONS=--max-old-space-size=512
EOF
chmod 600 "$ENV_FILE"
ok "Wrote $ENV_FILE"

# ─── 5. Install systemd units ────────────────────────────────────────────────
step "Installing systemd services"

# The Go binary owns every public port and fronts the internal Next.js server.
cat > "${SYSTEMD_UNIT_DIR}/${SERVICE_ENGINE}.service" <<EOF
[Unit]
Description=9Router Golang Master Gateway (gateway :${GATEWAY_PORT}, limiter :${LIMITER_PORT}, public :${PUBLIC_PORT})
Documentation=file://${INSTALL_DIR}/README.md
After=network-online.target ${SERVICE_MAIN}.service
Wants=network-online.target
PartOf=${SERVICE_MAIN}.service

[Service]
Type=simple
User=root
WorkingDirectory=${INSTALL_DIR}/hybrid-engine
EnvironmentFile=${ENV_FILE}
ExecStart=${INSTALL_DIR}/hybrid-engine/bin/router-engine \\
  -port \${LIMITER_PORT} \\
  -gateway-port \${GATEWAY_PORT} \\
  -proxy-port \${PUBLIC_PORT} \\
  -upstream http://127.0.0.1:\${BACKEND_PORT} \\
  -static-dir ${INSTALL_DIR}/deploy
Restart=always
RestartSec=3
KillMode=control-group
LimitNOFILE=65535
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
# The engine re-reads deploy/usage-check.html after a deploy, so it needs write
# access to its own bits and the static dir.
ReadWritePaths=${INSTALL_DIR}/hybrid-engine ${INSTALL_DIR}/deploy
StandardOutput=journal
StandardError=journal
SyslogIdentifier=9router-engine

[Install]
WantedBy=multi-user.target
EOF

# Next.js only ever listens on loopback; the Go gateway is the sole entry point.
cat > "${SYSTEMD_UNIT_DIR}/${SERVICE_MAIN}.service" <<EOF
[Unit]
Description=9Router Next.js backend (internal :${BACKEND_PORT})
Documentation=file://${INSTALL_DIR}/README.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
EnvironmentFile=${ENV_FILE}
Environment=HOME=${DATA_DIR}
ExecStart=/usr/bin/env node ${RELEASE_DIR}/custom-server.js --no-browser --log --skip-update
Restart=on-failure
RestartSec=5
KillMode=control-group
TimeoutStopSec=300
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${DATA_DIR} ${RELEASE_DIR}
StandardOutput=journal
StandardError=journal
SyslogIdentifier=9router-backend

[Install]
WantedBy=multi-user.target
EOF

# Drop-in keeps port/host overrides separate from the generated unit, so
# `systemctl edit` stays clean and re-running the installer is idempotent.
mkdir -p "${SYSTEMD_UNIT_DIR}/${SERVICE_MAIN}.service.d"
cat > "${SYSTEMD_UNIT_DIR}/${SERVICE_MAIN}.service.d/override.conf" <<EOF
# Generated by scripts/install.sh — the Next.js backend listens on loopback only.
# The Golang Master Gateway (${SERVICE_ENGINE}.service) owns the public ports.
[Service]
Environment=PORT=${BACKEND_PORT}
Environment=HOSTNAME=127.0.0.1
Environment=ENABLE_GO_HYBRID=true
Environment=GO_ENGINE_URL=http://127.0.0.1:${LIMITER_PORT}
Environment=NODE_OPTIONS=--max-old-space-size=512
ReadWritePaths=${DATA_DIR} ${RELEASE_DIR}
TimeoutStopSec=300
EOF

chmod 0644 "${SYSTEMD_UNIT_DIR}/${SERVICE_MAIN}.service" "${SYSTEMD_UNIT_DIR}/${SERVICE_ENGINE}.service" \
          "${SYSTEMD_UNIT_DIR}/${SERVICE_MAIN}.service.d/override.conf"
[ -x "$INSTALL_DIR/hybrid-engine/bin/router-engine" ] || fail "engine binary missing before unit install"

# Never silently delete a unit we did not create: back it up, then retire it.
retire_legacy_unit() { # retire_legacy_unit <unit>
  local unit="$1" f="${SYSTEMD_UNIT_DIR}/$1.service"
  if systemctl list-unit-files 2>/dev/null | grep -q "^${unit}\.service"; then
    [ -n "$BACKUP_DIR" ] && { mkdir -p "$BACKUP_DIR/retired" && cp -a "$f" "$BACKUP_DIR/retired/" 2>/dev/null || true; }
    systemctl disable --now "$unit" 2>/dev/null || true
    rm -f "$f"
    info "retired legacy unit ${unit}"
  fi
}
for legacy in 9router-public-proxy 9router-rl; do
  retire_legacy_unit "$legacy"
done

systemctl daemon-reload
ok "systemd units installed"

# ─── 6. Start services ───────────────────────────────────────────────────────
step "Starting services"
# Stop anything still holding our ports before the new units take them.
systemctl stop "$SERVICE_ENGINE" 2>/dev/null || true
systemctl stop "$SERVICE_MAIN" 2>/dev/null || true
systemctl enable "$SERVICE_MAIN" "$SERVICE_ENGINE" >/dev/null 2>&1 || true
systemctl restart "$SERVICE_MAIN"
systemctl restart "$SERVICE_ENGINE"
ok "Services restarted"

# ─── 7. Health verification ──────────────────────────────────────────────────
step "Verifying health"
BACKEND_OK=0
for i in $(seq 1 45); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${BACKEND_PORT}/api/health" 2>/dev/null | grep -q '"ok":true'; then
    BACKEND_OK=1; info "backend healthy after ${i}s"; break
  fi
  sleep 1
done
if [ "$BACKEND_OK" != 1 ]; then
  warn "Backend did not report healthy in 45s. Recent logs:"
  journalctl -u "$SERVICE_MAIN" -n 20 --no-pager || true
  if [ "$ROLLBACK_ARMED" = 1 ]; then
    warn "Health check failed — rolling back to the previous install."
    exit 1
  fi
  fail "Backend health check failed at http://127.0.0.1:${BACKEND_PORT}/api/health"
fi
ok "Backend (:${BACKEND_PORT}) healthy"

check_http() { # check_http <label> <url> <expected>
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$2" 2>/dev/null || echo 000)"
  if [ "$code" = "$3" ]; then ok "$1 → HTTP $code"; else warn "$1 → HTTP $code (expected $3)"; return 1; fi
}

GATEWAY_FAIL=0
check_http "Master gateway health"  "http://localhost:${GATEWAY_PORT}/api/health" 200 || GATEWAY_FAIL=1
check_http "Login page"             "http://localhost:${GATEWAY_PORT}/login" 200 || GATEWAY_FAIL=1
check_http "Usage-check portal"     "http://localhost:${PUBLIC_PORT}/usage-check" 200 || GATEWAY_FAIL=1
check_http "Limiter RPC health"     "http://127.0.0.1:${LIMITER_PORT}/health" 200 || GATEWAY_FAIL=1

if [ "$GATEWAY_FAIL" != 0 ]; then
  warn "One or more gateway checks failed. Inspect: journalctl -u ${SERVICE_ENGINE} -n 50"
  if [ "$ROLLBACK_ARMED" = 1 ]; then
    warn "Health check failed — rolling back to the previous install."
    exit 1
  fi
  fail "Gateway health checks failed."
fi

if [ "$ROLLBACK_ARMED" = 1 ]; then
  ROLLBACK_ARMED=0
  ok "Upgrade verified — rollback disarmed"
  info "Backup retained at $BACKUP_DIR"
  [ -d "${RELEASE_DIR}.previous" ] && info "Previous release retained at ${RELEASE_DIR}.previous"
fi

# ─── 8. Done ─────────────────────────────────────────────────────────────────
LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
printf '\n%s%s 9Router is running%s\n' "$C_BOLD" "$C_GREEN" "$C_RESET"
cat <<EOF

  Dashboard       http://${LAN_IP:-localhost}:${GATEWAY_PORT}/dashboard
  Login           http://${LAN_IP:-localhost}:${GATEWAY_PORT}/login
  Public portal   http://${LAN_IP:-localhost}:${PUBLIC_PORT}/usage-check
  API base        http://${LAN_IP:-localhost}:${GATEWAY_PORT}/v1

  Ports   gateway ${GATEWAY_PORT} · limiter ${LIMITER_PORT} · backend ${BACKEND_PORT} (loopback) · public ${PUBLIC_PORT}
  Config  ${ENV_FILE}
  Data    ${DATA_DIR}
  Units   ${SERVICE_ENGINE}.service · ${SERVICE_MAIN}.service
EOF

if [ -n "$ROUTER_PASSWORD" ] && [ ! -f "$DATA_DIR/.9router/db/data.sqlite" ]; then
  printf '\n  %sFirst-run password:%s %s\n' "$C_YELLOW$C_BOLD" "$C_RESET" "$ROUTER_PASSWORD"
  printf '  %sStore it now — it is not shown again.%s\n' "$C_DIM" "$C_RESET"
  printf '  (Sign in at /login, then change it under Profile → Branding.)\n'
fi
[ -n "$LAN_IP" ] && printf '\n  %sListening on all interfaces — restrict access with your firewall.%s\n' "$C_DIM" "$C_RESET"

cat <<EOF

  Manage
    systemctl status  ${SERVICE_ENGINE} ${SERVICE_MAIN}
    systemctl restart ${SERVICE_ENGINE}
    journalctl -u ${SERVICE_ENGINE} -f

  Upgrade safely (backup + automatic rollback)
    sudo bash ${REPO_DIR}/scripts/install.sh --upgrade

  Roll back a failed upgrade
    sudo bash ${REPO_DIR}/scripts/install.sh --restore-backup ${BACKUP_ROOT}/<timestamp>-upgrade

  Uninstall (keeps data)
    sudo bash ${REPO_DIR}/scripts/install.sh --uninstall
  Uninstall (deletes data)
    sudo bash ${REPO_DIR}/scripts/install.sh --uninstall --purge

  Migrate to PostgreSQL later
    DATABASE_URL=postgres://user:pass@host:5432/9router \\
      node ${REPO_DIR}/scripts/migrate-sqlite-to-postgres.mjs

EOF
