#!/usr/bin/env bash
set -Eeuo pipefail

POLYPULSE_HOME="${POLYPULSE_HOME:-/home/PolyPulse}"
ENV_FILE="${POLYPULSE_ENV_FILE:-$POLYPULSE_HOME/.env}"
SERVICE_NAME="polypulse-monitor.service"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

systemctl is-active "$SERVICE_NAME" || true
systemctl --no-pager --full status "$SERVICE_NAME" || true

if [ -f "$ENV_FILE" ] && [ -d "$POLYPULSE_HOME" ]; then
  cd "$POLYPULSE_HOME"
  node ./bin/polypulse.js monitor status --env-file "$ENV_FILE" || true
fi

echo "[status] recent logs"
tail -n 50 "$POLYPULSE_HOME/logs/polypulse-monitor.log" 2>/dev/null || true
tail -n 50 "$POLYPULSE_HOME/logs/polypulse-monitor.err.log" 2>/dev/null || true
