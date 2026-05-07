/**
 * PredictionPerformanceTracker
 *
 * Aligns with Predict-Raven's prediction performance evaluation:
 * Tracks prediction outcomes over time and generates evaluation reports
 * logged to the simulated monitor log.
 *
 * Key capabilities:
 * - Records each prediction's AI probability, market probability, confidence, category
 * - On position close, records actual outcome and computes hit/miss
 * - Periodically (every N rounds or on demand) emits a performance evaluation log block:
 *   - Hit rate by confidence level
 *   - Brier score overall and by category
 *   - Calibration analysis (predicted vs actual in buckets)
 *   - Edge accuracy (predicted edge vs realized return)
 *   - Monthly/annualized return rates
 *   - Best/worst performing categories
 *
 * All output goes to the simulated monitor log as structured events,
 * not as separate files. This keeps the evaluation co-located with
 * the trading activity for easy human review.
 */

function round(value, digits = 4) {
  return Number((Number(value) || 0).toFixed(digits));
}

function bucketIndex(probability, numBuckets = 5) {
  return Math.min(numBuckets - 1, Math.max(0, Math.floor(probability * numBuckets)));
}

function bucketLabel(index, numBuckets = 5) {
  const low = round(index / numBuckets, 2);
  const high = round((index + 1) / numBuckets, 2);
  return `${low}-${high}`;
}

export class PredictionPerformanceTracker {
  constructor(config = {}) {
    this.config = config;
    this.predictions = [];
    this.outcomes = [];
    this.roundsSinceReport = 0;
    this.reportEveryNRounds = config.pulse?.performanceReportInterval ?? 5;
  }

  /**
   * Record a prediction made during a round.
   */
  recordPrediction({
    marketId,
    marketSlug,
    category,
    aiProbability,
    marketProbability,
    confidence,
    netEdge,
    monthlyReturn,
    quarterKellyPct,
    side,
    notionalUsd,
    roundId,
    timestamp = new Date().toISOString()
  }) {
    this.predictions.push({
      marketId,
      marketSlug,
      category: category ?? "unknown",
      aiProbability: Number(aiProbability) || 0.5,
      marketProbability: Number(marketProbability) || 0.5,
      confidence: confidence ?? "medium",
      netEdge: Number(netEdge) || 0,
      monthlyReturn: Number(monthlyReturn) || 0,
      quarterKellyPct: Number(quarterKellyPct) || 0,
      side: side ?? "yes",
      notionalUsd: Number(notionalUsd) || 0,
      roundId,
      timestamp,
      resolved: false,
      outcome: null
    });
  }

  /**
   * Record an outcome when a position is closed.
   */
  recordOutcome({
    marketId,
    marketSlug,
    outcome,
    realizedPnlUsd,
    returnPct,
    closeReason,
    timestamp = new Date().toISOString()
  }) {
    // Match to prediction
    const prediction = [...this.predictions].reverse().find(
      (p) => (p.marketId === marketId || p.marketSlug === marketSlug) && !p.resolved
    );

    const record = {
      marketId,
      marketSlug,
      outcome: outcome ? 1 : 0,
      realizedPnlUsd: Number(realizedPnlUsd) || 0,
      returnPct: Number(returnPct) || 0,
      closeReason,
      timestamp,
      aiProbability: prediction?.aiProbability ?? null,
      marketProbability: prediction?.marketProbability ?? null,
      confidence: prediction?.confidence ?? null,
      category: prediction?.category ?? "unknown",
      netEdge: prediction?.netEdge ?? null,
      side: prediction?.side ?? "yes"
    };

    if (prediction) {
      prediction.resolved = true;
      prediction.outcome = outcome ? 1 : 0;
    }

    this.outcomes.push(record);
    return record;
  }

  /**
   * Called at the end of each round. Increments counter and returns
   * whether a performance report should be emitted.
   */
  shouldEmitReport() {
    this.roundsSinceReport += 1;
    if (this.roundsSinceReport >= this.reportEveryNRounds && this.outcomes.length >= 3) {
      this.roundsSinceReport = 0;
      return true;
    }
    return false;
  }

  /**
   * Generate a comprehensive performance evaluation.
   */
  generateReport() {
    if (this.outcomes.length === 0) {
      return null;
    }

    const resolved = this.outcomes;
    const totalPredictions = this.predictions.length;

    // Overall metrics
    const wins = resolved.filter((r) => r.realizedPnlUsd > 0);
    const losses = resolved.filter((r) => r.realizedPnlUsd < 0);
    const winRate = wins.length + losses.length > 0
      ? round(wins.length / (wins.length + losses.length), 4)
      : null;

    // Brier score (for predictions with known AI probability)
    const withProb = resolved.filter((r) => r.aiProbability != null);
    let brierScore = null;
    if (withProb.length > 0) {
      const brierSum = withProb.reduce((sum, r) => {
        const predicted = r.side === "yes" ? r.aiProbability : 1 - r.aiProbability;
        const actual = r.outcome;
        return sum + (predicted - actual) ** 2;
      }, 0);
      brierScore = round(brierSum / withProb.length, 6);
    }

    // Calibration by bucket
    const numBuckets = 5;
    const calibrationBuckets = Array.from({ length: numBuckets }, () => ({
      predicted: 0, actual: 0, count: 0
    }));
    for (const r of withProb) {
      const prob = r.side === "yes" ? r.aiProbability : 1 - r.aiProbability;
      const idx = bucketIndex(prob, numBuckets);
      calibrationBuckets[idx].predicted += prob;
      calibrationBuckets[idx].actual += r.outcome;
      calibrationBuckets[idx].count += 1;
    }
    const calibration = calibrationBuckets.map((b, idx) => ({
      bucket: bucketLabel(idx, numBuckets),
      count: b.count,
      avgPredicted: b.count > 0 ? round(b.predicted / b.count, 4) : null,
      avgActual: b.count > 0 ? round(b.actual / b.count, 4) : null,
      gap: b.count > 0 ? round(b.predicted / b.count - b.actual / b.count, 4) : null
    }));

    // By confidence level
    const byConfidence = {};
    for (const conf of ["low", "medium", "high"]) {
      const group = resolved.filter((r) => r.confidence === conf);
      if (group.length > 0) {
        const groupWins = group.filter((r) => r.realizedPnlUsd > 0);
        const groupLosses = group.filter((r) => r.realizedPnlUsd < 0);
        byConfidence[conf] = {
          count: group.length,
          winRate: groupWins.length + groupLosses.length > 0
            ? round(groupWins.length / (groupWins.length + groupLosses.length), 4) : null,
          avgReturnPct: round(group.reduce((s, r) => s + r.returnPct, 0) / group.length, 4),
          totalPnlUsd: round(group.reduce((s, r) => s + r.realizedPnlUsd, 0), 2)
        };
      }
    }

    // By category
    const categoryMap = {};
    for (const r of resolved) {
      if (!categoryMap[r.category]) categoryMap[r.category] = [];
      categoryMap[r.category].push(r);
    }
    const byCategory = Object.fromEntries(
      Object.entries(categoryMap).map(([cat, group]) => {
        const catWins = group.filter((r) => r.realizedPnlUsd > 0);
        const catLosses = group.filter((r) => r.realizedPnlUsd < 0);
        return [cat, {
          count: group.length,
          winRate: catWins.length + catLosses.length > 0
            ? round(catWins.length / (catWins.length + catLosses.length), 4) : null,
          totalPnlUsd: round(group.reduce((s, r) => s + r.realizedPnlUsd, 0), 2),
          avgReturnPct: round(group.reduce((s, r) => s + r.returnPct, 0) / group.length, 4)
        }];
      })
    );

    // Edge accuracy: predicted netEdge vs actual return
    const withEdge = resolved.filter((r) => r.netEdge != null);
    let edgeAccuracy = null;
    if (withEdge.length > 0) {
      const edgeErrors = withEdge.map((r) => Math.abs(r.netEdge - r.returnPct));
      edgeAccuracy = {
        meanAbsError: round(edgeErrors.reduce((s, e) => s + e, 0) / edgeErrors.length, 4),
        avgPredictedEdge: round(withEdge.reduce((s, r) => s + r.netEdge, 0) / withEdge.length, 4),
        avgActualReturn: round(withEdge.reduce((s, r) => s + r.returnPct, 0) / withEdge.length, 4)
      };
    }

    // Total P&L
    const totalRealizedPnl = round(resolved.reduce((s, r) => s + r.realizedPnlUsd, 0), 2);
    const avgReturnPct = round(resolved.reduce((s, r) => s + r.returnPct, 0) / resolved.length, 4);

    return {
      generatedAt: new Date().toISOString(),
      totalPredictions,
      resolvedOutcomes: resolved.length,
      unresolvedPredictions: totalPredictions - resolved.length,
      winRate,
      brierScore,
      totalRealizedPnlUsd: totalRealizedPnl,
      avgReturnPct,
      calibration,
      byConfidence,
      byCategory,
      edgeAccuracy,
      bestCategory: Object.entries(byCategory)
        .filter(([, v]) => v.count >= 2)
        .sort(([, a], [, b]) => b.totalPnlUsd - a.totalPnlUsd)[0]?.[0] ?? null,
      worstCategory: Object.entries(byCategory)
        .filter(([, v]) => v.count >= 2)
        .sort(([, a], [, b]) => a.totalPnlUsd - b.totalPnlUsd)[0]?.[0] ?? null
    };
  }

  /**
   * Emit performance report to ledger log.
   */
  async emitReport(ledger) {
    const report = this.generateReport();
    if (!report) return null;

    // Log summary line
    await ledger.log("performance.report", {
      resolved: report.resolvedOutcomes,
      win_rate: report.winRate ?? "n/a",
      brier_score: report.brierScore ?? "n/a",
      total_pnl_usd: report.totalRealizedPnlUsd,
      avg_return_pct: report.avgReturnPct,
      best_category: report.bestCategory ?? "n/a",
      worst_category: report.worstCategory ?? "n/a"
    });

    // Log calibration buckets
    for (const bucket of report.calibration) {
      if (bucket.count > 0) {
        await ledger.log("performance.calibration", {
          bucket: bucket.bucket,
          count: bucket.count,
          avg_predicted: bucket.avgPredicted,
          avg_actual: bucket.avgActual,
          gap: bucket.gap
        });
      }
    }

    // Log confidence breakdown
    for (const [conf, stats] of Object.entries(report.byConfidence)) {
      await ledger.log("performance.by_confidence", {
        confidence: conf,
        count: stats.count,
        win_rate: stats.winRate ?? "n/a",
        avg_return_pct: stats.avgReturnPct,
        total_pnl_usd: stats.totalPnlUsd
      });
    }

    // Log edge accuracy
    if (report.edgeAccuracy) {
      await ledger.log("performance.edge_accuracy", {
        mean_abs_error: report.edgeAccuracy.meanAbsError,
        avg_predicted_edge: report.edgeAccuracy.avgPredictedEdge,
        avg_actual_return: report.edgeAccuracy.avgActualReturn
      });
    }

    return report;
  }
}

export const predictionTrackerInternals = {
  bucketIndex,
  bucketLabel
};
