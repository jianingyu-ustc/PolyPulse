/**
 * OrderBookEvidenceAdapter
 *
 * Fetches CLOB order book depth for each outcome token of a market, providing
 * bid/ask spread, depth levels, and liquidity metrics as structured evidence
 * for AI probability estimation.
 *
 * This aligns with Predict-Raven's orderbook.ts research step:
 * - Best bid / best ask / spread / spread%
 * - Top N bid/ask levels (price + size)
 * - Depth within 2% of mid-price (bid_size, ask_size)
 *
 * The adapter calls PolymarketMarketSource.getOrderBook(tokenId) which hits
 * the Polymarket CLOB endpoint at /book?token_id=<tokenId>.
 */

function formatSpread(bestBid, bestAsk) {
  if (bestBid == null || bestAsk == null) return { spread: null, spreadPct: null };
  const spread = bestAsk - bestBid;
  const mid = (bestBid + bestAsk) / 2;
  const spreadPct = mid > 0 ? spread / mid : null;
  return { spread: Number(spread.toFixed(4)), spreadPct: spreadPct != null ? Number(spreadPct.toFixed(4)) : null };
}

function computeDepth2Pct(levels, mid, side) {
  if (!Array.isArray(levels) || mid <= 0) return 0;
  const threshold = side === "bid" ? mid * 0.98 : mid * 1.02;
  let totalSize = 0;
  for (const level of levels) {
    const price = Number(level.price);
    const size = Number(level.size);
    if (!Number.isFinite(price) || !Number.isFinite(size)) continue;
    if (side === "bid" && price >= threshold) {
      totalSize += size;
    } else if (side === "ask" && price <= threshold) {
      totalSize += size;
    }
  }
  return Number(totalSize.toFixed(2));
}

function topLevels(levels, count = 5) {
  if (!Array.isArray(levels)) return [];
  return levels.slice(0, count).map((l) => ({
    price: Number(Number(l.price).toFixed(4)),
    size: Number(Number(l.size).toFixed(2))
  }));
}

function summarizeBook(book, outcomeLabel) {
  if (!book) return `${outcomeLabel}: order book unavailable`;
  const { bestBid, bestAsk, bids, asks } = book;
  const { spread, spreadPct } = formatSpread(bestBid, bestAsk);
  const mid = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null;
  const bidDepth = mid ? computeDepth2Pct(bids, mid, "bid") : 0;
  const askDepth = mid ? computeDepth2Pct(asks, mid, "ask") : 0;
  const topBids = topLevels(bids, 5);
  const topAsks = topLevels(asks, 5);

  const lines = [
    `[${outcomeLabel}]`,
    `  best_bid=${bestBid ?? "n/a"} best_ask=${bestAsk ?? "n/a"} spread=${spread ?? "n/a"} spread_pct=${spreadPct != null ? (spreadPct * 100).toFixed(2) + "%" : "n/a"}`,
    `  depth_2pct: bid_size=${bidDepth} ask_size=${askDepth}`,
    `  top_bids: ${topBids.map((l) => `${l.price}@${l.size}`).join(", ") || "none"}`,
    `  top_asks: ${topAsks.map((l) => `${l.price}@${l.size}`).join(", ") || "none"}`
  ];
  return lines.join("\n");
}

export class OrderBookEvidenceAdapter {
  constructor(config = {}) {
    this.id = "orderbook-depth";
    this.enabled = config.evidence?.orderbookDepth !== false;
    this.polymarketHost = config.polymarketHost || "https://clob.polymarket.com";
    this.timeoutMs = config.evidence?.orderbookTimeoutMs ?? 10000;
    this.depthLevels = config.evidence?.orderbookDepthLevels ?? 5;
  }

  async search({ market }) {
    if (!this.enabled) return [];
    const outcomes = market.outcomes ?? [];
    const hasTokens = outcomes.some((o) => o.clobTokenId);
    if (!hasTokens) return [];
    return [{
      source: this.id,
      sourceUrl: `polypulse://orderbook/${market.marketId}`,
      title: "Order book depth and spread"
    }];
  }

  async fetch(ref, { market, signal }) {
    const outcomes = market.outcomes ?? [];
    const tokensToFetch = outcomes.filter((o) => o.clobTokenId);
    if (tokensToFetch.length === 0) {
      return this.failedEvidence(ref, "no CLOB token IDs available");
    }

    const bookResults = [];
    for (const outcome of tokensToFetch) {
      const book = await this.fetchBook(outcome.clobTokenId, signal);
      bookResults.push({ outcome, book });
    }

    const summaryParts = bookResults.map(({ outcome, book }) =>
      summarizeBook(book, outcome.label ?? outcome.clobTokenId)
    );

    const allFailed = bookResults.every(({ book }) => book === null);
    if (allFailed) {
      return this.failedEvidence(ref, "all outcome order books unavailable");
    }

    const metadata = {};
    for (const { outcome, book } of bookResults) {
      if (book) {
        const { spread, spreadPct } = formatSpread(book.bestBid, book.bestAsk);
        metadata[outcome.label ?? outcome.clobTokenId] = {
          bestBid: book.bestBid,
          bestAsk: book.bestAsk,
          spread,
          spreadPct,
          bidLevels: (book.bids ?? []).length,
          askLevels: (book.asks ?? []).length
        };
      }
    }

    return {
      source: this.id,
      sourceUrl: ref.sourceUrl,
      title: ref.title,
      summary: summaryParts.join("\n\n"),
      status: "fetched",
      credibility: "high",
      relevanceScore: 0.8,
      metadata
    };
  }

  async fetchBook(tokenId, signal) {
    const url = `${this.polymarketHost.replace(/\/+$/, "")}/book?token_id=${encodeURIComponent(tokenId)}`;
    try {
      const controller = new AbortController();
      if (signal) {
        signal.addEventListener("abort", () => controller.abort(), { once: true });
      }
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      let payload;
      try {
        const response = await globalThis.fetch(url, {
          signal: controller.signal,
          headers: { "user-agent": "PolyPulse/0.1 orderbook-evidence" }
        });
        if (!response.ok) return null;
        payload = await response.json();
      } finally {
        clearTimeout(timeout);
      }

      const bids = Array.isArray(payload?.bids) ? payload.bids : [];
      const asks = Array.isArray(payload?.asks) ? payload.asks : [];
      const sortedBids = [...bids].sort((a, b) => Number(b.price) - Number(a.price));
      const sortedAsks = [...asks].sort((a, b) => Number(a.price) - Number(b.price));
      const bestBid = sortedBids.length > 0 ? Number(sortedBids[0].price) : null;
      const bestAsk = sortedAsks.length > 0 ? Number(sortedAsks[0].price) : null;

      return {
        tokenId,
        bestBid: Number.isFinite(bestBid) ? bestBid : null,
        bestAsk: Number.isFinite(bestAsk) ? bestAsk : null,
        bids: sortedBids,
        asks: sortedAsks
      };
    } catch {
      return null;
    }
  }

  failedEvidence(ref, reason) {
    return {
      source: this.id,
      sourceUrl: ref.sourceUrl,
      title: ref.title ?? "Order book depth fetch failed",
      summary: `Order book evidence unavailable. ${reason}`,
      status: "failed",
      credibility: "low",
      relevanceScore: 0
    };
  }
}
