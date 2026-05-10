#!/usr/bin/env bash
set -Eeuo pipefail

POLYPULSE_HOME="${POLYPULSE_HOME:-/home/PolyPulse}"
ENV_FILE="${POLYPULSE_ENV_FILE:-$POLYPULSE_HOME/.env}"
SERVICE_NAME="polypulse-monitor.service"
CONFIRM=""
EXEC_MODE_ARG=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --confirm)
      CONFIRM="${2:-}"
      shift 2
      ;;
    --mode)
      EXEC_MODE_ARG="${2:-}"
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

EXEC_MODE="${POLYPULSE_EXECUTION_MODE:-live}"
if [ -n "$EXEC_MODE_ARG" ] && [ "$EXEC_MODE_ARG" != "$EXEC_MODE" ]; then
  fail "--mode $EXEC_MODE_ARG does not match POLYPULSE_EXECUTION_MODE=$EXEC_MODE in $ENV_FILE"
fi
[ "$CONFIRM" = "LIVE" ] || fail "live start requires ./deploy/scripts/start.sh --confirm LIVE"
[ -n "${PRIVATE_KEY:-}" ] || fail "PRIVATE_KEY is required"
[ -n "${FUNDER_ADDRESS:-}" ] || fail "FUNDER_ADDRESS is required"
case "$EXEC_MODE" in
  paper|live) ;;
  *) fail "POLYPULSE_EXECUTION_MODE must be paper or live" ;;
esac

"$POLYPULSE_HOME/deploy/scripts/healthcheck.sh" --live-smoke
systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null
systemctl restart "$SERVICE_NAME"
systemctl --no-pager --full status "$SERVICE_NAME" || true
