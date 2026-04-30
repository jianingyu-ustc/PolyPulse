export const portNames = [
  "MarketSource",
  "EvidenceCrawler",
  "ProbabilityEstimator",
  "DecisionEngine",
  "RiskEngine",
  "Broker",
  "PaperBroker",
  "LiveBroker",
  "OrderExecutor",
  "StateStore",
  "ArtifactWriter",
  "Scheduler",
  "Reporter"
];

/**
 * This file documents PolyPulse's stable module boundaries without binding the
 * project to a framework or dependency-injection library. Implementations live
 * under src/adapters, src/core, src/brokers, src/state, src/artifacts, and
 * src/scheduler.
 */
export function describePorts() {
  return {
    MarketSource: "scan markets, read order books, read account balances and positions",
    EvidenceCrawler: "collect and cache market-specific evidence through pluggable search/fetch adapters",
    ProbabilityEstimator: "estimate outcome probabilities from evidence",
    DecisionEngine: "turn estimates and portfolio context into trade decisions",
    RiskEngine: "enforce service-layer pre-trade constraints",
    Broker: "abstract order execution and portfolio sync",
    PaperBroker: "simulate orders and update local paper state",
    LiveBroker: "fail-closed live execution adapter",
    OrderExecutor: "single execution gate that requires RiskDecision.allowed before broker submit",
    StateStore: "persist runs, portfolio state, checkpoints, and dedupe locks",
    ArtifactWriter: "write redacted run artifacts and summaries",
    Scheduler: "orchestrate run-once and monitor loops",
    Reporter: "emit concise user-visible status and alerts"
  };
}
