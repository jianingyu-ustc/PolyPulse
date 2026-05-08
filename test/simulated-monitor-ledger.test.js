import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadEnvConfig } from "../src/config/env.js";
import { SimulatedMonitorLedger } from "../src/simulated/simulated-monitor-ledger.js";
import { Scheduler } from "../src/scheduler/scheduler.js";

function market({ yesPrice = 0.2, slug = "simulated-market", marketId = "sim-1", eventId = "event-1" } = {}) {
  return {
    marketId,
    eventId,
    marketSlug: slug,
    eventSlug: eventId,
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

function estimateForMarket(inputMarket, { aiProbability = 0.8, confidence = "high" } = {}) {
  const noProbability = Number((1 - aiProbability).toFixed(6));
  return {
    marketId: inputMarket.marketId,
    targetOutcome: "yes",
    ai_probability: aiProbability,
    aiProbability,
    confidence,
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
      { tokenId: "yes-token", label: "Yes", aiProbability, marketProbability: inputMarket.outcomes[0].impliedProbability, confidence, reasoning: "test", evidenceIds: [] },
      { tokenId: "no-token", label: "No", aiProbability: noProbability, marketProbability: inputMarket.outcomes[1].impliedProbability, confidence, reasoning: "test", evidenceIds: [] }
    ],
    diagnostics: { provider: "test", effectiveProvider: "test" }
  };
}

function highYesEstimate(inputMarket) {
  return estimateForMarket(inputMarket);
}

async function configForTest(dir) {
  const envPath = path.join(dir, "live.env");
  await writeFile(envPath, [
    "POLYPULSE_LIVE_WALLET_MODE=simulated",
    "SIMULATED_WALLET_BALANCE_USD=100",
    `SIMULATED_MONITOR_LOG_PATH=${path.join(dir, "simulated-monitor.log")}`,
    "POLYPULSE_MARKET_SOURCE=polymarket",
    "POLYMARKET_GAMMA_HOST=https://gamma-api.polymarket.com",
    "CHAIN_ID=137",
    "POLYMARKET_HOST=https://clob.polymarket.com",
    "PULSE_MIN_LIQUIDITY_USD=0",
    "PULSE_AI_PRESCREEN=false",
    "PULSE_AI_CANDIDATE_TRIAGE=false",
    "PULSE_AI_TOPIC_DISCOVERY=false",
    "PULSE_AI_EVIDENCE_RESEARCH=false",
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

test("simulated monitor ranks candidates by AI-derived opportunity before execution", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "polypulse-sim-rank-"));
  const config = await configForTest(dir);
  config.monitor.maxTradesPerRound = 1;
  const lowerOpportunity = market({
    marketId: "sim-low",
    eventId: "event-low",
    slug: "lower-opportunity",
    yesPrice: 0.3
  });
  const higherOpportunity = market({
    marketId: "sim-high",
    eventId: "event-high",
    slug: "higher-opportunity",
    yesPrice: 0.2
  });
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
          totalFetched: 2,
          totalReturned: 2,
          riskFlags: [],
          markets: [lowerOpportunity, higherOpportunity]
        };
      },
      async getMarket(id) {
        return [lowerOpportunity, higherOpportunity].find((item) => item.marketId === id || item.marketSlug === id) ?? null;
      }
    }
  });
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
      return estimateForMarket(estimateMarket, {
        aiProbability: estimateMarket.marketSlug === "higher-opportunity" ? 0.85 : 0.35,
        confidence: "high"
      });
    }
  };

  const result = await scheduler.runMonitorRound({
    mode: "live",
    confirmation: "LIVE",
    limit: 2,
    maxAmountUsd: 1
  });

  assert.equal(result.ok, true);
  assert.equal(result.performance.openPositions, 1);
  assert.equal(scheduler.simulatedLedger.positions[0].marketSlug, "higher-opportunity");
  const log = await readFile(config.simulatedMonitorLogPath, "utf8");
  assert.match(log, /candidate\.ranked \| rank=1 market=higher-opportunity/);
  assert.match(log, /open\.filled \| market=higher-opportunity/);
});

test("simulated monitor applies AI candidate triage before probability estimation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "polypulse-sim-triage-"));
  const config = await configForTest(dir);
  const rejectedMarket = market({
    marketId: "sim-reject",
    eventId: "event-reject",
    slug: "unresearchable-candidate",
    yesPrice: 0.2
  });
  const keptMarket = market({
    marketId: "sim-keep",
    eventId: "event-keep",
    slug: "researchable-candidate",
    yesPrice: 0.2
  });
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
          totalFetched: 2,
          totalReturned: 2,
          riskFlags: [],
          markets: [rejectedMarket, keptMarket]
        };
      },
      async getMarket(id) {
        return [rejectedMarket, keptMarket].find((item) => item.marketId === id || item.marketSlug === id) ?? null;
      }
    }
  });
  scheduler.candidateTriageProvider = {
    async triage({ candidates }) {
      assert.equal(candidates.length, 2);
      return {
        candidate_assessments: [
          {
            marketId: rejectedMarket.marketId,
            marketSlug: rejectedMarket.marketSlug,
            recommended_action: "reject",
            priority_score: 0.05,
            researchability: "low",
            information_advantage: "low",
            cluster: "unclear-resolution",
            rationale: "Resolution is too hard to research independently.",
            evidence_gaps: ["official_resolution_source"]
          },
          {
            marketId: keptMarket.marketId,
            marketSlug: keptMarket.marketSlug,
            recommended_action: "prioritize",
            priority_score: 0.95,
            researchability: "high",
            information_advantage: "high",
            cluster: "researchable-events",
            rationale: "Independent public sources should exist.",
            evidence_gaps: ["official_schedule", "recent_news"]
          }
        ],
        clusters: [{ name: "researchable-events", marketIds: [keptMarket.marketId], rationale: "test" }],
        research_gaps: ["official_schedule", "recent_news"],
        diagnostics: { provider: "test" }
      };
    }
  };
  scheduler.evidenceCrawler = {
    async collect({ market: evidenceMarket, noCache }) {
      assert.equal(noCache, true);
      assert.equal(evidenceMarket.marketSlug, keptMarket.marketSlug);
      return [{ status: "fetched", relevanceScore: 1 }];
    }
  };
  scheduler.probabilityEstimator = {
    async estimate({ market: estimateMarket }) {
      assert.equal(estimateMarket.marketSlug, keptMarket.marketSlug);
      return highYesEstimate(estimateMarket);
    }
  };

  const result = await scheduler.runMonitorRound({
    mode: "live",
    confirmation: "LIVE",
    limit: 2,
    maxAmountUsd: 1
  });

  assert.equal(result.ok, true);
  assert.equal(result.performance.openPositions, 1);
  assert.equal(scheduler.simulatedLedger.positions[0].marketSlug, keptMarket.marketSlug);
  const log = await readFile(config.simulatedMonitorLogPath, "utf8");
  assert.match(log, /candidate\.triage \| market=unresearchable-candidate action=reject/);
  assert.match(log, /candidate \| market=unresearchable-candidate selected=false reasons=ai_triage_reject/);
  assert.match(log, /candidate\.triage_summary/);
});

test("simulated trade once uses the same in-memory ledger and human log format as monitor", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "polypulse-sim-once-"));
  const config = await configForTest(dir);
  const inputMarket = market({ yesPrice: 0.2 });
  const forbiddenStateStore = new Proxy({}, {
    get(_target, key) {
      throw new Error(`stateStore should not be used by simulated trade once: ${String(key)}`);
    }
  });
  const forbiddenArtifactWriter = new Proxy({}, {
    get(_target, key) {
      throw new Error(`artifactWriter should not be used by simulated trade once: ${String(key)}`);
    }
  });
  const scheduler = new Scheduler({
    config,
    stateStore: forbiddenStateStore,
    artifactWriter: forbiddenArtifactWriter,
    marketSource: {
      async getMarket(id, request = {}) {
        assert.equal(id, inputMarket.marketId);
        assert.equal(request.noCache, true);
        return inputMarket;
      }
    }
  });
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

  const result = await scheduler.runSimulatedTradeOnce({
    mode: "live",
    confirmation: "LIVE",
    marketId: inputMarket.marketId,
    maxAmountUsd: 1
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "simulated-orders");
  assert.equal(result.artifact, config.simulatedMonitorLogPath);
  assert.equal(result.performance.cashUsd, 99);
  assert.equal(result.performance.openPositions, 1);
  const log = await readFile(config.simulatedMonitorLogPath, "utf8");
  assert.match(log, /simulated live monitor session started/);
  assert.match(log, /round\.start/);
  assert.match(log, /topics\.fetched/);
  assert.match(log, /candidate/);
  assert.match(log, /prediction/);
  assert.match(log, /risk/);
  assert.match(log, /open\.filled/);
  assert.match(log, /round\.end/);
});

test("acceptance round uses monitor candidate ranking instead of the first scanned market", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "polypulse-acceptance-rank-"));
  const config = await configForTest(dir);
  config.monitor.maxTradesPerRound = 1;
  const firstScanned = market({
    yesPrice: 0.8,
    slug: "first-scanned-low-edge",
    marketId: "first-scanned",
    eventId: "event-first"
  });
  const betterCandidate = market({
    yesPrice: 0.2,
    slug: "second-scanned-high-edge",
    marketId: "second-scanned",
    eventId: "event-second"
  });
  const scheduler = new Scheduler({
    config,
    stateStore: {},
    artifactWriter: {},
    marketSource: {
      async scan(request) {
        assert.equal(request.noCache, true);
        assert.equal(request.limit, 2);
        return {
          source: "test",
          fetchedAt: new Date().toISOString(),
          totalFetched: 2,
          totalReturned: 2,
          riskFlags: [],
          markets: [firstScanned, betterCandidate]
        };
      }
    }
  });
  scheduler.topicDiscoveryProvider = null;
  scheduler.preScreenProvider = null;
  scheduler.candidateTriageProvider = null;
  scheduler.evidenceResearchProvider = null;
  scheduler.evidenceCrawler = {
    async collect({ noCache }) {
      assert.equal(noCache, true);
      return [
        { status: "fetched", relevanceScore: 1, source: "test-source" },
        { status: "fetched", relevanceScore: 1, source: "test-source-2" }
      ];
    }
  };
  scheduler.probabilityEstimator = {
    async estimate({ market: estimateMarket }) {
      return estimateForMarket(estimateMarket, {
        aiProbability: estimateMarket.marketId === betterCandidate.marketId ? 0.8 : 0.82,
        confidence: "high"
      });
    }
  };

  const result = await scheduler.runAcceptanceRound({
    mode: "live",
    confirmation: "LIVE",
    limit: 2,
    maxAmountUsd: 1
  });

  assert.equal(result.ok, true);
  assert.equal(result.stages.scan.markets[0].marketSlug, firstScanned.marketSlug);
  assert.equal(result.stages.prediction.ranked[0].marketSlug, betterCandidate.marketSlug);
  assert.equal(result.stages.execution.filledOrders.length, 1);
  assert.equal(result.stages.execution.filledOrders[0].marketSlug, betterCandidate.marketSlug);
  const log = await readFile(config.simulatedMonitorLogPath, "utf8");
  assert.match(log, /candidate\.ranked \| rank=1 market=second-scanned-high-edge/);
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
