import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { PolymarketMarketSource } from "../src/adapters/polymarket-market-source.js";
import { EvidenceCrawler } from "../src/adapters/evidence-crawler.js";
import { ArtifactWriter } from "../src/artifacts/artifact-writer.js";
import { SAMPLE_MARKETS } from "../src/adapters/mock-market-source.js";

function rawMarket(index) {
  return {
    id: `large-market-${index}`,
    slug: `large-market-${index}`,
    event_slug: `large-event-${index}`,
    question: `Will large mock market ${index} resolve yes?`,
    outcomes: JSON.stringify(["Yes", "No"]),
    outcome_prices: JSON.stringify([0.45, 0.55]),
    clob_token_ids: JSON.stringify([`large-token-${index}-yes`, `large-token-${index}-no`]),
    liquidity: 10000 + index,
    volume: 50000 + index,
    volume_24hr: 1000 + index,
    end_date: "2026-12-31T00:00:00Z",
    category_slug: index % 2 === 0 ? "sports" : "politics",
    active: true,
    closed: false,
    description: "Large mock market for scan performance."
  };
}

function config(host, dir, overrides = {}) {
  const { scan = {}, artifacts = {}, ...rest } = overrides;
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
      marketScanLimit: 5000,
      pageSize: 500,
      maxPages: 20,
      cacheTtlSeconds: 0,
      requestTimeoutMs: 1000,
      requestRetries: 0,
      rateLimitMs: 0,
      minFetchedMarkets: 0,
      ...scan
    },
    monitor: {
      intervalSeconds: 1,
      maxTradesPerRound: 1,
      maxDailyTradeUsd: 10,
      concurrency: 2,
      runTimeoutMs: 10000,
      backoffMs: 0,
      watchlist: [],
      blocklist: []
    },
    artifacts: {
      retentionDays: 14,
      maxRuns: 500,
      ...artifacts
    },
    evidence: {
      cacheTtlSeconds: 0,
      requestTimeoutMs: 10,
      requestRetries: 0,
      minEvidenceItems: 2
    },
    ai: { provider: "local", model: "", command: "" },
    ...rest
  };
}

function mockFetch(handler) {
  const requests = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(String(url));
    requests.push(`${parsed.pathname}${parsed.search}`);
    const result = await handler(parsed);
    return {
      ok: result.status == null || result.status < 400,
      status: result.status ?? 200,
      json: async () => result.body
    };
  };
  return { requests, fetchImpl };
}

test("large mock market scan paginates thousands of markets without truncating the requested limit", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "polypulse-large-scan-"));
  const total = 5000;
  const { requests, fetchImpl } = mockFetch((url) => {
    const limit = Number(url.searchParams.get("limit"));
    const offset = Number(url.searchParams.get("offset"));
    const rows = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, index) => rawMarket(offset + index));
    return { body: rows };
  });
  const source = new PolymarketMarketSource(config("https://mock.polymarket.local", dir), null, { fetchImpl });
  const scan = await source.scan({ limit: total });

  assert.equal(scan.markets.length, total);
  assert.equal(requests.length, 10);
  assert.equal(scan.riskFlags.includes("market_scan_empty"), false);
});

test("market source retries retryable failures before succeeding", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "polypulse-retry-"));
  let calls = 0;
  const { fetchImpl } = mockFetch(() => {
    calls += 1;
    if (calls === 1) {
      return { status: 500, body: { error: "temporary" } };
    }
    return { body: [rawMarket(1)] };
  });
  const source = new PolymarketMarketSource(
    config("https://mock.polymarket.local", dir, { scan: { requestRetries: 1 } }),
    null,
    { fetchImpl }
  );
  const scan = await source.scan({ limit: 1 });

  assert.equal(calls, 2);
  assert.equal(scan.markets.length, 1);
});

test("EvidenceCrawler timeouts produce explicit failed evidence instead of hanging", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "polypulse-evidence-timeout-"));
  const crawler = new EvidenceCrawler(config("https://mock.polymarket.local", dir), {
    adapters: [{
      id: "slow-source",
      search: async () => [{ sourceUrl: "polypulse://slow", title: "Slow source" }],
      fetch: async () => {
        await sleep(1000);
        return { title: "too late" };
      }
    }]
  });
  const evidence = await crawler.collect({ market: SAMPLE_MARKETS[0] });

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].status, "failed");
  assert.match(evidence[0].summary, /timed out/);
});

test("monitor artifact cleanup keeps only the configured number of runs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "polypulse-artifact-cleanup-"));
  const cfg = config("https://mock.polymarket.local", dir, { artifacts: { maxRuns: 1, retentionDays: 0 } });
  const writer = new ArtifactWriter(cfg);
  const payload = {
    mode: "paper",
    startedAt: "2026-04-30T00:00:00.000Z",
    completedAt: "2026-04-30T00:00:00.000Z",
    scan: { source: "mock", fetchedAt: "2026-04-30T00:00:00.000Z", markets: [], errors: [] },
    candidates: [],
    predictions: [],
    decisions: [],
    risks: [],
    orders: [],
    errors: []
  };
  const first = await writer.writeMonitorRun({ ...payload, runId: "old-run" });
  await sleep(10);
  const second = await writer.writeMonitorRun({ ...payload, runId: "new-run" });
  const dayDir = path.dirname(path.resolve(second.dir));
  const remaining = await readdir(dayDir);

  await assert.rejects(() => access(path.resolve(first.dir)));
  assert.equal(remaining.length, 1);
  assert.equal(path.basename(path.resolve(second.dir)), "new-run");
});
