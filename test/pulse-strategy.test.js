import test from "node:test";
import assert from "node:assert/strict";
import {
  applyPulseMarketSelection,
  buildPulseTradePlan,
  calculateFeePct,
  calculateNetEdge,
  calculateQuarterKelly,
  lookupCategoryFeeParams
} from "../src/core/pulse-strategy.js";
import { DecisionEngine } from "../src/core/decision-engine.js";
import { RiskEngine } from "../src/core/risk-engine.js";
import { SAMPLE_MARKETS } from "../src/adapters/mock-market-source.js";

function market(overrides = {}) {
  return {
    ...SAMPLE_MARKETS[0],
    fetchedAt: new Date().toISOString(),
    ...overrides
  };
}

function estimate(aiProbability, confidence = "high") {
  return {
    marketId: SAMPLE_MARKETS[0].marketId,
    targetOutcome: "yes",
    ai_probability: aiProbability,
    aiProbability,
    confidence,
    reasoning_summary: "test",
    reasoningSummary: "test",
    key_evidence: [],
    keyEvidence: [],
    counter_evidence: [],
    counterEvidence: [],
    uncertainty_factors: [],
    uncertaintyFactors: [],
    freshness_score: 1,
    freshnessScore: 1,
    outcomeEstimates: [
      { tokenId: "token-fed-yes", label: "Yes", aiProbability, marketProbability: 0.43, confidence, evidenceIds: [] },
      { tokenId: "token-fed-no", label: "No", aiProbability: 1 - aiProbability, marketProbability: 0.58, confidence, evidenceIds: [] }
    ],
    diagnostics: {}
  };
}

function pulseConfig(overrides = {}) {
  return {
    pulse: {
      strategy: "pulse-direct",
      minLiquidityUsd: 5000,
      maxCandidates: 20,
      reportCandidates: 4,
      batchCapPct: 0.2,
      requireEvidenceGuard: false
    },
    risk: {
      maxTradePct: 0.05,
      maxTotalExposurePct: 0.5,
      maxEventExposurePct: 0.2,
      maxPositionCount: 20,
      maxPositionLossPct: 0.5,
      drawdownHaltPct: 0.2,
      liquidityTradeCapPct: 0.01,
      marketMaxAgeSeconds: 600,
      minAiConfidence: "medium",
      minTradeUsd: 1
    },
    evidence: {
      minEvidenceItems: 2
    },
    ...overrides
  };
}

test("pulse selection removes low-liquidity, missing-token, and short-term price markets", () => {
  const selected = applyPulseMarketSelection([
    market({ marketId: "good", marketSlug: "us-iran-nuclear-deal-by-june-30", question: "US-Iran nuclear deal by June 30?", liquidityUsd: 10000 }),
    market({ marketId: "low", marketSlug: "low-liquidity-politics", question: "Low liquidity?", liquidityUsd: 10 }),
    market({ marketId: "missing", outcomes: [{ id: "x", label: "Yes", tokenId: "", impliedProbability: 0.5 }] }),
    market({
      marketId: "eth",
      marketSlug: "ethereum-above-2000-on-may-5",
      eventSlug: "ethereum-above-on-may-5",
      question: "Will the price of Ethereum be above $2,000 on May 5?",
      category: "crypto",
      endDate: "2026-05-05T00:00:00.000Z",
      liquidityUsd: 10000
    })
  ], {
    minLiquidityUsd: 5000,
    maxCandidates: 20,
    nowMs: Date.parse("2026-05-01T00:00:00.000Z")
  });

  assert.deepEqual(selected.markets.map((item) => item.marketId), ["good"]);
  assert.equal(selected.removed.lowLiquidity, 1);
  assert.equal(selected.removed.missingClobTokenIds, 1);
  assert.equal(selected.removed.shortTermPrice, 1);
});

test("pulse fee and quarter Kelly formulas match predict-raven", () => {
  const politicsFee = lookupCategoryFeeParams("politics");
  assert.equal(politicsFee.feeRate, 0.04);
  assert.equal(calculateFeePct(0.5, politicsFee), 0.01);
  assert.equal(Number(calculateNetEdge(0.1, 0.5, politicsFee).toFixed(6)), 0.09);

  const kelly = calculateQuarterKelly({ aiProb: 0.6, marketProb: 0.5, bankrollUsd: 1000 });
  assert.equal(Number(kelly.fullKellyPct.toFixed(6)), 0.2);
  assert.equal(Number(kelly.quarterKellyPct.toFixed(6)), 0.05);
  assert.equal(Number(kelly.quarterKellyUsd.toFixed(6)), 50);
});

test("DecisionEngine pulse-direct uses net edge, quarter Kelly, and monthly return", () => {
  const cfg = pulseConfig();
  const decision = new DecisionEngine(cfg).analyze({
    market: market({ category: "economics" }),
    estimate: estimate(0.6),
    portfolio: { totalEquityUsd: 1000, positions: [] },
    amountUsd: 1
  });
  const expectedPlan = buildPulseTradePlan({
    market: market({ category: "economics" }),
    side: "yes",
    aiProb: 0.6,
    marketProb: 0.43,
    bankrollUsd: 1000
  });

  assert.equal(decision.action, "open");
  assert.equal(decision.suggested_side, "yes");
  assert.equal(decision.netEdge, expectedPlan.netEdge);
  assert.equal(decision.quarterKellyPct, expectedPlan.quarterKellyPct);
  assert.equal(decision.suggested_notional_before_risk, expectedPlan.suggestedNotionalUsd);
  assert.equal(typeof decision.monthlyReturn, "number");
});

test("RiskEngine pulse-direct warns instead of hard-blocking evidence confidence guards", async () => {
  const cfg = pulseConfig();
  const risk = await new RiskEngine(cfg).evaluate({
    decision: {
      action: "open",
      marketId: SAMPLE_MARKETS[0].marketId,
      eventId: SAMPLE_MARKETS[0].eventId,
      tokenId: SAMPLE_MARKETS[0].outcomes[0].tokenId,
      side: "BUY",
      requestedUsd: 1,
      confidence: "low",
      suggested_notional_before_risk: 1,
      sources: []
    },
    market: market(),
    portfolio: { totalEquityUsd: 1000, positions: [] },
    mode: "paper",
    evidence: [],
    estimate: {
      confidence: "low",
      uncertainty_factors: ["insufficient_evidence"],
      uncertaintyFactors: ["insufficient_evidence"]
    }
  });

  assert.equal(risk.allowed, true);
  assert.ok(risk.warnings.includes("insufficient_evidence"));
  assert.ok(risk.warnings.includes("ai_confidence_below_minimum"));
});
