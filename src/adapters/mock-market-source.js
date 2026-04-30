import { assertSchema } from "../domain/schemas.js";
import { maskAddress } from "../config/env.js";
import { applyMarketFilters, describeMarketFilters } from "./market-filters.js";

const fetchedAt = () => new Date().toISOString();

function market(input) {
  return assertSchema("Market", {
    endDate: null,
    resolutionRules: "Resolves according to the referenced public source.",
    resolutionSourceUrl: "https://polymarket.com",
    title: null,
    marketUrl: null,
    category: "news",
    tags: [],
    volumeUsd: 0,
    active: true,
    closed: false,
    tradable: true,
    source: "mock-polymarket",
    riskFlags: [],
    fetchedAt: fetchedAt(),
    ...input
  });
}

export const SAMPLE_MARKETS = [
  market({
    marketId: "market-001",
    eventId: "event-001",
    marketSlug: "fed-cut-before-july",
    eventSlug: "fed-policy-2026",
    question: "Will the Fed cut rates before July 2026?",
    outcomes: [
      { id: "market-001-yes", label: "Yes", tokenId: "token-fed-yes", bestBid: 0.41, bestAsk: 0.43, lastPrice: 0.42, impliedProbability: 0.42 },
      { id: "market-001-no", label: "No", tokenId: "token-fed-no", bestBid: 0.57, bestAsk: 0.59, lastPrice: 0.58, impliedProbability: 0.58 }
    ],
    endDate: "2026-07-01T00:00:00.000Z",
    resolutionSourceUrl: "https://www.federalreserve.gov/monetarypolicy.htm",
    liquidityUsd: 25000,
    volumeUsd: 120000,
    volume24hUsd: 4100,
    category: "economics",
    tags: ["fed", "rates"]
  }),
  market({
    marketId: "market-002",
    eventId: "event-002",
    marketSlug: "major-ai-model-release-q2",
    eventSlug: "ai-releases-2026",
    question: "Will a major AI lab release a frontier model in Q2 2026?",
    outcomes: [
      { id: "market-002-yes", label: "Yes", tokenId: "token-ai-yes", bestBid: 0.52, bestAsk: 0.55, lastPrice: 0.54, impliedProbability: 0.54 },
      { id: "market-002-no", label: "No", tokenId: "token-ai-no", bestBid: 0.45, bestAsk: 0.48, lastPrice: 0.46, impliedProbability: 0.46 }
    ],
    endDate: "2026-06-30T23:59:59.000Z",
    resolutionSourceUrl: "https://polymarket.com",
    liquidityUsd: 18000,
    volumeUsd: 96000,
    volume24hUsd: 6200,
    category: "ai",
    tags: ["ai", "technology"]
  }),
  market({
    marketId: "market-003",
    eventId: "event-003",
    marketSlug: "election-turnout-record",
    eventSlug: "election-2026",
    question: "Will the next major election set a turnout record?",
    outcomes: [
      { id: "market-003-yes", label: "Yes", tokenId: "token-election-yes", bestBid: 0.22, bestAsk: 0.25, lastPrice: 0.24, impliedProbability: 0.24 },
      { id: "market-003-no", label: "No", tokenId: "token-election-no", bestBid: 0.75, bestAsk: 0.78, lastPrice: 0.76, impliedProbability: 0.76 }
    ],
    endDate: "2026-11-05T00:00:00.000Z",
    resolutionSourceUrl: "https://polymarket.com",
    liquidityUsd: 12000,
    volumeUsd: 45000,
    volume24hUsd: 900,
    category: "politics",
    tags: ["election"]
  })
];

export class MockMarketSource {
  constructor(config, stateStore = null) {
    this.config = config;
    this.stateStore = stateStore;
  }

  async scan(request = {}) {
    const limit = Math.max(1, Number(request.limit ?? this.config.scan.marketScanLimit));
    const filters = describeMarketFilters(request);
    const normalized = SAMPLE_MARKETS.map((item) => ({ ...item, fetchedAt: fetchedAt() }));
    const markets = applyMarketFilters(normalized, filters).slice(0, limit);
    return {
      source: "mock-polymarket",
      fetchedAt: fetchedAt(),
      fromCache: false,
      fallback: false,
      totalFetched: SAMPLE_MARKETS.length,
      totalNormalized: SAMPLE_MARKETS.length,
      filteredOut: Math.max(0, SAMPLE_MARKETS.length - markets.length),
      totalReturned: markets.length,
      cursor: null,
      filters,
      paging: null,
      markets,
      riskFlags: markets.length === 0 ? ["market_scan_empty"] : [],
      errors: []
    };
  }

  async getMarket(marketIdOrSlug) {
    const scan = await this.scan({ limit: SAMPLE_MARKETS.length });
    return scan.markets.find((item) =>
      item.marketId === marketIdOrSlug || item.marketSlug === marketIdOrSlug
    ) ?? null;
  }

  async getOrderBook(tokenId) {
    for (const marketItem of SAMPLE_MARKETS) {
      const outcome = marketItem.outcomes.find((item) => item.tokenId === tokenId);
      if (outcome) {
        return {
          tokenId,
          bestBid: outcome.bestBid,
          bestAsk: outcome.bestAsk,
          minOrderSize: 1,
          asks: [{ price: outcome.bestAsk ?? outcome.lastPrice ?? 0.5, size: 100 }],
          bids: [{ price: outcome.bestBid ?? outcome.lastPrice ?? 0.5, size: 100 }]
        };
      }
    }
    return null;
  }

  async getAccountBalance() {
    const portfolio = this.stateStore ? await this.stateStore.getPortfolio() : null;
    return {
      accountId: maskAddress(this.config.funderAddress),
      mode: this.config.executionMode,
      availableUsd: portfolio?.cashUsd ?? 0,
      totalEquityUsd: portfolio?.totalEquityUsd ?? 0,
      openPositions: portfolio?.positions.length ?? 0,
      source: this.config.executionMode === "paper" ? "paper-state" : "offline-preflight",
      updatedAt: new Date().toISOString()
    };
  }

  async getOpenPositions() {
    const portfolio = this.stateStore ? await this.stateStore.getPortfolio() : null;
    return portfolio?.positions ?? [];
  }
}
