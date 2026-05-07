/**
 * ReturnAttributionEngine
 *
 * Aligns with Predict-Raven's return attribution system:
 * Decomposes final trade returns into distinct contributing factors,
 * enabling identification of which parts of the system contribute
 * positively or negatively to overall performance.
 *
 * Attribution factors:
 * 1. prediction_error - Difference between AI probability and actual outcome
 * 2. market_price_change - Market price movement between entry and exit/settlement
 * 3. fee_impact - Entry/exit fees paid
 * 4. slippage_impact - Execution slippage (difference between expected and actual fill)
 * 5. position_size_impact - Kelly sizing contribution (over/under-sizing effect)
 * 6. holding_period_impact - Time decay / opportunity cost of holding
 * 7. exit_decision_impact - Timing of exit vs holding to settlement
 *
 * Each factor is expressed as a USD contribution to the final P&L,
 * summing to the total realized P&L for the position.
 *
 * Output: ReturnAttribution artifact per closed position, with:
 * - Individual factor contributions (USD and %)
 * - Aggregate statistics across all positions
 * - Category/confidence/dimension breakdowns
 */

function round(value, digits = 6) {
  return Number(Number(value).toFixed(digits));
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

export class ReturnAttributionEngine {
  constructor(config = {}) {
    this.config = config;
  }

  attributePosition({
    entryPrice,
    exitPrice,
    aiProbability,
    marketProbabilityAtEntry,
    outcome,
    notionalUsd,
    entryFeePct = 0,
    exitFeePct = 0,
    slippagePct = 0,
    holdingDays = 0,
    exitType = "settlement",
    optimalKellyPct = null,
    actualSizePct = null,
    bankrollUsd = null
  }) {
    const entry = clamp01(entryPrice);
    const exit = clamp01(exitPrice);
    const aiProb = clamp01(aiProbability);
    const marketProb = clamp01(marketProbabilityAtEntry);
    const outcomeValue = outcome ? 1 : 0;
    const notional = Math.max(0, Number(notionalUsd) || 0);

    // Raw P&L (before fees)
    const rawPnlPct = outcomeValue - entry;
    const rawPnlUsd = round(notional * rawPnlPct, 2);

    // 1. Prediction error contribution
    // How much did the AI probability miss vs actual outcome?
    const predictionError = round(aiProb - outcomeValue);
    const predictionErrorUsd = round(notional * (outcomeValue - aiProb) * -1, 2);

    // 2. Market price change (between entry and exit/settlement)
    const priceChange = round(exit - entry);
    const priceChangeUsd = round(notional * priceChange, 2);

    // 3. Fee impact
    const totalFeePct = round(entryFeePct + exitFeePct);
    const feeUsd = round(notional * totalFeePct * -1, 2);

    // 4. Slippage impact
    const slippageUsd = round(notional * slippagePct * -1, 2);

    // 5. Position size impact
    let sizingImpactUsd = 0;
    if (optimalKellyPct != null && actualSizePct != null && bankrollUsd != null) {
      const optimalNotional = bankrollUsd * optimalKellyPct;
      const sizeDiff = notional - optimalNotional;
      sizingImpactUsd = round(sizeDiff * rawPnlPct * -1, 2);
    }

    // 6. Holding period impact (opportunity cost at risk-free rate ~5% annualized)
    const annualizedCost = 0.05;
    const holdingCostPct = round((holdingDays / 365) * annualizedCost);
    const holdingCostUsd = round(notional * holdingCostPct * -1, 2);

    // 7. Exit decision impact
    // Settlement exit = 0 additional impact; early exit = difference between exit price and settlement
    let exitDecisionUsd = 0;
    if (exitType !== "settlement") {
      const settlementValue = outcomeValue;
      exitDecisionUsd = round(notional * (exit - settlementValue), 2);
    }

    // Total realized P&L
    const realizedPnlUsd = round(rawPnlUsd + feeUsd + slippageUsd, 2);

    return {
      rawPnlUsd,
      realizedPnlUsd,
      factors: {
        prediction_error: {
          value: predictionError,
          usd: predictionErrorUsd,
          description: `AI predicted ${aiProb.toFixed(3)}, outcome was ${outcomeValue}`
        },
        market_price_change: {
          value: priceChange,
          usd: priceChangeUsd,
          description: `Price moved from ${entry.toFixed(3)} to ${exit.toFixed(3)}`
        },
        fee_impact: {
          value: totalFeePct,
          usd: feeUsd,
          description: `Entry fee ${(entryFeePct * 100).toFixed(2)}% + exit fee ${(exitFeePct * 100).toFixed(2)}%`
        },
        slippage_impact: {
          value: slippagePct,
          usd: slippageUsd,
          description: `Execution slippage ${(slippagePct * 100).toFixed(3)}%`
        },
        position_size_impact: {
          value: actualSizePct != null ? round(actualSizePct - (optimalKellyPct ?? actualSizePct)) : 0,
          usd: sizingImpactUsd,
          description: optimalKellyPct != null
            ? `Actual size ${((actualSizePct ?? 0) * 100).toFixed(2)}% vs optimal Kelly ${(optimalKellyPct * 100).toFixed(2)}%`
            : "Kelly comparison unavailable"
        },
        holding_period_impact: {
          value: holdingCostPct,
          usd: holdingCostUsd,
          description: `Held for ${holdingDays} days (opportunity cost at 5% annual)`
        },
        exit_decision_impact: {
          value: exitType !== "settlement" ? round(exit - outcomeValue) : 0,
          usd: exitDecisionUsd,
          description: exitType === "settlement"
            ? "Held to settlement (no early exit impact)"
            : `Exited at ${exit.toFixed(3)} vs settlement ${outcomeValue}`
        }
      },
      metadata: {
        entryPrice: entry,
        exitPrice: exit,
        aiProbability: aiProb,
        marketProbabilityAtEntry: marketProb,
        outcome: outcomeValue,
        notionalUsd: notional,
        holdingDays,
        exitType,
        attributedAt: new Date().toISOString()
      }
    };
  }

  aggregateAttributions(attributions) {
    if (attributions.length === 0) {
      return { count: 0, totalPnlUsd: 0, avgPnlUsd: 0, factorTotals: {} };
    }

    const factorTotals = {};
    let totalPnl = 0;

    for (const attr of attributions) {
      totalPnl += attr.realizedPnlUsd;
      for (const [key, factor] of Object.entries(attr.factors)) {
        if (!factorTotals[key]) factorTotals[key] = { totalUsd: 0, count: 0 };
        factorTotals[key].totalUsd += factor.usd;
        factorTotals[key].count += 1;
      }
    }

    const avgPnl = round(totalPnl / attributions.length, 2);
    const factorSummary = Object.fromEntries(
      Object.entries(factorTotals).map(([key, val]) => [key, {
        totalUsd: round(val.totalUsd, 2),
        avgUsd: round(val.totalUsd / val.count, 2),
        contributionPct: totalPnl !== 0 ? round(val.totalUsd / Math.abs(totalPnl) * 100, 2) : 0
      }])
    );

    return {
      count: attributions.length,
      totalPnlUsd: round(totalPnl, 2),
      avgPnlUsd: avgPnl,
      factorTotals: factorSummary,
      topPositiveFactors: Object.entries(factorSummary)
        .filter(([, v]) => v.totalUsd > 0)
        .sort(([, a], [, b]) => b.totalUsd - a.totalUsd)
        .slice(0, 3)
        .map(([k, v]) => `${k}: +$${v.totalUsd}`),
      topNegativeFactors: Object.entries(factorSummary)
        .filter(([, v]) => v.totalUsd < 0)
        .sort(([, a], [, b]) => a.totalUsd - b.totalUsd)
        .slice(0, 3)
        .map(([k, v]) => `${k}: -$${Math.abs(v.totalUsd)}`)
    };
  }
}

export const returnAttributionInternals = {
  round,
  clamp01
};
