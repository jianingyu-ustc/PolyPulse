/**
 * DownsideRiskRanker
 *
 * Aligns with Predict-Raven's downside risk ranking and cross-round
 * capital allocation optimization:
 *
 * 1. Downside Risk Scoring — Each opportunity is scored not just by expected
 *    upside (monthly return, net edge) but also by worst-case loss potential:
 *    - Max loss at stop-loss (position_size * stop_loss_pct)
 *    - Probability-weighted downside (1 - aiProbability) * notional
 *    - Liquidity risk (can we exit at expected price?)
 *    - Time risk (longer holding = more uncertainty)
 *    - Correlation risk (same event/category concentration)
 *
 * 2. Cross-Round Capital Allocation — Before ranking, considers existing
 *    positions and already-deployed capital to optimize marginal allocation:
 *    - Available capital after existing positions
 *    - Category/event diversification penalty
 *    - Diminishing returns for concentrated categories
 *    - Opportunity cost of capital lockup
 *
 * Output: Enhanced ranking score that balances upside and downside,
 * applied as a secondary sort within the existing ranking pipeline.
 */

function round(value, digits = 6) {
  return Number(Number(value).toFixed(digits));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function categoryOf(market) {
  return String(market?.category ?? market?.categorySlug ?? "unknown").toLowerCase();
}

function eventKey(market) {
  return market?.eventId ?? market?.eventSlug ?? market?.marketId ?? "unknown";
}

/**
 * Compute downside risk score for a single opportunity.
 * Higher score = more risky downside.
 */
function computeDownsideScore({
  aiProbability,
  netEdge,
  notionalUsd,
  liquidityUsd,
  daysToResolution,
  stopLossPct = 0.5,
  spreadPct = 0
}) {
  const prob = clamp(aiProbability, 0, 1);
  const failProb = 1 - prob;

  // 1. Probability-weighted max loss
  const maxLossUsd = notionalUsd * stopLossPct;
  const expectedLossUsd = round(failProb * maxLossUsd, 2);

  // 2. Liquidity risk: if notional is large relative to market liquidity,
  // exit might be at worse price
  const liquidityRatio = liquidityUsd > 0 ? notionalUsd / liquidityUsd : 1;
  const liquidityRisk = clamp(liquidityRatio * 10, 0, 1); // 0-1 scale

  // 3. Time risk: longer holding = more uncertainty, scaled 0-1
  const days = Math.max(0, Number(daysToResolution) || 0);
  const timeRisk = clamp(days / 90, 0, 1); // normalized to 90 days max

  // 4. Spread risk: wider spread = harder to exit
  const spreadRisk = clamp(spreadPct * 20, 0, 1); // 5% spread = risk 1.0

  // 5. Edge quality: thin edge is riskier (more likely to flip negative)
  const edgeQuality = netEdge > 0 ? clamp(1 - (netEdge / 0.15), 0, 1) : 1;

  // Composite downside score (0-1, higher = worse)
  const composite = round(
    expectedLossUsd / Math.max(notionalUsd, 1) * 0.35 +
    liquidityRisk * 0.2 +
    timeRisk * 0.15 +
    spreadRisk * 0.1 +
    edgeQuality * 0.2,
    4
  );

  return {
    score: composite,
    expectedLossUsd,
    liquidityRisk: round(liquidityRisk, 4),
    timeRisk: round(timeRisk, 4),
    spreadRisk: round(spreadRisk, 4),
    edgeQuality: round(edgeQuality, 4),
    maxLossUsd: round(maxLossUsd, 2)
  };
}

/**
 * Compute capital allocation penalty for diversification.
 * Penalizes candidates in categories/events where we already have exposure.
 */
function computeAllocationPenalty({
  market,
  existingPositions = [],
  availableCapitalUsd,
  totalEquityUsd
}) {
  const cat = categoryOf(market);
  const evt = eventKey(market);

  // Count existing exposure by category and event
  let categoryExposureUsd = 0;
  let eventExposureUsd = 0;
  let categoryCount = 0;

  for (const pos of existingPositions) {
    if (categoryOf(pos) === cat) {
      categoryExposureUsd += pos.currentValueUsd ?? pos.costUsd ?? 0;
      categoryCount += 1;
    }
    if (eventKey(pos) === evt) {
      eventExposureUsd += pos.currentValueUsd ?? pos.costUsd ?? 0;
    }
  }

  // Category concentration penalty (0-1)
  const categoryPct = totalEquityUsd > 0 ? categoryExposureUsd / totalEquityUsd : 0;
  const categoryPenalty = clamp(categoryPct * 2, 0, 1); // 50% in one category = max penalty

  // Event duplication penalty (binary: same event = heavy penalty)
  const eventPenalty = eventExposureUsd > 0 ? 0.8 : 0;

  // Capital availability penalty
  const capitalPct = totalEquityUsd > 0 ? availableCapitalUsd / totalEquityUsd : 1;
  const capitalPenalty = clamp(1 - capitalPct, 0, 1);

  // Diminishing returns for category count
  const diminishingPenalty = clamp(categoryCount * 0.15, 0, 0.6);

  const composite = round(
    categoryPenalty * 0.3 +
    eventPenalty * 0.3 +
    capitalPenalty * 0.2 +
    diminishingPenalty * 0.2,
    4
  );

  return {
    penalty: composite,
    categoryPenalty: round(categoryPenalty, 4),
    eventPenalty: round(eventPenalty, 4),
    capitalPenalty: round(capitalPenalty, 4),
    diminishingPenalty: round(diminishingPenalty, 4),
    categoryExposureUsd: round(categoryExposureUsd, 2),
    eventExposureUsd: round(eventExposureUsd, 2),
    availableCapitalUsd: round(availableCapitalUsd, 2)
  };
}

/**
 * Compute risk-adjusted score combining upside metrics and downside risk.
 * Higher = better opportunity after risk adjustment.
 */
function computeRiskAdjustedScore({
  monthlyReturn = 0,
  netEdge = 0,
  quarterKellyPct = 0,
  confidence,
  downsideScore,
  allocationPenalty
}) {
  // Upside components (normalized to 0-1 range)
  const returnScore = clamp(monthlyReturn / 0.5, 0, 1); // 50% monthly = max
  const edgeScore = clamp(netEdge / 0.15, 0, 1); // 15% net edge = max
  const kellyScore = clamp(quarterKellyPct / 0.1, 0, 1); // 10% kelly = max
  const confScore = confidence === "high" ? 1 : confidence === "medium" ? 0.6 : 0.3;

  const upsideComposite = round(
    returnScore * 0.3 +
    edgeScore * 0.25 +
    kellyScore * 0.2 +
    confScore * 0.25,
    4
  );

  // Risk-adjusted = upside * (1 - downside) * (1 - allocation_penalty)
  const riskAdjusted = round(
    upsideComposite * (1 - downsideScore * 0.7) * (1 - allocationPenalty * 0.5),
    4
  );

  return {
    riskAdjustedScore: riskAdjusted,
    upsideScore: upsideComposite,
    downsideDiscount: round(downsideScore * 0.7, 4),
    allocationDiscount: round(allocationPenalty * 0.5, 4)
  };
}

export class DownsideRiskRanker {
  constructor(config = {}) {
    this.config = config;
    this.stopLossPct = config.risk?.maxPositionLossPct ?? 0.5;
  }

  /**
   * Enhance ranked predictions with downside risk and capital allocation scores.
   * Returns the same array re-sorted by risk-adjusted score.
   */
  rankWithDownsideRisk({ rankedPredictions, portfolio, ledgerStatistics = {} }) {
    const existingPositions = portfolio?.positions ?? [];
    const totalEquityUsd = portfolio?.totalEquityUsd ?? 0;
    const cashUsd = portfolio?.cashUsd ?? 0;

    const enhanced = rankedPredictions.map((item) => {
      const analysis = item.analysis ?? {};
      const market = item.prediction?.market ?? {};

      const notionalUsd = analysis.suggestedNotionalUsd ?? analysis.suggested_notional_before_risk ?? 0;
      const liquidityUsd = market.liquidityUsd ?? 0;

      // Downside risk
      const downside = computeDownsideScore({
        aiProbability: analysis.aiProbability ?? 0.5,
        netEdge: analysis.netEdge ?? 0,
        notionalUsd,
        liquidityUsd,
        daysToResolution: analysis.daysToResolution ?? 30,
        stopLossPct: this.stopLossPct,
        spreadPct: 0
      });

      // Capital allocation
      const allocation = computeAllocationPenalty({
        market,
        existingPositions,
        availableCapitalUsd: cashUsd,
        totalEquityUsd
      });

      // Risk-adjusted score
      const riskAdjusted = computeRiskAdjustedScore({
        monthlyReturn: analysis.monthlyReturn ?? 0,
        netEdge: analysis.netEdge ?? 0,
        quarterKellyPct: analysis.quarterKellyPct ?? 0,
        confidence: analysis.confidence,
        downsideScore: downside.score,
        allocationPenalty: allocation.penalty
      });

      return {
        ...item,
        downsideRisk: downside,
        allocationPenalty: allocation,
        riskAdjusted
      };
    });

    // Re-sort: action=open first, then by risk-adjusted score descending
    enhanced.sort((a, b) => {
      const aOpen = a.analysis?.action === "open" ? 1 : 0;
      const bOpen = b.analysis?.action === "open" ? 1 : 0;
      if (aOpen !== bOpen) return bOpen - aOpen;
      return (b.riskAdjusted?.riskAdjustedScore ?? 0) - (a.riskAdjusted?.riskAdjustedScore ?? 0);
    });

    return enhanced;
  }
}

export const downsideRiskInternals = {
  computeDownsideScore,
  computeAllocationPenalty,
  computeRiskAdjustedScore,
  categoryOf,
  eventKey
};
