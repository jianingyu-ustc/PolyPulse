import { summarizeEnvConfig } from "../config/env.js";
import { EvidenceCrawler } from "../adapters/evidence-crawler.js";
import { ProbabilityEstimator } from "../core/probability-estimator.js";
import { DecisionEngine } from "../core/decision-engine.js";
import { RiskEngine } from "../core/risk-engine.js";
import { LiveBroker } from "../brokers/live-broker.js";
import { OrderExecutor } from "../execution/order-executor.js";
import { Scheduler } from "../scheduler/scheduler.js";

function oneShotAction({ mode, risk, orderResult }) {
  if (!risk.allowed || !risk.order || orderResult?.status === "blocked") {
    return "no-trade";
  }
  return "live-order";
}

export async function buildPrediction(context, marketId) {
  const market = await context.marketSource.getMarket(marketId);
  if (!market) {
    throw new Error(`Market not found: ${marketId}`);
  }
  const evidenceCrawler = new EvidenceCrawler(context.config);
  const probabilityEstimator = new ProbabilityEstimator(context.config);
  const evidence = await evidenceCrawler.collect({ market });
  const estimate = await probabilityEstimator.estimate({ market, evidence });
  return { market, evidence, estimate };
}

export async function runTradeOnce({
  context,
  marketId,
  mode = "live",
  side = null,
  maxAmountUsd = 1,
  confirmation = null
}) {
  if (mode !== "live") {
    throw new Error(`unsupported_execution_mode: ${mode}; only live is supported`);
  }
  const input = {
    command: "trade once",
    mode,
    market: marketId,
    side,
    max_amount_usd: Number(maxAmountUsd),
    confirm_live: confirmation === "LIVE",
    env: summarizeEnvConfig(context.config, { mode })
  };
  if (context.config.liveWalletMode === "simulated") {
    return await new Scheduler(context).runSimulatedTradeOnce({
      mode,
      confirmation,
      marketId,
      side,
      maxAmountUsd: Number(maxAmountUsd)
    });
  }
  const { market, evidence, estimate } = await buildPrediction(context, marketId);
  const portfolio = await context.stateStore.getPortfolio();
  const decisionEngine = new DecisionEngine(context.config);
  const analysis = decisionEngine.analyze({ market, estimate, portfolio, amountUsd: maxAmountUsd });
  const chosenSide = side ?? analysis.suggested_side ?? "yes";
  const decision = decisionEngine.decide({ market, estimate, side: chosenSide, amountUsd: maxAmountUsd, portfolio });

  const liveBroker = new LiveBroker(context.config);
  let liveBalance = null;
  let liveBalanceError = null;
  if (confirmation === "LIVE") {
    try {
      liveBalance = await liveBroker.getBalance();
    } catch (error) {
      liveBalanceError = error instanceof Error ? error.message : String(error);
    }
  }

  const risk = await new RiskEngine(context.config, { stateStore: context.stateStore }).evaluate({
    decision,
    market,
    portfolio,
    mode,
    confirmation,
    evidence,
    estimate,
    liveBalance,
    liveBalanceError
  });
  const orderResult = await new OrderExecutor({ liveBroker }).execute({ risk, market, mode, confirmation });
  const action = oneShotAction({ mode, risk, orderResult });
  const artifacts = await context.artifactWriter.writeOnceRun({
    input,
    market,
    evidence,
    estimate,
    decision,
    risk,
    order: orderResult,
    action
  });
  const summary = {
    ok: true,
    mode,
    provider: estimate.diagnostics?.provider,
    effectiveProvider: estimate.diagnostics?.effectiveProvider,
    market_question: market.question,
    ai_probability: estimate.ai_probability,
    market_probability: decision.market_implied_probability ?? decision.marketProbability ?? null,
    edge: decision.edge ?? decision.grossEdge ?? null,
    net_edge: decision.netEdge ?? null,
    entry_fee_pct: decision.entryFeePct ?? null,
    quarter_kelly_pct: decision.quarterKellyPct ?? null,
    monthly_return: decision.monthlyReturn ?? null,
    action,
    artifact: artifacts.summary.path
  };
  return {
    ...summary,
    market,
    evidence,
    estimate,
    decision,
    risk,
    orderResult,
    artifacts
  };
}
