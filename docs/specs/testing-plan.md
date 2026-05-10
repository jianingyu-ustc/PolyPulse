# Testing Plan

Last updated: 2026-05-06

## Scope

Tests must use the same live-only boundaries as production commands.

## Automated Tests

- Validate `DEFAULTS` in `src/config/env.js` contains required live-only fields.
- Validate missing real wallet secrets fail `live` mode preflight.
- Validate `paper` mode preflight passes without a private key.
- Validate secret values are redacted from stdout and artifacts.
- Validate Codex and Claude Code provider configuration.
- Validate `--source` is rejected.
- Validate current Polymarket topics can be fetched from Gamma.
- If Gamma is unreachable, report a skipped market check instead of substituting
  another source.
- Validate `paper` mode balance uses the live broker path.
- Validate `account audit` reports real-account blockers and stays ledger-only
  for `paper` mode.
- Validate BUY orders are blocked when live collateral allowance is insufficient.

## Smoke

`npm run smoke -- --env-file .env` performs an end-to-end live-only check:

1. env preflight
2. account balance
3. account audit
4. current Polymarket topics using `--quick`
5. prediction on a returned market
6. monitor status
7. paper mode once and monitor run when execution mode is `paper`

`live` mode order smoke is manual and requires `account audit` to pass plus
explicit operator approval.
