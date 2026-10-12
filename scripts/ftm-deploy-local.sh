#!/usr/bin/env bash
# FTM fork: pull main, rebuild standalone host, restart systemd when coding slot idle.
#
# Usage:
#   scripts/ftm-deploy-local.sh
#   scripts/ftm-deploy-local.sh --force-restart   # restart even if slot busy
#   GSD_SLOT_PROBE_URL=http://host:8082/slots scripts/ftm-deploy-local.sh
#
# Does not modify the global npm `gsd` install. Optional (manual):
#   npm install -g @opengsd/gsd-pi@<same-version>

set -euo pipefail

FORCE_RESTART=0
for arg in "$@"; do
  case "$arg" in
    --force-restart) FORCE_RESTART=1 ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PNPM_VERSION="${PNPM_VERSION:-10.12.1}"
SLOT_PROBE_URL="${GSD_SLOT_PROBE_URL:-http://192.168.86.3:8082/slots}"
SERVICE="${GSD_SYSTEMD_SERVICE:-raidnight-gsd-staging.service}"

log() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null || die "missing git"
command -v curl >/dev/null || die "missing curl"
command -v python3 >/dev/null || die "missing python3"
command -v systemctl >/dev/null || die "missing systemctl"

log "Pulling origin/main"
git fetch origin --prune
git checkout main
git pull --ff-only origin main

log "Building web host with pnpm@$PNPM_VERSION"
command -v corepack >/dev/null || die "missing corepack"
corepack prepare "pnpm@$PNPM_VERSION" --activate
pnpm install
pnpm run build:web-host

slot_busy() {
  local json
  if ! json="$(curl -fsS --max-time 5 "$SLOT_PROBE_URL")"; then
    log "WARNING: could not probe $SLOT_PROBE_URL — treating slot as busy"
    return 0
  fi
  python3 -c '
import json, sys
slots = json.load(sys.stdin)
if not isinstance(slots, list) or not slots:
    sys.exit(0)
sys.exit(0 if slots[0].get("is_processing") else 1)
' <<<"$json"
}

if [[ "$FORCE_RESTART" -eq 1 ]]; then
  log "Force restart of $SERVICE"
  systemctl --user restart "$SERVICE"
elif slot_busy; then
  log "Coding slot is busy ($SLOT_PROBE_URL) — rebuilt only; skip restart"
  log "Re-run with --force-restart when idle, or wait and run again"
  exit 0
else
  log "Slot idle — restarting $SERVICE"
  systemctl --user restart "$SERVICE"
fi

systemctl --user is-active "$SERVICE" >/dev/null
log "Deploy complete: $SERVICE is active"
exit 0
