/**
 * Uninformed Prior Detector
 *
 * Detects when the AI model has returned a probability estimate that is effectively
 * uninformed (near 0.5) while lacking genuine evidence to support a directional view.
 * This prevents the system from treating "I don't know" as a tradeable edge when
 * the market price is far from 0.5.
 *
 * Also detects when base_rate ≈ ai_probability (zero evidence adjustment),
 * and when uncertainty_factors indicate market-price anchoring without independent edge.
 */

const UNINFORMED_KEYWORDS = [
  "gap-fill failed",
  "gap fill failed",
  "no evidence",
  "neutral prior",
  "no information advantage",
  "no substantive evidence",
  "even-match prior",
  "unable to find",
  "cannot determine",
  "lack of evidence",
  "no relevant data",
  "purely speculative",
  "near a generic",
  "no independent evidence",
  "no directional evidence",
  "no usable competitive information",
  "does not see a defensible information advantage",
  "do not see an independent information advantage",
  "do not see a defensible information advantage",
  "stay near a generic",
  "stays at a neutral",
  "generic even-match",
  "not substantively informative",
  "not sufficient or independent enough",
  "market price as efficient prior",
  "market price anchored",
  "no independent edge",
  "no edge over market"
];

const UNINFORMED_UNCERTAINTY_FACTORS = [
  "no_specific_knowledge",
  "insufficient_evidence",
  "no_independent_edge",
  "market_price_anchored"
];

export function detectUninformedPrior(estimate, { aiProbability, rawAiProbability, threshold = 0.05 } = {}) {
  if (!estimate || aiProbability == null) {
    return { isUninformed: false, signals: [] };
  }

  const signals = [];
  const prob = Number(aiProbability);
  const rawProb = rawAiProbability != null ? Number(rawAiProbability) : prob;
  const confidence = String(estimate.confidence ?? estimate.distribution_confidence ?? "").toLowerCase();
  const nearHalf = Math.abs(prob - 0.5) <= threshold;
  const rawNearHalf = Math.abs(rawProb - 0.5) <= threshold;

  // Original strict check: confidence=low AND within 2pp of 0.5
  if (confidence === "low" && Math.abs(prob - 0.5) <= 0.02) {
    signals.push("strict_low_confidence_at_half");
    return { isUninformed: true, signals };
  }

  // Exact-half check on EITHER raw or calibrated probability.
  // 0.50 is the most common LLM output when it has no information.
  // No model with genuine evidence lands at exactly 0.5.
  if (Math.abs(rawProb - 0.5) < 0.015 || Math.abs(prob - 0.5) < 0.015) {
    signals.push("exact_half_probability");
    return { isUninformed: true, signals };
  }

  // Check raw probability near 0.5 even if calibrated has been moved away.
  // This catches the case where calibration shrinks toward market but the
  // underlying estimate was uninformed.
  if (rawNearHalf && !nearHalf) {
    signals.push("raw_probability_near_half_before_calibration");
  }

  // Base rate ≈ ai_probability check: if evidence_adjustment is negligible,
  // the AI is just echoing its prior without adding independent information.
  const baseRate = Number(estimate.base_rate ?? estimate.baseRate ?? NaN);
  const evidenceAdj = Number(estimate.evidence_adjustment ?? estimate.evidenceAdjustment ?? NaN);
  if (Number.isFinite(baseRate) && Number.isFinite(evidenceAdj)) {
    if (Math.abs(evidenceAdj) < 0.02 && Math.abs(prob - baseRate) < 0.03) {
      signals.push(`zero_evidence_adjustment:adj=${evidenceAdj}`);
    }
  }

  // If not near 0.5 and no raw-near-half signal, check remaining signals
  if (!nearHalf && !rawNearHalf && signals.length === 0) {
    // Still check uncertainty factors for explicit market-anchoring signals
    const factors = estimate.uncertainty_factors ?? estimate.uncertaintyFactors ?? [];
    for (const factor of factors) {
      if (UNINFORMED_UNCERTAINTY_FACTORS.includes(String(factor).toLowerCase())) {
        signals.push(`uncertainty_factor:${factor}`);
      }
    }
    const isUninformed = signals.length > 0;
    return { isUninformed, signals };
  }

  // Signal 1: uncertainty_factors
  const factors = estimate.uncertainty_factors ?? estimate.uncertaintyFactors ?? [];
  for (const factor of factors) {
    if (UNINFORMED_UNCERTAINTY_FACTORS.includes(String(factor).toLowerCase())) {
      signals.push(`uncertainty_factor:${factor}`);
    }
  }

  // Signal 2: reasoning_summary keywords
  const reasoning = String(
    estimate.reasoning_summary ?? estimate.reasoningSummary ?? ""
  ).toLowerCase();
  if (reasoning.length > 0) {
    for (const keyword of UNINFORMED_KEYWORDS) {
      if (reasoning.includes(keyword)) {
        signals.push(`reasoning_keyword:${keyword}`);
        break; // one keyword match is sufficient
      }
    }
  }

  // Signal 3: very low freshness score
  const freshness = Number(estimate.freshness_score ?? estimate.freshnessScore ?? 1);
  if (freshness < 0.2) {
    signals.push(`low_freshness:${freshness}`);
  }

  const isUninformed = signals.length > 0;
  return { isUninformed, signals };
}
