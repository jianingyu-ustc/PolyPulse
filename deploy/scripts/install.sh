#!/usr/bin/env bash
set -Eeuo pipefail

POLYPULSE_HOME="${POLYPULSE_HOME:-/home/PolyPulse}"
ENV_FILE="${POLYPULSE_ENV_FILE:-$POLYPULSE_HOME/.env}"
SERVICE_NAME="polypulse-monitor.service"

fail() {
  echo "[install] fail: $*" >&2
  exit 1
}

info() {
  echo "[install] $*"
}

if [ "$(id -u)" -ne 0 ]; then
  fail "run as root on the VPS"
fi

[ -d "$POLYPULSE_HOME" ] || fail "$POLYPULSE_HOME does not exist; copy the repository there first"
[ -f "$POLYPULSE_HOME/package.json" ] || fail "$POLYPULSE_HOME/package.json not found"
[ -f "$POLYPULSE_HOME/src/config/env.js" ] || fail "src/config/env.js not found"
[ -f "$POLYPULSE_HOME/deploy/systemd/$SERVICE_NAME" ] || fail "systemd service file not found"

command -v node >/dev/null 2>&1 || fail "node is required"
node -e 'const major=Number(process.versions.node.split(".")[0]); if (major < 20) process.exit(1)' \
  || fail "Node.js >= 20 is required"

mkdir -p "$POLYPULSE_HOME/runtime-artifacts/state" "$POLYPULSE_HOME/logs"
chmod 700 "$POLYPULSE_HOME/runtime-artifacts" "$POLYPULSE_HOME/runtime-artifacts/state" "$POLYPULSE_HOME/logs"

if [ ! -f "$ENV_FILE" ]; then
  node --input-type=module -e "
import { DEFAULTS } from './src/config/env.js';
const lines = ['# PolyPulse .env — 所有变量必须显式配置，无默认值', '# 变量说明见 src/config/env.js 的 DEFAULTS 注释', ''];
for (const key of Object.keys(DEFAULTS)) {
  lines.push(key + '=');
}
process.stdout.write(lines.join('\n') + '\n');
" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  info "created $ENV_FILE with all required keys (${#} vars); fill in values before starting"
else
  chmod 600 "$ENV_FILE"
  info "kept existing $ENV_FILE and enforced chmod 600"
fi

cp "$POLYPULSE_HOME/deploy/systemd/$SERVICE_NAME" "/etc/systemd/system/$SERVICE_NAME"

cat >/etc/logrotate.d/polypulse-monitor <<'LOGROTATE'
/home/PolyPulse/logs/*.log {
  daily
  rotate 14
  compress
  missingok
  notifempty
  copytruncate
  create 0600 root root
}
LOGROTATE

systemctl daemon-reload

cd "$POLYPULSE_HOME"
"$POLYPULSE_HOME/deploy/scripts/healthcheck.sh" --live-smoke

info "installed systemd unit /etc/systemd/system/$SERVICE_NAME"
info "start with: $POLYPULSE_HOME/deploy/scripts/start.sh"
