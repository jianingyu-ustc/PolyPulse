# PolyPulse Memory

Last updated: 2026-05-06

Current repository policy:

- Execution mode is live-only.
- Supported wallet modes are `live simulated` and `live real`.
- Market source is always current Polymarket Gamma.
- CLI rejects `--source`.
- CLI rejects any non-live `--mode`.
- Tests that need market data read the real Gamma API.
- Provider runtime is restricted to Codex or Claude Code.
- Custom provider shell commands are not supported.
- Production code must not add alternate market feeds, injected provider
  outputs, injected brokers, or alternate execution paths.

Important files:

- `src/cli.js`
- `src/adapters/polymarket-market-source.js`
- `src/core/probability-estimator.js`
- `src/brokers/live-broker.js`
- `src/brokers/live-polymarket-client.js`
- `src/brokers/simulated-live-wallet-client.js`
- `src/scheduler/scheduler.js`
- `test/live-only.test.js`
