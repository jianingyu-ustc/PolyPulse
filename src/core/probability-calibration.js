import { detectUninformedPrior } from "./uninformed-prior-detector.js";

/**
 * ProbabilityCalibrationLayer
 *
 * Aligns with Predict-Raven's probability calibration system:
 * Applies calibration adjustments to raw AI probabilities based on market type,
 * evidence quality, time span, liquidity, AI triage scores, and historical accuracy.
 *
 * Key properties:
 * - Takes raw AI probability and outputs calibrated probability
 * - Calibration factors: market category, days to resolution, evidence freshness,
 *   evidence count, AI confidence, AI triage researchability, information_advantage,
 *   liquidity level, and pre-screen classification
 * - Each factor contributes a confidence weight that moves the calibrated probability
 *   toward or away from 0.5 (the "no-information" prior)
 * - When calibration signals are weak, output stays close to raw probability
 * - When calibration signals indicate low quality, probability is shrunk toward 0.5
 * - Records calibration_reason array explaining each adjustment
 * - Designed to integrate with historical accuracy data when available
 *
 * This prevents the system from over-trusting AI estimates in low-quality
 * environments (sparse evidence, low liquidity, low researchability) and
 * allows gradual improvement as historical calibration data accumulates.
 */

const DEFAULT_CALIBRATION_CONFIG = {
  enabled: true,
  // Shrinkage toward 0.5 for each dimension (0 = no shrinkage, 1 = full shrinkage to 0.5)
  lowConfidenceShrinkage: 0.3,
  lowResearchabilityShrinkage: 0.25,
  lowInformationAdvantageShrinkage: 0.2,
  staleEvidenceShrinkage: 0.15,
  sparseEvidenceShrinkage: 0.1,
  lowLiquidityShrinkage: 0.1,
  shortTermShrinkage: 0.05,
  prescreenSkipShrinkage: 0.4,
  unjustifiedLargeDeviationShrinkage: 0.35,
  unjustifiedModerateDeviationShrinkage: 0.15,
  deviationLargeThreshold: 0.25,
  deviationModerateThreshold: 0.15,
  uninformedPriorShrinkage: 0.5,
  // Thresholds
  lowLiquidityThresholdUsd: 10000,
  sparseEvidenceThreshold: 2,
  staleEvidenceAgeDays: 7,
  shortTermDaysThreshold: 2,
  // Probability clamp bounds
  probabilityClampMin: 0.01,
  probabilityClampMax: 0.99
};

function clampProbability(value, min = 0.01, max = 0.99) {
  return Math.min(max, Math.max(min, value));
}

function shrinkToward(probability, target, factor) {
  return probability + (target - probability) * factor;
}

function evidenceAgeDays(evidence) {
  if (!Array.isArray(evidence) || evidence.length === 0) return 30;
  const timestamps = evidence
    .map((e) => Date.parse(e.timestamp ?? e.retrievedAt))
    .filter(Number.isFinite);
  if (timestamps.length === 0) return 30;
  const newest = Math.max(...timestamps);
  return Math.max(0, (Date.now() - newest) / 86_400_000);
}

function daysToResolution(endDate) {
  const end = new Date(endDate ?? "").getTime();
  if (!Number.isFinite(end) || end <= 0) return 180;
  return Math.max(0, (end - Date.now()) / 86_400_000);
}

export class ProbabilityCalibrationLayer {
  constructor(config = {}) {
    const calConfig = config.calibration ?? {};
    this.enabled = calConfig.enabled !== false;
    this.params = { ...DEFAULT_CALIBRATION_CONFIG, ...calConfig };
  }

  calibrate({
    rawProbability,
    confidence = "medium",
    market = {},
    evidence = [],
    triageAssessment = null,
    prescreenResult = null,
    deviationJustification = null,
    estimate = null
  }) {
    if (!this.enabled) {
      return {
        rawProbability,
        calibratedProbability: rawProbability,
        calibrationApplied: false,
        calibrationReasons: []
      };
    }

    let calibrated = rawProbability;
    const reasons = [];
    const target = 0.5;

    // 1. Confidence-based shrinkage
    if (confidence === "low") {
      calibrated = shrinkToward(calibrated, target, this.params.lowConfidenceShrinkage);
      reasons.push(`low_confidence: shrink ${this.params.lowConfidenceShrinkage}`);
    }

    // 2. Researchability-based shrinkage (from triage)
    if (triageAssessment?.researchability === "low") {
      calibrated = shrinkToward(calibrated, target, this.params.lowResearchabilityShrinkage);
      reasons.push(`low_researchability: shrink ${this.params.lowResearchabilityShrinkage}`);
    }

    // 3. Information advantage shrinkage (from triage)
    if (triageAssessment?.information_advantage === "low") {
      calibrated = shrinkToward(calibrated, target, this.params.lowInformationAdvantageShrinkage);
      reasons.push(`low_information_advantage: shrink ${this.params.lowInformationAdvantageShrinkage}`);
    }

    // 4. Evidence freshness shrinkage
    const ageD = evidenceAgeDays(evidence);
    if (ageD > this.params.staleEvidenceAgeDays) {
      calibrated = shrinkToward(calibrated, target, this.params.staleEvidenceShrinkage);
      reasons.push(`stale_evidence (${ageD.toFixed(1)}d): shrink ${this.params.staleEvidenceShrinkage}`);
    }

    // 5. Sparse evidence shrinkage
    const validEvidence = Array.isArray(evidence) ? evidence.filter((e) => e.status !== "failed") : [];
    if (validEvidence.length < this.params.sparseEvidenceThreshold) {
      calibrated = shrinkToward(calibrated, target, this.params.sparseEvidenceShrinkage);
      reasons.push(`sparse_evidence (${validEvidence.length} items): shrink ${this.params.sparseEvidenceShrinkage}`);
    }

    // 6. Low liquidity shrinkage
    const liquidityUsd = Number(market.liquidityUsd ?? 0);
    if (liquidityUsd < this.params.lowLiquidityThresholdUsd && liquidityUsd > 0) {
      calibrated = shrinkToward(calibrated, target, this.params.lowLiquidityShrinkage);
      reasons.push(`low_liquidity ($${liquidityUsd}): shrink ${this.params.lowLiquidityShrinkage}`);
    }

    // 7. Short-term resolution shrinkage (high uncertainty near resolution)
    const daysLeft = daysToResolution(market.endDate);
    if (daysLeft < this.params.shortTermDaysThreshold) {
      calibrated = shrinkToward(calibrated, target, this.params.shortTermShrinkage);
      reasons.push(`short_term (${daysLeft.toFixed(1)}d): shrink ${this.params.shortTermShrinkage}`);
    }

    // 8. Pre-screen skip penalty (if market was flagged but overridden)
    if (prescreenResult && !prescreenResult.suitable) {
      calibrated = shrinkToward(calibrated, target, this.params.prescreenSkipShrinkage);
      reasons.push(`prescreen_skip: shrink ${this.params.prescreenSkipShrinkage}`);
    }

    // 9. Unjustified large deviation from market
    const marketImplied = market.outcomes?.[0]?.impliedProbability
      ?? market.outcomes?.[0]?.lastPrice
      ?? market.outcomes?.[0]?.bestAsk
      ?? null;
    if (marketImplied != null) {
      const deviation = Math.abs(rawProbability - marketImplied);
      const hasJustification = typeof deviationJustification === "string"
        && deviationJustification.trim().length > 20;
      if (deviation > this.params.deviationLargeThreshold && !hasJustification) {
        calibrated = shrinkToward(calibrated, target, this.params.unjustifiedLargeDeviationShrinkage);
        reasons.push(`unjustified_large_deviation (${(deviation * 100).toFixed(1)}pp): shrink ${this.params.unjustifiedLargeDeviationShrinkage}`);
      } else if (deviation > this.params.deviationModerateThreshold && !hasJustification) {
        calibrated = shrinkToward(calibrated, target, this.params.unjustifiedModerateDeviationShrinkage);
        reasons.push(`unjustified_moderate_deviation (${(deviation * 100).toFixed(1)}pp): shrink ${this.params.unjustifiedModerateDeviationShrinkage}`);
      }
    }

    // 10. Uninformed prior detection — shrink toward market price when AI has no real information
    if (estimate) {
      const { isUninformed, signals } = detectUninformedPrior(estimate, { aiProbability: rawProbability });
      if (isUninformed && marketImplied != null) {
        calibrated = shrinkToward(calibrated, marketImplied, this.params.uninformedPriorShrinkage);
        reasons.push(`uninformed_prior_detected (${signals[0]}): heavy shrink ${this.params.uninformedPriorShrinkage} toward market ${marketImplied}`);
      }
    }

    calibrated = clampProbability(calibrated, this.params.probabilityClampMin, this.params.probabilityClampMax);

    return {
      rawProbability,
      calibratedProbability: Number(calibrated.toFixed(6)),
      calibrationApplied: reasons.length > 0,
      calibrationReasons: reasons,
      calibrationFactors: {
        confidence,
        researchability: triageAssessment?.researchability ?? null,
        informationAdvantage: triageAssessment?.information_advantage ?? null,
        evidenceAgeDays: Number(ageD.toFixed(1)),
        validEvidenceCount: validEvidence.length,
        liquidityUsd,
        daysToResolution: Number(daysLeft.toFixed(1)),
        prescreenSuitable: prescreenResult?.suitable ?? null,
        marketImpliedProbability: marketImplied,
        deviationFromMarket: marketImplied != null ? Number(Math.abs(rawProbability - marketImplied).toFixed(4)) : null,
        hasDeviationJustification: typeof deviationJustification === "string" && deviationJustification.trim().length > 20,
        uninformedPriorDetected: estimate ? detectUninformedPrior(estimate, { aiProbability: rawProbability }).isUninformed : false
      }
    };
  }
}

export const calibrationInternals = {
  shrinkToward,
  evidenceAgeDays,
  daysToResolution,
  DEFAULT_CALIBRATION_CONFIG
};
