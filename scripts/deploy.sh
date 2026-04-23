#!/usr/bin/env bash
# scripts/deploy.sh — deploy Klebb to a local release directory.
#
# Build+push model:
#   1. Run tests first. Bail if any fail.
#   2. Rsync the working copy into a timestamped release directory under
#      $DEPLOY_ROOT/releases/.
#   3. npm install --omit=dev in the new release dir.
#   4. Atomically flip the $DEPLOY_ROOT/current symlink.
#   5. Restart the systemd unit for the named instance.
#   6. Smoke-test the HTTP endpoint. Roll back if unhealthy.
#   7. Prune old releases (keep the most recent $KEEP_RELEASES).
#
# Usage:
#   ./scripts/deploy.sh --instance <name> [--dry-run] [--skip-tests]
#   ./scripts/deploy.sh --help
#
# Environment variables (with sensible defaults):
#   DEPLOY_ROOT      = /opt/klebb           — where releases live
#   RUN_AS_USER      = current user         — chown the release to this
#   SMOKE_URL        = from env file        — health-check URL
#   KEEP_RELEASES    = 5                    — retention count

set -euo pipefail

INSTANCE=""
DRY_RUN=0
SKIP_TESTS=0
DEPLOY_ROOT="${DEPLOY_ROOT:-/opt/klebb}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"

usage() {
  cat <<EOF
Usage: $(basename "$0") --instance <name> [options]

Options:
  --instance <name>   systemd instance name (required, e.g. 'alice', 'bob')
  --dry-run           Report what would happen without making changes
  --skip-tests        Deploy without running npm test first (NOT recommended)
  --help              Show this message

Environment:
  DEPLOY_ROOT         Root for release dirs (default: /opt/klebb)
  SMOKE_URL           HTTP URL to probe after restart
                      (default: reads PORT from env file)
  KEEP_RELEASES       Number of old release dirs to keep (default: 5)

Example:
  ./scripts/deploy.sh --instance alice
  DEPLOY_ROOT=/tmp/klebb-test ./scripts/deploy.sh --instance test --dry-run
EOF
}

log() { printf '[deploy] %s\n' "$*" >&2; }
err() { printf '[deploy] ERROR: %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case $1 in
    --instance) INSTANCE=$2; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --skip-tests) SKIP_TESTS=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) err "unknown arg: $1" ;;
  esac
done

[[ -z "$INSTANCE" ]] && { usage; err "--instance is required"; }

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO_ROOT"

log "instance=$INSTANCE"
log "deploy root=$DEPLOY_ROOT"
log "repo=$REPO_ROOT"
log "dry run=$DRY_RUN"

# --- 1. Tests -----------------------------------------------------------
if [[ $SKIP_TESTS -eq 1 ]]; then
  log "skipping tests (--skip-tests)"
else
  log "running npm test"
  if [[ $DRY_RUN -eq 1 ]]; then
    log "(dry-run) would run: npm test"
  else
    npm test > /tmp/klebb-deploy-test.log 2>&1 || {
      echo "[deploy] tests failed:"
      tail -40 /tmp/klebb-deploy-test.log
      err "test failure — aborting deploy"
    }
    log "tests passed"
  fi
fi

# --- 2. Rsync into release dir -----------------------------------------
STAMP=$(date -u +%Y-%m-%dT%H%M%SZ)
RELEASE_DIR="$DEPLOY_ROOT/releases/$STAMP"
log "release dir: $RELEASE_DIR"

if [[ $DRY_RUN -eq 1 ]]; then
  log "(dry-run) would mkdir $RELEASE_DIR"
  log "(dry-run) would rsync -a --exclude=.git --exclude=node_modules --exclude=tests/"
else
  sudo mkdir -p "$RELEASE_DIR"
  sudo rsync -a --delete \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='tests/' \
    --exclude='*.log' \
    --exclude='.private/' \
    "$REPO_ROOT/" "$RELEASE_DIR/"
  log "rsync complete"
fi

# --- 3. npm install ----------------------------------------------------
if [[ $DRY_RUN -eq 1 ]]; then
  log "(dry-run) would: cd $RELEASE_DIR && npm install --omit=dev"
else
  log "installing production deps"
  sudo bash -c "cd '$RELEASE_DIR' && npm install --omit=dev --no-audit --no-fund" \
    > /tmp/klebb-deploy-npm.log 2>&1 || {
      tail -40 /tmp/klebb-deploy-npm.log
      err "npm install failed"
    }
  log "npm install complete"
fi

# --- 4. Flip the `current` symlink -------------------------------------
CURRENT_LINK="$DEPLOY_ROOT/current"
PREVIOUS_TARGET=""
if [[ -L "$CURRENT_LINK" ]]; then
  PREVIOUS_TARGET=$(readlink -f "$CURRENT_LINK")
  log "previous release: $PREVIOUS_TARGET"
fi

if [[ $DRY_RUN -eq 1 ]]; then
  log "(dry-run) would: ln -sfn $RELEASE_DIR $CURRENT_LINK"
else
  sudo ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"
  log "flipped $CURRENT_LINK → $RELEASE_DIR"
fi

# --- 5. Restart systemd -------------------------------------------------
UNIT="klebb@$INSTANCE.service"
if [[ $DRY_RUN -eq 1 ]]; then
  log "(dry-run) would: systemctl restart $UNIT"
else
  if sudo systemctl cat klebb@.service >/dev/null 2>&1; then
    log "restarting $UNIT"
    sudo systemctl restart "$UNIT" || err "restart failed"
  else
    log "WARNING: klebb@.service template not installed. Skipping restart."
    log "Install systemd/klebb@.service to /etc/systemd/system/ and try again."
  fi
fi

# --- 6. Smoke test -----------------------------------------------------
if [[ $DRY_RUN -eq 0 ]]; then
  ENV_FILE="/etc/klebb-$INSTANCE.env"
  SMOKE="${SMOKE_URL:-}"
  if [[ -z "$SMOKE" && -f "$ENV_FILE" ]]; then
    PORT=$(sudo grep -E '^PORT=' "$ENV_FILE" | head -1 | cut -d= -f2 | tr -d '"' || true)
    [[ -n "$PORT" ]] && SMOKE="http://127.0.0.1:${PORT}/auth/status"
  fi
  if [[ -n "$SMOKE" ]]; then
    log "smoke-testing: $SMOKE"
    OK=0
    for i in 1 2 3 4 5; do
      if curl -sf -o /dev/null "$SMOKE"; then
        OK=1
        log "health check passed (attempt $i)"
        break
      fi
      sleep 1
    done
    if [[ $OK -eq 0 ]]; then
      log "smoke test FAILED — rolling back"
      if [[ -n "$PREVIOUS_TARGET" ]]; then
        sudo ln -sfn "$PREVIOUS_TARGET" "$CURRENT_LINK"
        sudo systemctl restart "$UNIT" || true
        err "rolled back to $PREVIOUS_TARGET"
      else
        err "no previous release to roll back to — investigate $UNIT logs"
      fi
    fi
  else
    log "no smoke URL configured — skipping health check"
  fi
fi

# --- 7. Prune old releases ---------------------------------------------
if [[ $DRY_RUN -eq 0 ]]; then
  RELEASES_DIR="$DEPLOY_ROOT/releases"
  if [[ -d "$RELEASES_DIR" ]]; then
    log "pruning old releases (keeping $KEEP_RELEASES)"
    # shellcheck disable=SC2012
    sudo bash -c "ls -1dt $RELEASES_DIR/*/ 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) | xargs -r rm -rf"
    log "prune complete"
  fi
fi

log "deploy complete: $RELEASE_DIR"
