import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadEnvConfig } from "../src/config/env.js";
import { SimulatedMonitorLedger } from "../src/simulated/simulated-monitor-ledger.js";
import { Scheduler } from "../src/scheduler/scheduler.js";

function market({ yesPrice = 0.2, slug = "simulated-market" } = {}) {
  return {
    marketId: "sim-1",
    eventId: "event-1",
    marketSlug: slug,
    eventSlug: "event-1",
    question: "Will the simulated event happen?",
    title: "Will the simulated event happen?",
    marketUrl: "https://polymarket.com/event/simulated-market",
    outcomes: [
      {
        id: "sim-1-yes",
        label: "Yes",
        tokenId: "yes-token",
        bestBid: yesPrice,
        bestAsk: yesPrice,
        lastPrice: yesPrice,
        impliedProbability: yesPrice
      },
      {
        id: "sim-1-no",
        label: "No",
        tokenId: "no-token",
        bestBid: 1 - yesPrice,
        bestAsk: 1 - yesPrice,
        lastPrice: 1 - yesPrice,
        impliedProbability: 1 - yesPrice
      }
    ],
    endDate: "2026-12-31T00:00:00.000Z",
    resolutionRules: "Simulated resolution rules.",
    resolutionSourceUrl: null,
    liquidityUsd: 10000,
    volumeUsd: 100,
    volume24hUsd: 100,
    category: "test",
    tags: [],
    active: true,
    closed: false,
    tradable: true,
    source: "test",
    riskFlags: [],
    fetchedAt: new Date().toISOString()
  };
}

function highYesEstimate(inputMarket) {
  return {
    marketId: inputMarket.marketId,
    targetOutcome: "yes",
    ai_probability: 0.8,
    aiProbability: 0.8,
    confidence: "high",
    reasoning_summary: "High simulated yes probability.",
    reasoningSummary: "High simulated yes probability.",
    key_evidence: [],
    keyEvidence: [],
    counter_evidence: [],
    counterEvidence: [],
    uncertainty_factors: [],
    uncertaintyFactors: [],
    freshness_score: 1,
    freshnessScore: 1,
    outcomeEstimates: [
      { tokenId: "yes-token", label: "Yes", aiProbability: 0.8, marketProbability: inputMarket.outcomes[0].impliedProbability, confidence: "high", reasoning: "test", evidenceIds: [] },
      { tokenId: "no-token", label: "No", aiProbability: 0.2, marketProbability: inputMarket.outcomes[1].impliedProbability, confidence: "high", reasoning: "test", evidenceIds: [] }
    ],
    diagnostics: { provider: "test", effectiveProvider: "test" }
  };
}

async function configForTest(dir) {
  const envPath = path.join(dir, "live.env");
  await writeFile(envPath, [
    "POLYPULSE_EXECUTION_MODE=live",
    "POLYPULSE_LIVE_WALLET_MODE=simulated",
    "SIMULATED_WALLET_BALANCE_USD=100",
    `SIMULATED_MONITOR_LOG_PATH=${path.join(dir, "simulated-monitor.log")}`,
    "POLYPULSE_MARKET_SOURCE=polymarket",
    "POLYMARKET_GAMMA_HOST=https://gamma-api.polymarket.com",
    "CHAIN_ID=137",
    "POLYMARKET_HOST=https://clob.polymarket.com",
    "PULSE_MIN_LIQUIDITY_USD=0",
    "MIN_AI_CONFIDENCE=high",
    "MIN_TRADE_USD=1",
    "MAX_TRADE_PCT=1",
    "MAX_TOTAL_EXPOSURE_PCT=1",
    "MAX_EVENT_EXPOSURE_PCT=1",
    "LIQUIDITY_TRADE_CAP_PCT=1",
    "MONITOR_MAX_TRADES_PER_ROUND=2",
    "MONITOR_MAX_DAILY_TRADE_USD=10",
    "MONITOR_CONCURRENCY=1",
    "MONITOR_BACKOFF_MS=0",
    "EVIDENCE_CACHE_TTL_SECONDS=0"
  ].join("\n"), "utf8");
  return await loadEnvConfig({ envFile: envPath });
}

test("simulated monitor ledger records open, close, pnl, and win rate in a human log", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "polypulse-ledger-"));
  const config = await configForTest(dir);
  const ledger = new SimulatedMonitorLedger(config);
  const inputMarket = market({ yesPrice: 0.2 });
  const risk = {
    allowed: true,
    allow: true,
    order: { orderId: "risk-order", mode: "live", marketId: inputMarket.marketId, tokenId: "yes-token", side: "BUY", amountUsd: 1 },
    approvedUsd: 1,
    blockedReasons: [],
    reasons: []
  };
  const decision = {
    tokenId: "yes-token",
    suggested_side: "yes",
    marketProbability: 0.2,
    aiProbability: 0.8,
    netEdge: 0.5,
    monthlyReturn: 0.1
  };

  const order = await ledger.openPosition({ market: inputMarket, decision, risk });
  assert.equal(order.status, "filled");
  assert.equal(ledger.positions.length, 1);

  ledger.positions[0].currentPrice = 0.8;
  ledger.positions[0].currentValueUsd = 4;
  ledger.positions[0].unrealizedPnlUsd = 3;
  const closed = await ledger.closePosition(ledger.positions[0].positionId, "test_take_profit");
  assert.equal(closed.realizedPnlUsd, 3);
  assert.equal(ledger.statistics().wins, 1);
  assert.equal(ledger.statistics().winRate, 1);

  const log = await readFile(config.simulatedMonitorLogPath, "utf8");
  assert.match(log, /open\.filled/);
  assert.match(log, /close\.filled/);
  assert.match(log, /realized_pnl_usd=3/);
});

test("simulated monitor run uses log-only in-memory state instead of persistent state artifacts", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "polypulse-sim-monitor-"));
  const config = await configForTest(dir);
  const inputMarket = market({ yesPrice: 0.2 });
  const forbiddenStateStore = new Proxy({}, {
    get(_target, key) {
      throw new Error(`stateStore should not be used by simulated monitor: ${String(key)}`);
    }
  });
  const forbiddenArtifactWriter = new Proxy({}, {
    get(_target, key) {
      throw new Error(`artifactWriter should not be used by simulated monitor: ${String(key)}`);
    }
  });
  const scheduler = new Scheduler({
    config,
    stateStore: forbiddenStateStore,
    artifactWriter: forbiddenArtifactWriter,
    marketSource: {
      async scan(request) {
        assert.equal(request.noCache, true);
        return {
          source: "test",
          fetchedAt: new Date().toISOString(),
          totalFetched: 1,
          totalReturned: 1,
          riskFlags: [],
          markets: [inputMarket]
        };
      },
      async getMarket() {
        return inputMarket;
      }
    }
  });
  assert.equal(scheduler.probabilityEstimator.config.suppressProviderRuntimeArtifacts, true);
  scheduler.evidenceCrawler = {
    async collect({ noCache }) {
      assert.equal(noCache, true);
      return [
        { status: "fetched", relevanceScore: 1 },
        { status: "fetched", relevanceScore: 1 }
      ];
    }
  };
  scheduler.probabilityEstimator = {
    async estimate({ market: estimateMarket }) {
      return highYesEstimate(estimateMarket);
    }
  };

  const result = await scheduler.runMonitorRound({
    mode: "live",
    confirmation: "LIVE",
    limit: 1,
    maxAmountUsd: 1
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "simulated-orders");
  assert.equal(result.performance.openPositions, 1);
  const log = await readFile(config.simulatedMonitorLogPath, "utf8");
  assert.match(log, /topics\.fetched/);
  assert.match(log, /prediction/);
  assert.match(log, /risk/);
  assert.match(log, /open\.filled/);
  assert.match(log, /round\.end/);
});

test("simulated monitor closes positions by signal and records performance", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "polypulse-sim-close-"));
  const config = await configForTest(dir);
  config.monitor.maxTradesPerRound = 0;
  const openMarket = market({ yesPrice: 0.2 });
  const stopLossMarket = market({ yesPrice: 0.05 });
  const scheduler = new Scheduler({
    config,
    stateStore: {},
    artifactWriter: {},
    marketSource: {
      async scan(request) {
        assert.equal(request.noCache, true);
        return {
          source: "test",
          fetchedAt: new Date().toISOString(),
          totalFetched: 1,
          totalReturned: 1,
          riskFlags: [],
          markets: [stopLossMarket]
        };
      },
      async getMarket(_id, request = {}) {
        assert.equal(request.noCache, true);
        return stopLossMarket;
      }
    }
  });
  scheduler.evidenceCrawler = {
    async collect({ noCache }) {
      assert.equal(noCache, true);
      return [{ status: "fetched", relevanceScore: 1 }];
    }
  };
  scheduler.probabilityEstimator = {
    async estimate({ market: estimateMarket }) {
      return highYesEstimate(estimateMarket);
    }
  };

  await scheduler.simulatedLedger.openPosition({
    market: openMarket,
    decision: {
      tokenId: "yes-token",
      suggested_side: "yes",
      marketProbability: 0.2,
      aiProbability: 0.8,
      netEdge: 0.5,
      monthlyReturn: 0.1
    },
    risk: {
      allowed: true,
      order: { amountUsd: 1 },
      approvedUsd: 1,
      blockedReasons: []
    }
  });

  const result = await scheduler.runMonitorRound({
    mode: "live",
    confirmation: "LIVE",
    limit: 1,
    maxAmountUsd: 1
  });

  assert.equal(result.ok, true);
  assert.equal(result.performance.openPositions, 0);
  assert.equal(result.performance.closedTrades, 1);
  assert.equal(result.performance.losses, 1);
  assert.equal(result.performance.realizedPnlUsd, -0.75);
  const log = await readFile(config.simulatedMonitorLogPath, "utf8");
  assert.match(log, /close\.filled/);
  assert.match(log, /reason=stop_loss/);
  assert.match(log, /losses=1/);
});
