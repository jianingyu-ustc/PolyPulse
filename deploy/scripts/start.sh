#!/usr/bin/env bash
set -Eeuo pipefail

POLYPULSE_HOME="${POLYPULSE_HOME:-/home/PolyPulse}"
ENV_FILE="${POLYPULSE_ENV_FILE:-$POLYPULSE_HOME/.env}"
SERVICE_NAME="polypulse-monitor.service"
CONFIRM=""
WALLET_MODE_ARG=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --confirm)
      CONFIRM="${2:-}"
      shift 2
      ;;
    --wallet)
      WALLET_MODE_ARG="${2:-}"
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
WALLET_MODE="${POLYPULSE_LIVE_WALLET_MODE:-real}"
if [ -n "$WALLET_MODE_ARG" ] && [ "$WALLET_MODE_ARG" != "$WALLET_MODE" ]; then
  fail "--wallet $WALLET_MODE_ARG does not match POLYPULSE_LIVE_WALLET_MODE=$WALLET_MODE in $ENV_FILE"
fi
if [ "$MODE" = "live" ]; then
  [ "$CONFIRM" = "LIVE" ] || fail "live start requires ./deploy/scripts/start.sh --confirm LIVE"
  [ "${POLYPULSE_LIVE_CONFIRM:-}" = "LIVE" ] || fail "live start requires POLYPULSE_LIVE_CONFIRM=LIVE in $ENV_FILE"
  case "$WALLET_MODE" in
    real)
      [ -n "${PRIVATE_KEY:-}" ] || fail "real live wallet requires PRIVATE_KEY"
      [ -n "${FUNDER_ADDRESS:-}" ] || fail "real live wallet requires FUNDER_ADDRESS"
      ;;
    simulated)
      [ -n "${SIMULATED_WALLET_BALANCE_USD:-}" ] || fail "simulated live wallet requires SIMULATED_WALLET_BALANCE_USD"
      ;;
    *)
      fail "POLYPULSE_LIVE_WALLET_MODE must be real or simulated"
      ;;
  esac
fi

"$POLYPULSE_HOME/deploy/scripts/healthcheck.sh" --preflight
systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null
systemctl restart "$SERVICE_NAME"
systemctl --no-pager --full status "$SERVICE_NAME" || true
