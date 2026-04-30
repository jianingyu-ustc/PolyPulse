import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PolymarketMarketSource } from "../src/adapters/polymarket-market-source.js";
import { applyMarketFilters } from "../src/adapters/market-filters.js";
import { normalizePolymarketMarket } from "../src/adapters/market-normalizer.js";
import { validateSchema } from "../src/domain/schemas.js";

function rawMarket(index, overrides = {}) {
  return {
    id: `market-${index}`,
    slug: `market-${index}-slug`,
    event_slug: `event-${index}-slug`,
    question: `Will test market ${index} resolve yes?`,
    outcomes: JSON.stringify(["Yes", "No"]),
    outcome_prices: JSON.stringify([0.4 + index / 100, 0.6 - index / 100]),
    clob_token_ids: JSON.stringify([`token-${index}-yes`, `token-${index}-no`]),
    liquidity: 1000 * index,
    volume: 5000 * index,
    volume_24hr: 100 * index,
    end_date: "2026-12-31T00:00:00Z",
    category_slug: index % 2 === 0 ? "sports" : "politics",
    tags: [{ slug: index % 2 === 0 ? "nba" : "election" }],
    active: true,
    closed: false,
    description: "Resolves from a public test source.",
    ...overrides
  };
}

function testConfig(host, dir, overrides = {}) {
  return {
    executionMode: "paper",
    privateKey: "",
    funderAddress: "",
    signatureType: "",
    chainId: 137,
    polymarketHost: "",
    marketSource: "polymarket",
    polymarketGammaHost: host,
    stateDir: path.join(dir, "state"),
    artifactDir: path.join(dir, "artifacts"),
    risk: {
      maxTradePct: 0.05,
      maxTotalExposurePct: 0.5,
      maxEventExposurePct: 0.2,
      maxPositionCount: 20,
      maxPositionLossPct: 0.5,
      drawdownHaltPct: 0.2,
      liquidityTradeCapPct: 0.01,
      marketMaxAgeSeconds: 600,
      minAiConfidence: "medium",
      minTradeUsd: 1
    },
    scan: {
      marketScanLimit: 1000,
      pageSize: 2,
      maxPages: 4,
      cacheTtlSeconds: 300,
      requestTimeoutMs: 2000,
      requestRetries: 0,
      rateLimitMs: 0,
      minFetchedMarkets: 3,
      ...(overrides.scan ?? {})
    },
    monitor: { intervalSeconds: 300 },
    ai: { provider: "local", model: "", command: "" }
  };
}

function mockFetch(handler) {
  const requests = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(String(url));
    requests.push(`${parsed.pathname}${parsed.search}`);
    const result = handler(parsed);
    return {
      ok: result.status == null || result.status < 400,
      status: result.status ?? 200,
      json: async () => result.body
    };
  };
  return { requests, fetchImpl };
}

test("PolymarketMarketSource paginates mock API, normalizes schema, and caches", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "polypulse-market-source-"));
  const { requests, fetchImpl } = mockFetch((url) => {
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const rows = [rawMarket(1), rawMarket(2), rawMarket(3), rawMarket(4)].slice(offset, offset + 2);
    return { body: rows };
  });
  const source = new PolymarketMarketSource(testConfig("https://mock.polymarket.local", dir), null, { fetchImpl });
  const scan = await source.scan({ limit: 3, minLiquidityUsd: 1000 });

  assert.equal(scan.source, "polymarket-gamma");
  assert.equal(scan.markets.length, 3);
  assert.equal(requests.length, 2);
  assert.equal(scan.markets.every((market) => validateSchema("Market", market).ok), true);
  assert.equal(scan.markets[0].outcomes[0].tokenId, "token-1-yes");
  assert.equal(Number(scan.markets[0].outcomes[0].impliedProbability.toFixed(2)), 0.41);

  const cached = await source.scan({ limit: 3, minLiquidityUsd: 1000 });
  assert.equal(cached.fromCache, true);
  assert.equal(cached.source, "polymarket-gamma-cache");
  assert.equal(requests.length, 2);
});

test("market filters support liquidity, volume, category, end date, and tradable", () => {
  const markets = [
    normalizePolymarketMarket(rawMarket(1, { category_slug: "politics", liquidity: 900, volume: 3000 })),
    normalizePolymarketMarket(rawMarket(2, { category_slug: "sports", liquidity: 5000, volume: 9000 })),
    normalizePolymarketMarket(rawMarket(3, { category_slug: "sports", liquidity: 6000, volume: 100, closed: true }))
  ];

  const filtered = applyMarketFilters(markets, {
    minLiquidityUsd: 1000,
    minVolumeUsd: 1000,
    categoryKeyword: "sports",
    endsBefore: "2027-01-01T00:00:00Z",
    tradableOnly: true
  });

  assert.deepEqual(filtered.map((market) => market.marketId), ["market-2"]);
});

test("PolymarketMarketSource marks insufficient scan results with risk flags", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "polypulse-market-source-empty-"));
  const { fetchImpl } = mockFetch(() => ({ body: [] }));
  const source = new PolymarketMarketSource(testConfig("https://mock.polymarket.local", dir), null, { fetchImpl });
  const scan = await source.scan({ limit: 20 });
  assert.deepEqual(scan.markets, []);
  assert.ok(scan.riskFlags.includes("market_scan_empty"));
  assert.ok(scan.riskFlags.includes("market_scan_result_below_minimum"));
});

test("PolymarketMarketSource falls back to stale cache with explicit risk flag", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "polypulse-market-source-stale-"));
  const host = "https://mock.polymarket.local";
  const first = mockFetch(() => ({ body: [rawMarket(1), rawMarket(2)] }));
  const warmSource = new PolymarketMarketSource(testConfig(host, dir), null, { fetchImpl: first.fetchImpl });
  const warm = await warmSource.scan({ limit: 2 });
  assert.equal(warm.markets.length, 2);

  const failing = mockFetch(() => ({ status: 500, body: { error: "down" } }));
  const staleSource = new PolymarketMarketSource(
    testConfig(host, dir, { scan: { cacheTtlSeconds: 0, requestRetries: 0 } }),
    null,
    { fetchImpl: failing.fetchImpl }
  );
  const stale = await staleSource.scan({ limit: 2 });

  assert.equal(stale.fallback, true);
  assert.equal(stale.fromCache, true);
  assert.equal(stale.markets.length, 2);
  assert.ok(stale.riskFlags.includes("stale_market_cache_used"));
});

test("low-liquidity markets are filtered and marked as empty when none remain", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "polypulse-market-source-liquidity-"));
  const { fetchImpl } = mockFetch(() => ({ body: [rawMarket(1, { liquidity: 10 })] }));
  const source = new PolymarketMarketSource(testConfig("https://mock.polymarket.local", dir), null, { fetchImpl });
  const scan = await source.scan({ limit: 1, minLiquidityUsd: 1000 });

  assert.equal(scan.totalFetched, 1);
  assert.equal(scan.markets.length, 0);
  assert.ok(scan.riskFlags.includes("market_scan_empty"));
});
