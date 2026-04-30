import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateSchema } from "../src/domain/schemas.js";
import { EvidenceCrawler } from "../src/adapters/evidence-crawler.js";
import { ProbabilityEstimator } from "../src/core/probability-estimator.js";
import { DecisionEngine } from "../src/core/decision-engine.js";
import { SAMPLE_MARKETS } from "../src/adapters/mock-market-source.js";

const config = {
  risk: {
    minTradeUsd: 1
  },
  evidence: {
    minEvidenceItems: 2
  },
  ai: {
    provider: "test",
    model: "deterministic"
  }
};

const portfolio = {
  accountId: "paper",
  cashUsd: 1000,
  totalEquityUsd: 1000,
  positions: [],
  updatedAt: new Date().toISOString()
};

function evidence(overrides = {}) {
  const timestamp = new Date().toISOString();
  return {
    evidenceId: overrides.evidenceId ?? `evidence-${Math.random()}`,
    marketId: overrides.marketId ?? SAMPLE_MARKETS[0].marketId,
    source: overrides.source ?? "mock",
    sourceUrl: overrides.sourceUrl ?? "polypulse://mock/source",
    url: overrides.url ?? "polypulse://mock/source",
    title: overrides.title ?? "Official source",
    summary: overrides.summary ?? "Official source confirms the condition remains plausible.",
    status: overrides.status ?? "fetched",
    credibility: overrides.credibility ?? "high",
    retrievedAt: timestamp,
    timestamp,
    relevanceScore: overrides.relevanceScore ?? 0.9,
    relevance_score: overrides.relevance_score ?? overrides.relevanceScore ?? 0.9
  };
}

test("mock EvidenceCrawler output validates ProbabilityEstimator schema", async () => {
  const mockCrawler = {
    collect: async ({ market }) => [
      evidence({ marketId: market.marketId, evidenceId: "e1" }),
      evidence({ marketId: market.marketId, evidenceId: "e2", title: "Market rules" })
    ]
  };
  const market = SAMPLE_MARKETS[0];
  const estimator = new ProbabilityEstimator(config);
  const estimate = await estimator.estimate({ market, evidence: await mockCrawler.collect({ market }) });

  assert.equal(validateSchema("ProbabilityEstimate", estimate).ok, true);
  assert.equal(typeof estimate.ai_probability, "number");
  assert.ok(["low", "medium", "high"].includes(estimate.confidence));
  assert.ok(Array.isArray(estimate.key_evidence));
});

test("EvidenceCrawler adapters dedupe and cache fetched evidence", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "polypulse-evidence-"));
  let fetchCount = 0;
  const adapter = {
    id: "mock-search",
    search: async () => [
      { sourceUrl: "polypulse://same-source", title: "Same source" },
      { sourceUrl: "polypulse://same-source", title: "Same source" }
    ],
    fetch: async () => {
      fetchCount += 1;
      return evidence({
        source: "mock-search",
        sourceUrl: "polypulse://same-source",
        title: "Same source",
        evidenceId: "cached-evidence"
      });
    }
  };
  const crawler = new EvidenceCrawler({
    stateDir: dir,
    evidence: {
      cacheTtlSeconds: 60,
      requestTimeoutMs: 1000,
      requestRetries: 0
    }
  }, { adapters: [adapter] });

  const first = await crawler.collect({ market: SAMPLE_MARKETS[0] });
  const second = await crawler.collect({ market: SAMPLE_MARKETS[0] });

  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(fetchCount, 1);
  assert.equal(second[0].status, "cached");
});

test("DecisionEngine opens positive edge from deterministic fake AI output", async () => {
  const market = SAMPLE_MARKETS[0];
  const estimator = new ProbabilityEstimator(config, {
    provider: {
      estimate: async ({ evidence: items }) => ({
        ai_probability: 0.7,
        confidence: "high",
        reasoning_summary: "Deterministic test probability.",
        key_evidence: items,
        counter_evidence: [],
        uncertainty_factors: [],
        freshness_score: 1
      })
    }
  });
  const estimate = await estimator.estimate({ market, evidence: [evidence({ evidenceId: "e1" }), evidence({ evidenceId: "e2" })] });
  const decision = new DecisionEngine().analyze({ market, estimate, portfolio, amountUsd: 1 });

  assert.equal(decision.action, "open");
  assert.equal(decision.suggested_side, "yes");
  assert.ok(decision.edge > 0);
  assert.ok(decision.expected_value > 0);
});

test("DecisionEngine can suggest no side when edge is negative for yes", async () => {
  const market = SAMPLE_MARKETS[0];
  const estimator = new ProbabilityEstimator(config, {
    provider: {
      estimate: async ({ evidence: items }) => ({
        ai_probability: 0.2,
        confidence: "high",
        reasoning_summary: "Deterministic test probability.",
        key_evidence: items,
        counter_evidence: [],
        uncertainty_factors: [],
        freshness_score: 1
      })
    }
  });
  const estimate = await estimator.estimate({ market, evidence: [evidence({ evidenceId: "e1" }), evidence({ evidenceId: "e2" })] });
  const yesDecision = new DecisionEngine().decide({ market, estimate, side: "yes", portfolio, amountUsd: 1 });
  const bestDecision = new DecisionEngine().analyze({ market, estimate, portfolio, amountUsd: 1 });

  assert.equal(yesDecision.action, "skip");
  assert.equal(yesDecision.noTradeReason, "edge_below_threshold");
  assert.equal(bestDecision.suggested_side, "no");
});

test("DecisionEngine no-trades when evidence is insufficient", async () => {
  const market = SAMPLE_MARKETS[0];
  const estimator = new ProbabilityEstimator(config, {
    provider: {
      estimate: async () => ({
        ai_probability: 0.9,
        confidence: "low",
        reasoning_summary: "Not enough evidence.",
        key_evidence: [],
        counter_evidence: [],
        uncertainty_factors: ["insufficient_evidence"],
        freshness_score: 0.2
      })
    }
  });
  const estimate = await estimator.estimate({ market, evidence: [] });
  const decision = new DecisionEngine().analyze({ market, estimate, portfolio, amountUsd: 1 });

  assert.equal(decision.action, "skip");
  assert.equal(decision.noTradeReason, "insufficient_evidence");
});
