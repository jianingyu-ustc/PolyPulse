# Product Requirements

Last updated: 2026-05-06

## Product

PolyPulse is a Polymarket autonomous trading agent. It scans current Polymarket
markets, collects evidence, asks a configured real AI provider for probability
estimation, computes edge and sizing in code, applies risk controls, and then
routes through the live broker path.

## Supported Modes

- `live simulated`
- `live real`

No other execution mode is supported.

## Requirements

- The market source is always Polymarket Gamma.
- AI providers are restricted to Codex and Claude Code.
- AI output may only contain probability and evidence judgment.
- Sizing, fees, edge, Kelly, monthly return, token selection, and order creation
  are computed in code.
- `live real` requires private key, funder address, signature type, chain id
  `137`, CLOB host, balance check, `RiskEngine`, and `--confirm LIVE`.
- `live simulated` must still use current Polymarket markets and the live broker
  interface, but must not connect a real wallet or submit real orders.

## Acceptance

- `market topics` returns current Polymarket topics.
- `predict` uses a returned `marketId` or `marketSlug`.
- `trade once` rejects non-live mode and missing `--confirm LIVE`.
- `monitor run` rejects non-live mode and reads current Polymarket markets.
