import { assertSchema } from "../domain/schemas.js";
import { CodexProbabilityProvider } from "../runtime/codex-runtime.js";
import { ClaudeProbabilityProvider } from "../runtime/claude-runtime.js";
import { resolveEffectiveProvider } from "../runtime/codex-skill-settings.js";

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

    const estimates = market.outcomes.map((outcome, index) => {
      const label = outcome.label.toLowerCase();
      const isNoSide = label === "no" || (index === 1 && label !== "yes");
      const outcomeAiProbability = isNoSide ? clampProbability(1 - aiProbability) : aiProbability;
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
}

export const probabilityProviders = {};
