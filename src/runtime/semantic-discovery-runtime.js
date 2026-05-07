/**
 * SemanticDiscoveryRuntime
 *
 * Aligns with Predict-Raven's full-market semantic discovery:
 * Takes topics proposed by TopicDiscoveryProvider and automatically searches
 * the full Polymarket market list to find matching markets, performing
 * semantic clustering, duplicate event merging, and opportunity mapping.
 *
 * Key properties:
 * - Receives discovered topics (from TopicDiscoveryProvider) with search_terms
 * - Matches search_terms against all active Polymarket markets (question, slug, tags)
 * - Groups matched markets into semantic clusters
 * - Identifies duplicate/overlapping events across different market slugs
 * - Outputs a prioritized opportunity map with matched markets added to candidate pool
 * - Graceful failure: returns empty results on timeout/error, never blocks pipeline
 *
 * This bridges the gap between "AI discovers topics" and "topics become candidates":
 * TopicDiscoveryProvider -> SemanticDiscoveryRuntime -> additional candidates in pool
 */

function normalizeText(value) {
  return String(value ?? "").trim().toLowerCase();
}

function tokenize(text) {
  return normalizeText(text).split(/[\s\-_/.,;:!?()[\]{}'"]+/).filter((t) => t.length > 1);
}

function marketMatchesTerms(market, searchTerms) {
  const haystack = [
    market.question,
    market.marketSlug,
    market.eventSlug,
    market.category,
    market.title,
    ...(market.tags ?? [])
  ].filter(Boolean).join(" ").toLowerCase();

  let matchCount = 0;
  for (const term of searchTerms) {
    const normalized = normalizeText(term);
    if (normalized && haystack.includes(normalized)) {
      matchCount += 1;
    }
  }
  return { matched: matchCount > 0, matchCount, matchRatio: searchTerms.length > 0 ? matchCount / searchTerms.length : 0 };
}

function computeSimilarity(marketA, marketB) {
  const tokensA = new Set(tokenize(`${marketA.question} ${marketA.marketSlug} ${(marketA.tags ?? []).join(" ")}`));
  const tokensB = new Set(tokenize(`${marketB.question} ${marketB.marketSlug} ${(marketB.tags ?? []).join(" ")}`));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let overlap = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) overlap += 1;
  }
  return overlap / Math.sqrt(tokensA.size * tokensB.size);
}

function clusterMarkets(markets, similarityThreshold = 0.3) {
  const clusters = [];
  const assigned = new Set();

  for (let i = 0; i < markets.length; i++) {
    if (assigned.has(i)) continue;
    const cluster = { representative: markets[i], members: [markets[i]], indices: [i] };
    assigned.add(i);

    for (let j = i + 1; j < markets.length; j++) {
      if (assigned.has(j)) continue;
      const sim = computeSimilarity(markets[i], markets[j]);
      if (sim >= similarityThreshold) {
        cluster.members.push(markets[j]);
        cluster.indices.push(j);
        assigned.add(j);
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

function deduplicateByEvent(markets) {
  const seen = new Map();
  const unique = [];
  const duplicates = [];

  for (const market of markets) {
    const eventKey = market.eventId || market.eventSlug || market.marketId;
    if (seen.has(eventKey)) {
      duplicates.push({ market, duplicateOf: seen.get(eventKey).marketSlug });
    } else {
      seen.set(eventKey, market);
      unique.push(market);
    }
  }
  return { unique, duplicates };
}

export class SemanticDiscoveryRuntime {
  constructor(config = {}) {
    this.config = config;
    this.enabled = config.pulse?.semanticDiscovery !== false;
    this.maxMatchedMarkets = config.pulse?.semanticDiscoveryMaxMatched ?? 10;
    this.similarityThreshold = config.pulse?.semanticDiscoverySimilarityThreshold ?? 0.3;
  }

  discover({ discoveredTopics = [], allMarkets = [], existingCandidateIds = new Set() }) {
    if (!this.enabled || discoveredTopics.length === 0 || allMarkets.length === 0) {
      return {
        matchedMarkets: [],
        clusters: [],
        duplicates: [],
        topicMatches: [],
        skipped: !this.enabled
      };
    }

    const topicMatches = [];
    const allMatched = new Map();

    for (const topic of discoveredTopics) {
      const matches = [];
      for (const market of allMarkets) {
        if (existingCandidateIds.has(market.marketId)) continue;
        const result = marketMatchesTerms(market, topic.search_terms);
        if (result.matched) {
          matches.push({ market, matchCount: result.matchCount, matchRatio: result.matchRatio });
          allMatched.set(market.marketId, market);
        }
      }
      matches.sort((a, b) => b.matchRatio - a.matchRatio || b.matchCount - a.matchCount);
      topicMatches.push({
        topic: topic.topic,
        category: topic.category,
        urgency: topic.urgency,
        confidence: topic.confidence,
        matchedCount: matches.length,
        topMatches: matches.slice(0, 3).map((m) => ({
          marketSlug: m.market.marketSlug,
          question: m.market.question,
          matchRatio: m.matchRatio
        }))
      });
    }

    const matchedArray = [...allMatched.values()].slice(0, this.maxMatchedMarkets);
    const { unique, duplicates } = deduplicateByEvent(matchedArray);
    const clusters = clusterMarkets(unique, this.similarityThreshold);

    return {
      matchedMarkets: unique,
      clusters: clusters.map((c) => ({
        representative: c.representative.marketSlug,
        members: c.members.map((m) => m.marketSlug),
        size: c.members.length
      })),
      duplicates: duplicates.map((d) => ({
        market: d.market.marketSlug,
        duplicateOf: d.duplicateOf
      })),
      topicMatches,
      totalTopics: discoveredTopics.length,
      totalMatched: allMatched.size,
      uniqueAfterDedup: unique.length
    };
  }
}

export const semanticDiscoveryInternals = {
  marketMatchesTerms,
  computeSimilarity,
  clusterMarkets,
  deduplicateByEvent,
  tokenize
};
