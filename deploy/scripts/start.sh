#!/usr/bin/env bash
set -Eeuo pipefail

POLYPULSE_HOME="${POLYPULSE_HOME:-/home/PolyPulse}"
ENV_FILE="${POLYPULSE_ENV_FILE:-$POLYPULSE_HOME/.env}"
SERVICE_NAME="polypulse-monitor.service"
CONFIRM=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --confirm)
      CONFIRM="${2:-}"
      shift 2
      ;;
    *)
      echo "[start] fail: unknown argument $1" >&2
      exit 2
      ;;
  esac
done

fail() {
  echo "[start] fail: $*" >&2
  exit 1
}

[ -f "$ENV_FILE" ] || fail "$ENV_FILE not found"

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

MODE="${POLYPULSE_EXECUTION_MODE:-paper}"
if [ "$MODE" = "live" ]; then
  [ "$CONFIRM" = "LIVE" ] || fail "live start requires ./deploy/scripts/start.sh --confirm LIVE"
  [ "${POLYPULSE_LIVE_CONFIRM:-}" = "LIVE" ] || fail "live start requires POLYPULSE_LIVE_CONFIRM=LIVE in $ENV_FILE"
fi

"$POLYPULSE_HOME/deploy/scripts/healthcheck.sh" --preflight
systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null
systemctl restart "$SERVICE_NAME"
systemctl --no-pager --full status "$SERVICE_NAME" || true
