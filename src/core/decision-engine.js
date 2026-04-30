import { assertSchema } from "../domain/schemas.js";

const FEE_ALLOWANCE = 0.005;
const SLIPPAGE_ALLOWANCE = 0.005;
const MIN_NET_EDGE = 0.02;

function normalizeSide(value) {
  return String(value).toLowerCase() === "no" ? "no" : "yes";
}

function round(value, digits = 6) {
  return Number(Number(value).toFixed(digits));
}

function outcomeForSide(market, side) {
  const wanted = normalizeSide(side);
  return market.outcomes.find((item) => item.label.toLowerCase() === wanted)
    ?? (wanted === "yes" ? market.outcomes[0] : market.outcomes[1])
    ?? market.outcomes[0]
    ?? null;
}

function estimateForSide(estimate, side) {
  const wanted = normalizeSide(side);
  return estimate.outcomeEstimates.find((item) => item.label.toLowerCase() === wanted)
    ?? (wanted === "yes" ? estimate.outcomeEstimates[0] : estimate.outcomeEstimates[1])
    ?? estimate.outcomeEstimates[0]
    ?? null;
}

function marketProbability(outcome, estimateOutcome) {
  return estimateOutcome?.marketProbability
    ?? outcome?.bestAsk
    ?? outcome?.impliedProbability
    ?? outcome?.lastPrice
    ?? outcome?.bestBid
    ?? null;
}

function suggestedNotional({ portfolio, netEdge, amountUsd }) {
  if (!portfolio?.totalEquityUsd || netEdge <= 0) {
    return Number(amountUsd ?? 0);
  }
  const edgeScaledPct = Math.min(0.05, Math.max(0.005, netEdge));
  return round(Math.max(Number(amountUsd ?? 1), portfolio.totalEquityUsd * edgeScaledPct), 4);
}

function sourceIds(estimate) {
  return [...new Set([
    ...estimate.outcomeEstimates.flatMap((item) => item.evidenceIds ?? []),
    ...(estimate.key_evidence ?? []).map((item) => item.evidenceId)
  ].filter(Boolean))];
}

export function buildTradeCandidate({ market, estimate, side = "yes", portfolio = null, amountUsd = 1 }) {
  const wantedSide = normalizeSide(side);
  const outcome = outcomeForSide(market, wantedSide);
  const outcomeEstimate = estimateForSide(estimate, wantedSide);
  const implied = marketProbability(outcome, outcomeEstimate);
  if (!outcome || !outcomeEstimate || implied == null) {
    return null;
  }

  const aiProbability = round(outcomeEstimate.aiProbability);
  const grossEdge = round(aiProbability - implied);
  const netEdge = round(grossEdge - FEE_ALLOWANCE - SLIPPAGE_ALLOWANCE);
  const notional = suggestedNotional({ portfolio, netEdge, amountUsd });
  const expectedValue = round(netEdge * notional, 4);
  const insufficientEvidence = estimate.confidence === "low"
    || (estimate.uncertainty_factors ?? []).includes("insufficient_evidence")
    || (estimate.freshness_score ?? 0) < 0.4;
  const noTradeReason = insufficientEvidence
    ? "insufficient_evidence"
    : netEdge < MIN_NET_EDGE
      ? "edge_below_threshold"
      : null;

  return assertSchema("TradeCandidate", {
    marketId: market.marketId,
    tokenId: outcome.tokenId,
    side: wantedSide,
    marketProbability: implied,
    aiProbability,
    grossEdge,
    netEdge,
    confidence: outcomeEstimate.confidence ?? estimate.confidence,
    market_implied_probability: implied,
    marketImpliedProbability: implied,
    edge: grossEdge,
    expected_value: expectedValue,
    expectedValue,
    suggested_side: wantedSide,
    suggestedSide: wantedSide,
    suggested_notional_before_risk: notional,
    suggestedNotionalUsd: notional,
    action: noTradeReason ? "skip" : "open",
    noTradeReason
  });
}

function chooseBestCandidate(candidates) {
  return candidates
    .filter(Boolean)
    .sort((a, b) => b.netEdge - a.netEdge)[0] ?? null;
}

export class DecisionEngine {
  analyze({ market, estimate, portfolio = null, amountUsd = 1 }) {
    const candidates = [
      buildTradeCandidate({ market, estimate, side: "yes", portfolio, amountUsd }),
      buildTradeCandidate({ market, estimate, side: "no", portfolio, amountUsd })
    ];
    const candidate = chooseBestCandidate(candidates);
    if (!candidate) {
      return {
        action: "skip",
        noTradeReason: "market_probability_unavailable",
        marketId: market.marketId,
        suggested_side: null,
        suggestedSide: null,
        market_implied_probability: null,
        marketImpliedProbability: null,
        ai_probability: estimate.ai_probability,
        aiProbability: estimate.aiProbability,
        edge: null,
        expected_value: null,
        expectedValue: null,
        suggested_notional_before_risk: 0,
        suggestedNotionalUsd: 0,
        confidence: estimate.confidence,
        sources: sourceIds(estimate)
      };
    }
    return {
      ...candidate,
      ai_probability: candidate.aiProbability,
      sources: sourceIds(estimate)
    };
  }

  decide({ market, estimate, side = "yes", amountUsd = 1, portfolio = null }) {
    const candidate = buildTradeCandidate({ market, estimate, side, portfolio, amountUsd });
    const common = {
      marketId: market.marketId,
      eventId: market.eventId,
      tokenId: candidate?.tokenId ?? market.outcomes[0]?.tokenId ?? market.marketId,
      side: "BUY",
      requestedUsd: Number(amountUsd),
      sources: sourceIds(estimate)
    };

    if (!candidate) {
      return assertSchema("TradeDecision", {
        ...common,
        action: "skip",
        marketProbability: null,
        aiProbability: null,
        grossEdge: null,
        netEdge: null,
        confidence: "low",
        thesis: "Market probability is unavailable.",
        market_implied_probability: null,
        marketImpliedProbability: null,
        edge: null,
        expected_value: null,
        expectedValue: null,
        suggested_side: null,
        suggestedSide: null,
        suggested_notional_before_risk: 0,
        suggestedNotionalUsd: 0,
        noTradeReason: "market_probability_unavailable"
      });
    }

    const canOpen = candidate.action === "open";
    return assertSchema("TradeDecision", {
      ...common,
      tokenId: candidate.tokenId,
      action: canOpen ? "open" : "skip",
      marketProbability: candidate.marketProbability,
      aiProbability: candidate.aiProbability,
      grossEdge: candidate.grossEdge,
      netEdge: candidate.netEdge,
      confidence: candidate.confidence,
      thesis: canOpen
        ? `Net edge ${candidate.netEdge.toFixed(4)} clears the analysis threshold.`
        : `No trade: ${candidate.noTradeReason}.`,
      market_implied_probability: candidate.market_implied_probability,
      marketImpliedProbability: candidate.marketImpliedProbability,
      edge: candidate.edge,
      expected_value: candidate.expected_value,
      expectedValue: candidate.expectedValue,
      suggested_side: candidate.suggested_side,
      suggestedSide: candidate.suggestedSide,
      suggested_notional_before_risk: candidate.suggested_notional_before_risk,
      suggestedNotionalUsd: candidate.suggestedNotionalUsd,
      noTradeReason: candidate.noTradeReason
    });
  }
}
