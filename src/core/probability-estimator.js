import { assertSchema } from "../domain/schemas.js";
import { CodexProbabilityProvider } from "../runtime/codex-runtime.js";
import { ClaudeProbabilityProvider } from "../runtime/claude-runtime.js";
import { resolveEffectiveProvider } from "../runtime/codex-skill-settings.js";

function clampProbability(value, min = 0.01, max = 0.99) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0.5;
  }
  return Math.min(max, Math.max(min, Number(number.toFixed(4))));
}

function marketProbability(outcome) {
  return outcome.bestAsk ?? outcome.impliedProbability ?? outcome.lastPrice ?? outcome.bestBid ?? null;
}

function normalizeEvidenceInput(input) {
  if (Array.isArray(input)) {
    return input;
  }
  if (Array.isArray(input?.items)) {
    return input.items;
  }
  return [];
}

function evidenceAgeDays(evidence) {
  const timestamp = Date.parse(evidence.timestamp ?? evidence.retrievedAt);
  if (!Number.isFinite(timestamp)) {
    return 30;
  }
  return Math.max(0, (Date.now() - timestamp) / 86_400_000);
}

function freshnessScore(evidence) {
  if (evidence.length === 0) {
    return 0;
  }
  const scores = evidence.map((item) => {
    const age = evidenceAgeDays(item);
    if (item.status === "failed") return 0;
    if (age <= 1) return 1;
    if (age <= 7) return 0.75;
    if (age <= 30) return 0.45;
    return 0.15;
  });
  return Number((scores.reduce((sum, score) => sum + score, 0) / scores.length).toFixed(4));
}

function keyEvidence(evidence) {
  return evidence
    .filter((item) => item.status !== "failed")
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, 5);
}

function counterEvidence(evidence) {
  return evidence
    .filter((item) => {
      const text = `${item.title} ${item.summary}`.toLowerCase();
      return item.status === "failed" || ["unlikely", "delayed", "denied", "cancelled", "missing", "unavailable"].some((word) => text.includes(word));
    })
    .slice(0, 5);
}

function normalizeDistribution(outcomes) {
  const sum = outcomes.reduce((acc, o) => acc + (Number(o.probability) || 0), 0);
  const deviation = Math.abs(sum - 1.0);
  if (deviation > 0.20) {
    console.warn(`event_group_distribution_deviation: sum=${sum.toFixed(4)}, expected=1.0, deviation=${(deviation * 100).toFixed(1)}%`);
  }
  if (sum === 0) {
    const uniform = 1 / outcomes.length;
    return { outcomes: outcomes.map((o) => ({ ...o, probability: uniform })), normalizedFromSum: 0 };
  }
  return {
    outcomes: outcomes.map((o) => ({ ...o, probability: o.probability / sum })),
    normalizedFromSum: sum
  };
}

function decomposeGroupEstimate(groupResult, markets, evidenceMap, config, providerName) {
  const { outcomes: normalizedOutcomes, normalizedFromSum } = normalizeDistribution(groupResult.outcomes);
  const clampMin = config.calibration?.probabilityClampMin ?? 0.01;
  const clampMax = config.calibration?.probabilityClampMax ?? 0.99;
  const generatedAt = new Date().toISOString();

  return markets.map((market) => {
    const outcomeEntry = normalizedOutcomes.find(
      (o) => o.market_id === market.marketId || o.market_slug === market.marketSlug
    );
    if (!outcomeEntry) {
      return null;
    }
    const aiProbability = clampProbability(outcomeEntry.probability, clampMin, clampMax);
    const confidence = outcomeEntry.confidence ?? groupResult.distribution_confidence ?? "low";
    const reasoning = outcomeEntry.reasoning_summary ?? groupResult.distribution_reasoning ?? "Joint estimation — no per-market reasoning.";
    const keyItems = (outcomeEntry.key_evidence ?? []).slice(0, 5);
    const counterItems = (outcomeEntry.counter_evidence ?? []).slice(0, 5);
    const uncertainty = outcomeEntry.uncertainty_factors ?? [];
    const baseRate = outcomeEntry.base_rate ?? null;
    const baseRateSource = outcomeEntry.base_rate_source ?? null;
    const evidenceAdjustment = outcomeEntry.evidence_adjustment ?? null;
    const deviationJustification = outcomeEntry.deviation_justification ?? null;
    const freshness = Number(groupResult.freshness_score ?? 0);
    const evidenceItems = evidenceMap.get(market.marketId) ?? [];

    const estimates = market.outcomes.map((outcome, index) => {
      const label = outcome.label.toLowerCase();
      const isNoSide = label === "no" || (index === 1 && label !== "yes");
      const outcomeAiProbability = isNoSide ? clampProbability(1 - aiProbability, clampMin, clampMax) : aiProbability;
      const implied = marketProbability(outcome);
      return {
        tokenId: outcome.tokenId,
        label: outcome.label,
        aiProbability: outcomeAiProbability,
        marketProbability: implied,
        confidence,
        reasoning,
        evidenceIds: keyItems.map((item) => item.evidenceId)
      };
    });

    const estimate = assertSchema("ProbabilityEstimate", {
      marketId: market.marketId,
      targetOutcome: "yes",
      ai_probability: aiProbability,
      aiProbability,
      confidence,
      reasoning_summary: reasoning,
      reasoningSummary: reasoning,
      key_evidence: keyItems,
      keyEvidence: keyItems,
      counter_evidence: counterItems,
      counterEvidence: counterItems,
      uncertainty_factors: [...new Set(uncertainty)],
      uncertaintyFactors: [...new Set(uncertainty)],
      freshness_score: Number(freshness.toFixed(4)),
      freshnessScore: Number(freshness.toFixed(4)),
      base_rate: baseRate,
      baseRate: baseRate,
      base_rate_source: baseRateSource,
      baseRateSource: baseRateSource,
      evidence_adjustment: evidenceAdjustment,
      evidenceAdjustment: evidenceAdjustment,
      deviation_justification: deviationJustification,
      deviationJustification: deviationJustification,
      outcomeEstimates: estimates,
      diagnostics: {
        provider: providerName,
        effectiveProvider: providerName,
        estimationMode: "event_group_joint",
        distributionConfidence: groupResult.distribution_confidence ?? null,
        normalizedFromSum,
        model: config.ai?.model || providerName,
        generatedAt,
        evidenceCount: evidenceItems.length
      }
    });
    return { market, estimate };
  }).filter(Boolean);
}

export class ProbabilityEstimator {
  constructor(config = {}) {
    this.config = config;
    const providerName = resolveEffectiveProvider(config);
    this.providerName = providerName;
    if (providerName === "codex") {
      this.provider = new CodexProbabilityProvider(config);
    } else if (providerName === "claude-code") {
      this.provider = new ClaudeProbabilityProvider(config);
    } else {
      throw new Error(`unsupported_probability_provider: ${providerName}; configure codex or claude-code`);
    }
  }

  async estimate({ market, evidenceBundle = null, evidence = null, upstreamContext = null }) {
    const evidenceItems = normalizeEvidenceInput(evidence ?? evidenceBundle);
    const providerResult = await this.provider.estimate({ market, evidence: evidenceItems, upstreamContext });
    const clampMin = this.config.calibration?.probabilityClampMin ?? 0.01;
    const clampMax = this.config.calibration?.probabilityClampMax ?? 0.99;
    const aiProbability = clampProbability(providerResult.ai_probability ?? providerResult.aiProbability, clampMin, clampMax);
    const confidence = providerResult.confidence ?? "low";
    const freshness = Number(providerResult.freshness_score ?? providerResult.freshnessScore ?? freshnessScore(evidenceItems));
    const keyItems = providerResult.key_evidence ?? providerResult.keyEvidence ?? keyEvidence(evidenceItems);
    const counterItems = providerResult.counter_evidence ?? providerResult.counterEvidence ?? counterEvidence(evidenceItems);
    const uncertainty = providerResult.uncertainty_factors ?? providerResult.uncertaintyFactors ?? [];
    const reasoning = providerResult.reasoning_summary ?? providerResult.reasoningSummary ?? "No reasoning summary returned.";
    const baseRate = providerResult.base_rate ?? providerResult.baseRate ?? null;
    const baseRateSource = providerResult.base_rate_source ?? providerResult.baseRateSource ?? null;
    const evidenceAdjustment = providerResult.evidence_adjustment ?? providerResult.evidenceAdjustment ?? null;
    const deviationJustification = providerResult.deviation_justification ?? providerResult.deviationJustification ?? null;
    const generatedAt = new Date().toISOString();

    const estimates = market.outcomes.map((outcome, index) => {
      const label = outcome.label.toLowerCase();
      const isNoSide = label === "no" || (index === 1 && label !== "yes");
      const outcomeAiProbability = isNoSide ? clampProbability(1 - aiProbability, clampMin, clampMax) : aiProbability;
      const implied = marketProbability(outcome);
      return {
        tokenId: outcome.tokenId,
        label: outcome.label,
        aiProbability: outcomeAiProbability,
        marketProbability: implied,
        confidence,
        reasoning,
        evidenceIds: keyItems.map((item) => item.evidenceId)
      };
    });

    return assertSchema("ProbabilityEstimate", {
      marketId: market.marketId,
      targetOutcome: "yes",
      ai_probability: aiProbability,
      aiProbability,
      confidence,
      reasoning_summary: reasoning,
      reasoningSummary: reasoning,
      key_evidence: keyItems,
      keyEvidence: keyItems,
      counter_evidence: counterItems,
      counterEvidence: counterItems,
      uncertainty_factors: [...new Set(uncertainty)],
      uncertaintyFactors: [...new Set(uncertainty)],
      freshness_score: Number(freshness.toFixed(4)),
      freshnessScore: Number(freshness.toFixed(4)),
      base_rate: baseRate,
      baseRate: baseRate,
      base_rate_source: baseRateSource,
      baseRateSource: baseRateSource,
      evidence_adjustment: evidenceAdjustment,
      evidenceAdjustment: evidenceAdjustment,
      deviation_justification: deviationJustification,
      deviationJustification: deviationJustification,
      outcomeEstimates: estimates,
      diagnostics: {
        provider: this.providerName,
        effectiveProvider: this.providerName,
        decisionStrategy: this.config.pulse?.strategy ?? "pulse-direct",
        aiUsage: this.config.pulse?.strategy === "pulse-direct"
          ? "pulse-direct-compatible_probability_only"
          : "single_market_probability_only",
        model: this.config.ai?.model || this.providerName,
        generatedAt,
        missingEvidence: [...new Set(uncertainty)].filter((item) => item.includes("evidence")),
        evidenceCount: evidenceItems.length,
        promptTemplate: "src/runtime/codex-runtime.js#buildPrompt"
      }
    });
  }

  async estimateEventGroup({ markets, evidenceMap, upstreamContexts = null }) {
    const groupResult = await this.provider.estimateGroup({ markets, evidenceMap, upstreamContexts });
    return decomposeGroupEstimate(groupResult, markets, evidenceMap, this.config, this.providerName);
  }
}

export const probabilityProviders = {};
