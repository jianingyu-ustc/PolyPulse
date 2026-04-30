#!/usr/bin/env bash
set -Eeuo pipefail

POLYPULSE_HOME="${POLYPULSE_HOME:-/home/PolyPulse}"
ENV_FILE="${POLYPULSE_ENV_FILE:-$POLYPULSE_HOME/.env}"
SERVICE_NAME="polypulse-monitor.service"

MODE="paper"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  MODE="${POLYPULSE_EXECUTION_MODE:-paper}"
  cd "$POLYPULSE_HOME"
  node ./bin/polypulse.js monitor stop --mode "$MODE" --env-file "$ENV_FILE" || true
fi

systemctl stop "$SERVICE_NAME" || true
systemctl --no-pager --full status "$SERVICE_NAME" || true
