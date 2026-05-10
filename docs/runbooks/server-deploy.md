# Server Deploy Runbook

Default server directory: `/home/PolyPulse`.

## Install

```bash
cd /home/PolyPulse
npm ci --omit=dev
chmod +x deploy/scripts/*.sh
sudo ./deploy/scripts/install.sh
```

`install.sh` creates `/home/PolyPulse/.env` with minimal defaults, enforces
`chmod 600`, installs the systemd unit, installs log rotation, and runs a live
market and account-audit smoke check. All available env vars and their defaults
are defined in `src/config/env.js` (`DEFAULTS` object).

## Configure

Choose one execution mode in `/home/PolyPulse/.env`.

```dotenv
POLYPULSE_EXECUTION_MODE=paper
POLYPULSE_MARKET_SOURCE=polymarket
POLYMARKET_GAMMA_HOST=https://gamma-api.polymarket.com
FUNDER_ADDRESS=<0x...>
```

Paper mode connects to the real wallet, reads real balance as starting point,
runs the full pipeline (scan, prescreen, triage, evidence, prediction, risk),
but does NOT submit real orders. Positions and PnL are tracked in an internal
ledger.

For live trading, set:

```dotenv
POLYPULSE_EXECUTION_MODE=live
PRIVATE_KEY=<server-local-secret>
FUNDER_ADDRESS=<0x...>
SIGNATURE_TYPE=<signature-type>
CHAIN_ID=137
POLYMARKET_HOST=https://clob.polymarket.com
```

## Start

```bash
/home/PolyPulse/deploy/scripts/start.sh --confirm LIVE
```

The systemd service runs:

```bash
node ./bin/polypulse.js monitor run --env-file /home/PolyPulse/.env --confirm LIVE --loop
```

## Verify

```bash
/home/PolyPulse/deploy/scripts/healthcheck.sh
node ./bin/polypulse.js market topics --env-file /home/PolyPulse/.env --limit 20 --quick
node ./bin/polypulse.js account audit --env-file /home/PolyPulse/.env
node ./bin/polypulse.js monitor status --env-file /home/PolyPulse/.env
```
