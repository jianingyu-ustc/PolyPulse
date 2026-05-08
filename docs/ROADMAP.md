# PolyPulse Roadmap

Last updated: 2026-05-06

## P0

- Keep all CLI, tests, smoke checks, and deployment scripts live-only.
- Keep `POLYPULSE_MARKET_SOURCE=polymarket` mandatory.
- Keep `--source` rejected.

## P1

- Add real evidence adapters for official pages, news APIs, public data APIs,
  and resolution sources.
- Add order status reconciliation for `live real`.
- Add stronger confirmation binding for real orders: run id, market id, side,
  notional, env fingerprint, and wallet address.

## P2

- Add real position sync from Polymarket CLOB.
- Add order history reconciliation and incident runbooks.
- Add provider latency, token, and cost telemetry for Codex and Claude Code.
