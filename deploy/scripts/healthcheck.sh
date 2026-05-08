#!/usr/bin/env bash
set -Eeuo pipefail

POLYPULSE_HOME="${POLYPULSE_HOME:-/home/PolyPulse}"
ENV_FILE="${POLYPULSE_ENV_FILE:-$POLYPULSE_HOME/.env}"

fail() {
  echo "[healthcheck] fail: $*" >&2
  exit 1
}

info() {
  echo "[healthcheck] $*"
}

check_env_permissions() {
  [ -f "$ENV_FILE" ] || fail "$ENV_FILE not found"
  local mode
  mode="$(stat -c "%a" "$ENV_FILE")"
  local perm=$((8#$mode))
  if (( (perm & 077) != 0 )); then
    fail "$ENV_FILE permissions are too open; run chmod 600 $ENV_FILE"
  fi
}

load_env() {
  check_env_permissions
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
}

check_node() {
  command -v node >/dev/null 2>&1 || fail "node is required"
  node -e 'const major=Number(process.versions.node.split(".")[0]); if (major < 20) process.exit(1)' \
    || fail "Node.js >= 20 is required"
}

run_cli() {
  cd "$POLYPULSE_HOME"
  node ./bin/polypulse.js "$@"
}

preflight() {
  [ -d "$POLYPULSE_HOME" ] || fail "$POLYPULSE_HOME not found"
  [ -f "$POLYPULSE_HOME/bin/polypulse.js" ] || fail "PolyPulse CLI not found"
  check_node
  load_env
  mkdir -p "${STATE_DIR:-$POLYPULSE_HOME/runtime-artifacts/state}" "${ARTIFACT_DIR:-$POLYPULSE_HOME/runtime-artifacts}" "$POLYPULSE_HOME/logs"
  case "${POLYPULSE_LIVE_WALLET_MODE:-real}" in
    real|simulated) ;;
    *) fail "POLYPULSE_LIVE_WALLET_MODE must be real or simulated" ;;
  esac
  [ "${POLYPULSE_MARKET_SOURCE:-polymarket}" = "polymarket" ] || fail "POLYPULSE_MARKET_SOURCE must be polymarket"
  run_cli env check --env-file "$ENV_FILE" >/dev/null
  info "preflight ok wallet=${POLYPULSE_LIVE_WALLET_MODE:-real}"
}

case "${1:-}" in
  --preflight)
    preflight
    ;;
  --live-smoke)
    preflight
    run_cli account balance --env-file "$ENV_FILE" >/dev/null
    run_cli account audit --env-file "$ENV_FILE" >/dev/null
    run_cli market topics --env-file "$ENV_FILE" --limit 1 --quick >/dev/null
    info "live smoke ok"
    ;;
  "")
    preflight
    if command -v systemctl >/dev/null 2>&1; then
      systemctl is-active polypulse-monitor.service || true
    fi
    run_cli monitor status --env-file "$ENV_FILE" >/dev/null || true
    info "healthcheck ok"
    ;;
  *)
    fail "unknown argument $1"
    ;;
esac
