# PolyPulse Acceptance

Acceptance date: 2026-05-06

## Result

PolyPulse is live-only. The repository keeps two execution paths:

- `live simulated`: reads current Polymarket markets and runs live preflight,
  `RiskEngine`, artifacts, monitor, and live broker interfaces without a real
  wallet connection.
- `live real`: reads current Polymarket markets, connects the real CLOB client,
  checks balance, and can submit orders only after `--confirm LIVE` and all risk
  gates pass.

## Required Checks

```bash
npm test
npm run agent:check -- --env-file .env --expect codex
node ./bin/polypulse.js env check --mode live --env-file .env
node ./bin/polypulse.js market topics --env-file .env --limit 20
node ./bin/polypulse.js predict --env-file .env --market <market-id-or-slug>
node ./bin/polypulse.js trade once --mode live --env-file .env --market <market-id-or-slug> --max-amount 1 --confirm LIVE
node ./bin/polypulse.js monitor run --mode live --env-file .env --confirm LIVE --rounds 1 --limit 1 --max-amount 1
```

For `live real`, run balance and execution commands only after explicit operator
approval for real funds.

## Acceptance Criteria

- Non-live execution modes are rejected.
- `--source` is rejected.
- Market topics come from the current Polymarket Gamma API.
- Prediction uses the configured real Codex or Claude Code provider.
- Live execution uses `LiveBroker`; `live real` uses `LivePolymarketClient`.
- Artifacts are written under `runtime-artifacts/` with secret redaction.
