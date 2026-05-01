# Testing Plan

Last updated: 2026-05-06

## Scope

Tests must use the same live-only boundaries as production commands.

## Automated Tests

- Validate `.env.example` contains required live-only fields.
- Validate missing real wallet secrets fail `live real` preflight.
- Validate `live simulated` preflight passes without a private key.
- Validate secret values are redacted from stdout and artifacts.
- Validate Codex and Claude Code provider configuration.
- Validate `--source` is rejected.
- Validate current Polymarket topics can be fetched from Gamma.
- If Gamma is unreachable, report a skipped market check instead of substituting
  another source.
- Validate `live simulated` balance uses the live broker path.

## Smoke

`npm run smoke -- --env-file .env` performs an end-to-end live-only check:

1. env preflight
2. account balance
3. current Polymarket topics
4. prediction on a returned market
5. monitor status
6. live simulated once and monitor run when wallet mode is `simulated`

`live real` order smoke is manual and requires explicit operator approval.
