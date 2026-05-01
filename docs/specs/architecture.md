# Architecture

Last updated: 2026-05-06

```text
Polymarket Gamma
  -> PolymarketMarketSource
  -> EvidenceCrawler
  -> ProbabilityEstimator (Codex or Claude Code)
  -> DecisionEngine
  -> RiskEngine
  -> OrderExecutor
  -> LiveBroker
       -> SimulatedLiveWalletClient for live simulated
       -> LivePolymarketClient for live real
```

## Boundaries

- CLI creates one context with `PolymarketMarketSource`.
- `--source` is rejected.
- `--mode` only accepts `live`.
- `ProbabilityEstimator` constructs the configured real provider runtime.
- `OrderExecutor` submits only when `RiskDecision.allowed` is true.
- `LiveBroker` always runs live env preflight before balance or order calls.

## State

State is stored in `runtime-artifacts/state/live-state.json`. Runtime artifacts
are stored under `runtime-artifacts/` and are redacted before write.
