import { assertSchema } from "../domain/schemas.js";

function clampProbability(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0.5;
  }
  return Math.min(0.95, Math.max(0.05, Number(number.toFixed(4))));
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

function evidenceQuality(evidence) {
  const usable = evidence.filter((item) => item.status !== "failed" && item.relevanceScore > 0);
  if (usable.length === 0) {
    return 0;
  }
  const avgRelevance = usable.reduce((sum, item) => sum + item.relevanceScore, 0) / usable.length;
  const credibility = usable.reduce((sum, item) => {
    if (item.credibility === "high") return sum + 1;
    if (item.credibility === "medium") return sum + 0.65;
    return sum + 0.3;
  }, 0) / usable.length;
  return Number(((avgRelevance * 0.6) + (credibility * 0.4)).toFixed(4));
}

function textSignals(evidence) {
  const text = evidence.map((item) => `${item.title} ${item.summary}`).join("\n").toLowerCase();
  const positiveWords = ["confirmed", "official", "announced", "approved", "will", "record", "increase", "cut", "release"];
  const negativeWords = ["denied", "delayed", "unlikely", "failed", "cancelled", "blocked", "not", "miss", "decrease"];
  const positive = positiveWords.reduce((sum, word) => sum + (text.includes(word) ? 1 : 0), 0);
  const negative = negativeWords.reduce((sum, word) => sum + (text.includes(word) ? 1 : 0), 0);
  return { positive, negative };
}

function categoryPrior(market) {
  return {
    economics: 0.015,
    ai: 0.02,
    politics: 0.01,
    sports: 0
  }[market.category ?? ""] ?? 0;
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

function confidenceFor({ evidence, quality, freshness, uncertaintyFactors }) {
  if (uncertaintyFactors.includes("insufficient_evidence") || uncertaintyFactors.includes("stale_evidence")) {
    return "low";
  }
  if (evidence.length >= 3 && quality >= 0.68 && freshness >= 0.7) {
    return "high";
  }
  if (quality >= 0.45 && freshness >= 0.45) {
    return "medium";
  }
  return "low";
}

class LocalHeuristicProbabilityProvider {
  constructor(config = {}) {
    this.config = config;
  }

  async estimate({ market, evidence }) {
    const yesOutcome = market.outcomes.find((item) => item.label.toLowerCase() === "yes") ?? market.outcomes[0];
    const implied = yesOutcome ? marketProbability(yesOutcome) : null;
    const base = implied ?? 0.5;
    const quality = evidenceQuality(evidence);
    const freshness = freshnessScore(evidence);
    const signals = textSignals(evidence);
    const minEvidence = this.config.evidence?.minEvidenceItems ?? 2;
    const usableCount = evidence.filter((item) => item.status !== "failed" && item.relevanceScore > 0).length;
    const uncertaintyFactors = [];

    if (usableCount < minEvidence) {
      uncertaintyFactors.push("insufficient_evidence");
    }
    if (freshness < 0.45) {
      uncertaintyFactors.push("stale_evidence");
    }
    if (market.riskFlags?.length) {
      uncertaintyFactors.push(...market.riskFlags.map((flag) => `market_${flag}`));
    }
    if (implied == null) {
      uncertaintyFactors.push("missing_market_price");
    }

    const signalAdjustment = (signals.positive - signals.negative) * 0.01;
    const evidenceAdjustment = (quality - 0.5) * 0.08;
    const aiProbability = clampProbability(base + categoryPrior(market) + signalAdjustment + evidenceAdjustment);
    const confidence = confidenceFor({ evidence, quality, freshness, uncertaintyFactors });

    return {
      ai_probability: aiProbability,
      confidence,
      reasoning_summary: confidence === "low"
        ? "Evidence coverage is weak or stale; the estimate is advisory and should generally result in no-trade."
        : "Estimate combines current market pricing with collected resolution, market metadata, evidence relevance, credibility, and freshness.",
      key_evidence: keyEvidence(evidence),
      counter_evidence: counterEvidence(evidence),
      uncertainty_factors: [...new Set(uncertaintyFactors)],
      freshness_score: freshness
    };
  }
}

export class ProbabilityEstimator {
  constructor(config = {}, options = {}) {
    this.config = config;
    this.provider = options.provider ?? new LocalHeuristicProbabilityProvider(config);
  }

  async estimate({ market, evidenceBundle = null, evidence = null }) {
    const evidenceItems = normalizeEvidenceInput(evidence ?? evidenceBundle);
    const providerResult = await this.provider.estimate({ market, evidence: evidenceItems });
    const aiProbability = clampProbability(providerResult.ai_probability ?? providerResult.aiProbability);
    const confidence = providerResult.confidence ?? "low";
    const freshness = Number(providerResult.freshness_score ?? providerResult.freshnessScore ?? freshnessScore(evidenceItems));
    const keyItems = providerResult.key_evidence ?? providerResult.keyEvidence ?? keyEvidence(evidenceItems);
    const counterItems = providerResult.counter_evidence ?? providerResult.counterEvidence ?? counterEvidence(evidenceItems);
    const uncertainty = providerResult.uncertainty_factors ?? providerResult.uncertaintyFactors ?? [];
    const reasoning = providerResult.reasoning_summary ?? providerResult.reasoningSummary ?? "No reasoning summary returned.";
    const generatedAt = new Date().toISOString();

    const estimates = market.outcomes.map((outcome) => {
      const label = outcome.label.toLowerCase();
      const outcomeAiProbability = label === "no" ? clampProbability(1 - aiProbability) : aiProbability;
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
      outcomeEstimates: estimates,
      diagnostics: {
        provider: this.config.ai?.provider ?? "local",
        model: this.config.ai?.model || "local-heuristic",
        generatedAt,
        missingEvidence: [...new Set(uncertainty)].filter((item) => item.includes("evidence")),
        evidenceCount: evidenceItems.length,
        promptTemplate: "prompts/probability-estimation.md"
      }
    });
  }
}

export const probabilityProviders = {
  LocalHeuristicProbabilityProvider
};
