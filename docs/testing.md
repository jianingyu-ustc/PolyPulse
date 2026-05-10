# PolyPulse Testing

PolyPulse tests are live-only. The repository no longer keeps an offline market
source. Tests that need markets read the current
Polymarket Gamma API through the same `PolymarketMarketSource` used by CLI runs.

## Commands

```bash
npm test
npm run smoke -- --env-file .env
```

`npm test` calls `node --test` through `scripts/run-tests.js` and writes details
under:

```text
runtime-artifacts/test-runs/<timestamp>/
```

`npm run smoke` uses `.env`, checks live env, balance, account audit, fetches
current Polymarket topics with `--quick`, runs prediction on a returned
`marketId` or `marketSlug`, and only runs live execution when `.env` is
configured as `paper` mode.

## Test Boundary

- Market tests use the real Gamma host in `.env`.
- If Gamma is unreachable from the current machine, market tests are skipped
  with a network diagnostic instead of substituting another market source.
- CLI tests verify removed overrides are rejected.
- Balance tests use the live broker path. In `paper` mode, the broker connects
  to the real wallet for balance reads but tracks positions in an internal ledger
  without submitting real orders.
- Account audit tests verify real-account checks are present while keeping
  `paper` mode ledger-only; real trading must stop if audit returns blockers.
- Risk tests verify BUY orders require both sufficient collateral balance and
  sufficient CLOB allowance.
- Provider tests validate Codex or Claude Code configuration and require the
  selected real provider CLI to be installed.
- Automated tests do not carry hardcoded markets, injected providers, injected
  brokers, or alternate market feeds.

## Manual Secret Check

```bash
git diff --check
rg -n "(PRIVATE_KEY|API_KEY|SECRET|TOKEN|COOKIE|SESSION)[[:space:]]*[:=]" . --glob '!runtime-artifacts/**' --glob '!node_modules/**' --glob '!.git/**'
```
