import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RiskEngine } from "../src/core/risk-engine.js";
import { FileStateStore } from "../src/state/file-state-store.js";
import { SAMPLE_MARKETS } from "../src/adapters/mock-market-source.js";

function config(overrides = {}) {
  const { risk = {}, evidence = {}, ...rest } = overrides;
  return {
    executionMode: "paper",
    envFilePath: null,
    privateKey: "",
    funderAddress: "",
    signatureType: "",
    chainId: 137,
    polymarketHost: "",
    stateDir: "/tmp/polypulse-risk",
    artifactDir: "/tmp/polypulse-risk-artifacts",
    risk: {
      maxTradePct: 0.05,
      maxTotalExposurePct: 0.5,
      maxEventExposurePct: 0.2,
      maxPositionCount: 3,
      maxPositionLossPct: 0.5,
      drawdownHaltPct: 0.2,
      liquidityTradeCapPct: 0.01,
      marketMaxAgeSeconds: 600,
      minAiConfidence: "medium",
      minTradeUsd: 1,
      ...risk
    },
    evidence: {
      minEvidenceItems: 2,
      ...evidence
    },
    scan: {
      marketScanLimit: 1000,
      pageSize: 100,
      maxPages: 20,
      cacheTtlSeconds: 300,
      requestTimeoutMs: 10000,
      requestRetries: 2,
      rateLimitMs: 250,
      minFetchedMarkets: 20
    },
    monitor: { intervalSeconds: 300 },
    ai: { provider: "local", model: "", command: "" },
    ...rest
  };
}

function market(overrides = {}) {
  return {
    ...SAMPLE_MARKETS[0],
    fetchedAt: new Date().toISOString(),
    ...overrides
  };
}

function portfolio(overrides = {}) {
  return {
    accountId: "paper",
    cashUsd: 1000,
    totalEquityUsd: 1000,
    positions: [],
    updatedAt: new Date().toISOString(),
    ...overrides
  };
}

function evidence(count = 2) {
  return Array.from({ length: count }).map((_, index) => ({
    evidenceId: `e-${index}`,
    marketId: SAMPLE_MARKETS[0].marketId,
    source: "test",
    sourceUrl: `polypulse://e/${index}`,
    url: `polypulse://e/${index}`,
    title: `Evidence ${index}`,
    summary: "Relevant evidence.",
    status: "fetched",
    credibility: "high",
    retrievedAt: new Date().toISOString(),
    timestamp: new Date().toISOString(),
    relevanceScore: 0.9,
    relevance_score: 0.9
  }));
}

function estimate(overrides = {}) {
  return {
    marketId: SAMPLE_MARKETS[0].marketId,
    confidence: "high",
    uncertainty_factors: [],
    uncertaintyFactors: [],
    key_evidence: evidence(2),
    ...overrides
  };
}

function decision(overrides = {}) {
  return {
    action: "open",
    marketId: SAMPLE_MARKETS[0].marketId,
    eventId: SAMPLE_MARKETS[0].eventId,
    tokenId: SAMPLE_MARKETS[0].outcomes[0].tokenId,
    side: "BUY",
    requestedUsd: 10,
    confidence: "high",
    suggested_notional_before_risk: 10,
    sources: ["e-1", "e-2"],
    ...overrides
  };
}

async function evaluate(input = {}) {
  const cfg = config(input.config ?? {});
  const engine = new RiskEngine(cfg, input.stateStore ? { stateStore: input.stateStore } : {});
  return await engine.evaluate({
    decision: decision(input.decision ?? {}),
    market: market(input.market ?? {}),
    portfolio: portfolio(input.portfolio ?? {}),
    mode: input.mode ?? "paper",
    confirmation: input.confirmation ?? null,
    evidence: input.evidence ?? evidence(2),
    estimate: estimate(input.estimate ?? {}),
    systemState: input.systemState ?? null,
    liveBalance: input.liveBalance ?? null,
    liveBalanceError: input.liveBalanceError ?? null
  });
}

test("system paused and halted block new opens", async () => {
  assert.ok((await evaluate({ systemState: { status: "paused", highWaterMarkUsd: 1000 } })).blocked_reasons.includes("system_paused"));
  assert.ok((await evaluate({ systemState: { status: "halted", highWaterMarkUsd: 1000 } })).blocked_reasons.includes("system_halted_requires_explicit_resume"));
});

test("drawdown halt persists until explicit resume", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "polypulse-risk-state-"));
  const cfg = config({ stateDir: dir });
  const store = new FileStateStore(cfg);
  const state = await store.readState();
  state.portfolio.totalEquityUsd = 700;
  state.portfolio.cashUsd = 700;
  state.riskState.highWaterMarkUsd = 1000;
  await store.writeState(state);

  const halted = await new RiskEngine(cfg, { stateStore: store }).evaluate({
    decision: decision(),
    market: market(),
    portfolio: await store.getPortfolio(),
    mode: "paper",
    evidence: evidence(2),
    estimate: estimate()
  });
  assert.ok(halted.blocked_reasons.includes("drawdown_halt_threshold_exceeded"));
  assert.equal((await store.getRiskState()).status, "halted");

  await store.resumeRisk();
  const resumed = await new RiskEngine(cfg, { stateStore: store }).evaluate({
    decision: decision(),
    market: market(),
    portfolio: await store.getPortfolio(),
    mode: "paper",
    evidence: evidence(2),
    estimate: estimate()
  });
  assert.equal(resumed.blocked_reasons.includes("system_halted_requires_explicit_resume"), false);
});

test("position loss triggers reduce or close warning", async () => {
  const risk = await evaluate({
    portfolio: {
      positions: [{ marketId: "old", tokenId: "old-token", size: 10, avgPrice: 1, currentValueUsd: 3 }]
    }
  });
  assert.ok(risk.warnings.some((item) => item.includes("position_loss_limit_triggered")));
});

test("max position count blocks new token", async () => {
  const risk = await evaluate({
    config: { risk: { maxPositionCount: 1 } },
    portfolio: {
      positions: [{ marketId: "other", tokenId: "other-token", size: 1, avgPrice: 1, currentValueUsd: 1 }]
    }
  });
  assert.ok(risk.blocked_reasons.includes("above_max_position_count"));
});

test("trade notional is clipped by max trade, total exposure, event exposure, and liquidity cap", async () => {
  const risk = await evaluate({
    decision: { requestedUsd: 500, suggested_notional_before_risk: 500 },
    portfolio: {
      totalEquityUsd: 1000,
      positions: [{ marketId: SAMPLE_MARKETS[0].marketId, tokenId: "existing", size: 1, avgPrice: 1, currentValueUsd: 195 }]
    },
    market: { liquidityUsd: 10000 }
  });
  assert.equal(risk.adjusted_notional, 5);
  assert.equal(risk.allowed, true);
  assert.ok("maxTradeUsd" in risk.applied_limits);
  assert.ok("maxEventExposureUsd" in risk.applied_limits);
});

test("minimum trade and downward clipping below minimum block the trade", async () => {
  assert.ok((await evaluate({ decision: { requestedUsd: 0.5, suggested_notional_before_risk: 0.5 } })).blocked_reasons.includes("below_min_trade_usd"));
  const clipped = await evaluate({
    decision: { requestedUsd: 10, suggested_notional_before_risk: 10 },
    market: { liquidityUsd: 50 }
  });
  assert.ok(clipped.blocked_reasons.includes("adjusted_notional_below_min_trade_usd"));
});

test("stale market, missing evidence, low confidence, missing token, and closed/inactive states block opens", async () => {
  assert.ok((await evaluate({ market: { fetchedAt: "2020-01-01T00:00:00.000Z" } })).blocked_reasons.includes("market_data_stale"));
  assert.ok((await evaluate({ evidence: [], estimate: { uncertainty_factors: ["insufficient_evidence"], uncertaintyFactors: ["insufficient_evidence"] } })).blocked_reasons.includes("insufficient_evidence"));
  assert.ok((await evaluate({ estimate: { confidence: "low" } })).blocked_reasons.includes("ai_confidence_below_minimum"));
  assert.ok((await evaluate({ decision: { tokenId: "bad-token" } })).blocked_reasons.includes("token_not_in_market_snapshot"));
  const inactive = await evaluate({ market: { active: false, closed: true, tradable: false } });
  assert.ok(inactive.blocked_reasons.includes("market_closed"));
  assert.ok(inactive.blocked_reasons.includes("market_inactive"));
  assert.ok(inactive.blocked_reasons.includes("market_not_tradable"));
});

test("AI-proposed token outside the market snapshot is rejected as overreach", async () => {
  const risk = await evaluate({
    decision: {
      tokenId: "ai-invented-token-id",
      sources: ["e-1", "e-2"]
    }
  });

  assert.equal(risk.allowed, false);
  assert.ok(risk.blocked_reasons.includes("token_not_in_market_snapshot"));
});

test("live mode requires confirmation, env preflight, and balance check", async () => {
  assert.ok((await evaluate({ mode: "live" })).blocked_reasons.includes("live_requires_confirm_live"));
  assert.ok((await evaluate({ mode: "live", confirmation: "LIVE" })).blocked_reasons.includes("live_preflight_failed"));
  const liveOkCfg = {
    executionMode: "live",
    envFilePath: "/tmp/live.env",
    privateKey: "in-memory",
    funderAddress: "0x1111111111111111111111111111111111111111",
    signatureType: "1",
    polymarketHost: "https://clob.polymarket.com"
  };
  assert.ok((await evaluate({ mode: "live", confirmation: "LIVE", config: liveOkCfg })).blocked_reasons.includes("live_balance_check_missing"));
  assert.ok((await evaluate({ mode: "live", confirmation: "LIVE", config: liveOkCfg, liveBalance: { collateralBalance: 1 } })).blocked_reasons.includes("insufficient_live_collateral"));
});

test("AI suggested notional can only be clipped downward", async () => {
  const risk = await evaluate({ decision: { requestedUsd: 2, suggested_notional_before_risk: 50 } });
  assert.equal(risk.adjusted_notional, 2);
});
