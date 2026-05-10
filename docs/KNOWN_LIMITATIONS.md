# PolyPulse Known Limits

Last updated: 2026-05-06

## Live Execution

- PolyPulse has two supported execution modes: `paper` and `live`.
- `paper` mode connects to the real wallet for balance reads, runs current
  Polymarket markets through the full pipeline and exercises the live broker,
  risk, artifact, and monitor path without submitting real orders. Positions and
  PnL are tracked in an internal ledger.
- `live` mode connects the real Polymarket CLOB client and can submit orders
  only after env preflight, balance and allowance checks, `account audit`,
  `RiskEngine`, and `--confirm LIVE`.
- Operator acceptance is still required before running `live` mode commands that
  may spend funds.

## Evidence And Provider

- Probability estimation must use `codex` or `claude-code`.
- Custom provider shell commands are not supported.
- Evidence currently comes from market metadata and resolution references unless
  additional real adapters are implemented.

## Operations

- Network access to `https://gamma-api.polymarket.com` is required for market
  tests, smoke checks, monitor runs, and deployments.
- Runtime artifacts redact configured secret fields before writing JSON or
  Markdown summaries.
