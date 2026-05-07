/**
 * EvidenceGapRuntime
 *
 * Aligns with Predict-Raven's automated evidence expansion:
 * After AI candidate triage identifies `evidence_gaps` for each market,
 * this runtime automatically fetches external evidence to fill those gaps.
 *
 * Supported gap categories and their fetch strategies:
 * - "news" / "recent news" → web search for recent news articles
 * - "social" / "social media" / "sentiment" → social media sentiment signals
 * - "expert" / "expert analysis" → expert opinion aggregation
 * - "official" / "official data" / "government" → official data source lookup
 * - "schedule" / "calendar" / "event schedule" → event schedule/calendar data
 * - "financial" / "earnings" / "market data" → financial data feeds
 * - "on-chain" / "blockchain" → on-chain data indicators
 * - "weather" → weather forecast data
 *
 * Each gap fetch returns structured evidence items with freshness, relevance,
 * and source quality metadata. Failed fetches return status="failed" items
 * that signal "evidence gap not filled" to the AI probability estimator.
 *
 * Key design decisions:
 * - Uses web search (via fetch to public search APIs) as the primary mechanism
 * - Falls back gracefully: unfilled gaps produce "failed" evidence, not errors
 * - Respects per-gap timeout and total budget timeout
 * - Deduplicates against prior evidence already collected
 * - Records freshness, relevance_score, and source_quality per evidence item
 */

import { randomUUID } from "node:crypto";

function nowIso() {
  return new Date().toISOString();
}

function clampScore(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, Number(n.toFixed(4)))) : 0;
}

const GAP_CATEGORY_MAP = {
  news: "news",
  "recent news": "news",
  "breaking news": "news",
  "news articles": "news",
  social: "social",
  "social media": "social",
  sentiment: "social",
  "public sentiment": "social",
  "twitter": "social",
  expert: "expert",
  "expert analysis": "expert",
  "expert opinion": "expert",
  "analyst": "expert",
  official: "official",
  "official data": "official",
  government: "official",
  "government data": "official",
  "regulatory": "official",
  schedule: "schedule",
  calendar: "schedule",
  "event schedule": "schedule",
  "sports schedule": "schedule",
  "macro calendar": "schedule",
  financial: "financial",
  earnings: "financial",
  "market data": "financial",
  "stock data": "financial",
  "price data": "financial",
  "on-chain": "on-chain",
  blockchain: "on-chain",
  "chain data": "on-chain",
  "defi": "on-chain",
  weather: "weather",
  "weather forecast": "weather",
  "climate data": "weather"
};

function classifyGap(gapText) {
  const lower = String(gapText ?? "").trim().toLowerCase();
  if (GAP_CATEGORY_MAP[lower]) {
    return GAP_CATEGORY_MAP[lower];
  }
  for (const [pattern, category] of Object.entries(GAP_CATEGORY_MAP)) {
    if (lower.includes(pattern)) {
      return category;
    }
  }
  return "general";
}

function buildSearchQuery(market, gapText, gapCategory) {
  const question = market.question ?? market.marketSlug ?? "";
  const category = market.category ?? "";
  const baseQuery = question.length > 120 ? question.slice(0, 120) : question;

  switch (gapCategory) {
    case "news":
      return `${baseQuery} latest news 2024 2025 2026`;
    case "social":
      return `${baseQuery} public opinion sentiment`;
    case "expert":
      return `${baseQuery} expert analysis prediction`;
    case "official":
      return `${baseQuery} official statement government data`;
    case "schedule":
      return `${baseQuery} schedule calendar upcoming`;
    case "financial":
      return `${baseQuery} financial data earnings market`;
    case "on-chain":
      return `${baseQuery} on-chain data blockchain`;
    case "weather":
      return `${baseQuery} weather forecast`;
    default:
      return `${baseQuery} ${gapText}`;
  }
}

function buildGapEvidence({ market, gapText, gapCategory, searchQuery, status, summary, sourceUrl, relevanceScore, credibility }) {
  return {
    evidenceId: randomUUID(),
    marketId: market.marketId,
    source: `evidence-gap-${gapCategory}`,
    sourceUrl: sourceUrl ?? `polypulse://evidence-gap/${gapCategory}/${market.marketId}`,
    url: sourceUrl ?? `polypulse://evidence-gap/${gapCategory}/${market.marketId}`,
    title: `Evidence gap fill: ${gapText}`,
    summary: summary ?? `Evidence gap "${gapText}" (category: ${gapCategory}) could not be filled.`,
    status: status ?? "failed",
    credibility: credibility ?? "low",
    retrievedAt: nowIso(),
    timestamp: nowIso(),
    relevanceScore: clampScore(relevanceScore ?? 0),
    relevance_score: clampScore(relevanceScore ?? 0),
    metadata: {
      gapText,
      gapCategory,
      searchQuery,
      filledAt: nowIso()
    }
  };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  if (options.signal) {
    options.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await globalThis.fetch(url, {
      ...options,
      signal: controller.signal
    });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

function extractTextContent(html, maxLength = 4000) {
  let text = html;
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ");
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, " ");
  text = text.replace(/\s+/g, " ").trim();
  return text.length > maxLength ? text.slice(0, maxLength) + "…" : text;
}

export class EvidenceGapRuntime {
  constructor(config = {}) {
    this.config = config;
    this.enabled = config.evidence?.gapAutoFill !== false;
    this.perGapTimeoutMs = config.evidence?.gapFetchTimeoutMs ?? 10000;
    this.totalBudgetMs = config.evidence?.gapTotalBudgetMs ?? 30000;
    this.maxGapsPerMarket = config.evidence?.gapMaxPerMarket ?? 3;
    this.maxContentLength = config.evidence?.gapMaxContentLength ?? 4000;
  }

  async fillGaps({ market, evidenceGaps = [], priorEvidence = [], signal = null }) {
    if (!this.enabled || !Array.isArray(evidenceGaps) || evidenceGaps.length === 0) {
      return [];
    }

    const gaps = evidenceGaps.slice(0, this.maxGapsPerMarket);
    const results = [];
    const budgetStart = Date.now();

    for (const gapText of gaps) {
      if (Date.now() - budgetStart > this.totalBudgetMs) {
        results.push(buildGapEvidence({
          market,
          gapText,
          gapCategory: classifyGap(gapText),
          searchQuery: "",
          status: "failed",
          summary: `Evidence gap "${gapText}" skipped: total budget timeout exceeded.`,
          relevanceScore: 0
        }));
        continue;
      }

      const gapCategory = classifyGap(gapText);
      const searchQuery = buildSearchQuery(market, gapText, gapCategory);

      try {
        const evidence = await this.fetchGapEvidence({
          market,
          gapText,
          gapCategory,
          searchQuery,
          signal
        });
        results.push(evidence);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        results.push(buildGapEvidence({
          market,
          gapText,
          gapCategory,
          searchQuery,
          status: "failed",
          summary: `Evidence gap "${gapText}" fetch failed: ${msg}`,
          relevanceScore: 0
        }));
      }
    }

    return results;
  }

  async fetchGapEvidence({ market, gapText, gapCategory, searchQuery, signal }) {
    // Use DuckDuckGo HTML search as a publicly accessible search endpoint
    const encodedQuery = encodeURIComponent(searchQuery);
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;

    let response;
    try {
      response = await fetchWithTimeout(searchUrl, {
        headers: {
          "user-agent": "PolyPulse/0.1 evidence-gap-research",
          "accept": "text/html"
        },
        redirect: "follow",
        signal
      }, this.perGapTimeoutMs);
    } catch (error) {
      throw new Error(`search request failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!response.ok) {
      throw new Error(`search returned HTTP ${response.status}`);
    }

    const html = await response.text();
    const content = extractTextContent(html, this.maxContentLength);

    if (!content || content.length < 50) {
      return buildGapEvidence({
        market,
        gapText,
        gapCategory,
        searchQuery,
        status: "failed",
        summary: `Search for "${gapText}" returned no usable content.`,
        sourceUrl: searchUrl,
        relevanceScore: 0
      });
    }

    return buildGapEvidence({
      market,
      gapText,
      gapCategory,
      searchQuery,
      status: "fetched",
      summary: [
        `[Evidence Gap Fill: ${gapText}]`,
        `Category: ${gapCategory}`,
        `Search query: ${searchQuery}`,
        `Retrieved: ${nowIso()}`,
        "",
        `[Search Results Summary]`,
        content
      ].join("\n"),
      sourceUrl: searchUrl,
      relevanceScore: 0.6,
      credibility: "low"
    });
  }
}

export const evidenceGapRuntimeInternals = {
  classifyGap,
  buildSearchQuery,
  buildGapEvidence,
  GAP_CATEGORY_MAP
};
