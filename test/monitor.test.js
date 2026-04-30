import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Scheduler } from "../src/scheduler/scheduler.js";
import { FileStateStore } from "../src/state/file-state-store.js";
import { ArtifactWriter } from "../src/artifacts/artifact-writer.js";
import { MockMarketSource } from "../src/adapters/mock-market-source.js";
import { LiveBroker } from "../src/brokers/live-broker.js";

async function tempConfig(overrides = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "polypulse-monitor-"));
  const { risk = {}, monitor = {}, scan = {}, evidence = {}, artifacts = {}, ...rest } = overrides;
  return {
    executionMode: "paper",
    envFilePath: null,
    privateKey: "",
    funderAddress: "",
    signatureType: "",
    chainId: 137,
    polymarketHost: "",
    marketSource: "mock",
    polymarketGammaHost: "https://gamma-api.polymarket.com",
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
      minTradeUsd: 1,
      ...risk
    },
    scan: {
      marketScanLimit: 1000,
      pageSize: 100,
      maxPages: 20,
      cacheTtlSeconds: 300,
      requestTimeoutMs: 10000,
      requestRetries: 2,
      rateLimitMs: 0,
      minFetchedMarkets: 20,
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
      blocklist: [],
      ...monitor
    },
    artifacts: {
      retentionDays: 14,
      maxRuns: 500,
      ...artifacts
    },
    evidence: {
      cacheTtlSeconds: 1800,
      requestTimeoutMs: 10000,
      requestRetries: 1,
      minEvidenceItems: 2,
      ...evidence
    },
    ai: { provider: "local", model: "", command: "" },
    ...rest
  };
}

function contextFor(config) {
  const stateStore = new FileStateStore(config);
  return {
    config,
    stateStore,
    artifactWriter: new ArtifactWriter(config),
    marketSource: new MockMarketSource(config, stateStore)
  };
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.resolve(relativePath), "utf8"));
}

async function assertMonitorArtifacts(artifactPath) {
  assert.match(artifactPath, /monitor\/\d{4}-\d{2}-\d{2}\/.+\/summary\.md$/);
  const dir = path.dirname(path.resolve(artifactPath));
  const required = ["markets.json", "candidates.json", "decisions.json", "risk.json", "orders.json", "summary.md"];
  for (const filename of required) {
    await access(path.join(dir, filename));
  }
  await access(path.join(dir, "predictions"));
  const summary = await readFile(path.join(dir, "summary.md"), "utf8");
  assert.match(summary, /PolyPulse Monitor Run/);
  return dir;
}

test("paper monitor runs one round and writes complete artifacts", async () => {
  const config = await tempConfig();
  const context = contextFor(config);
  const result = await new Scheduler(context).monitorRun({ mode: "paper", limit: 2, maxAmountUsd: 1 });

  assert.equal(result.ok, true);
  assert.equal(result.status, "completed");
  assert.equal(result.orders, 1);
  const dir = await assertMonitorArtifacts(result.artifact);
  const orders = await readJson(path.join(dir, "orders.json"));
  assert.equal(orders.filter((order) => order.status === "filled").length, 1);
  const monitorState = await context.stateStore.getMonitorState();
  assert.equal(monitorState.dailyTradeUsd.trades, 1);
});

test("paper monitor avoids repeated orders for the same market across rounds", async () => {
  const config = await tempConfig();
  const context = contextFor(config);
  const scheduler = new Scheduler(context);

  const first = await scheduler.monitorRun({ mode: "paper", limit: 1, maxAmountUsd: 1 });
  const second = await scheduler.monitorRun({ mode: "paper", limit: 1, maxAmountUsd: 1 });

  assert.equal(first.orders, 1);
  assert.equal(second.orders, 0);
  const monitorState = await context.stateStore.getMonitorState();
  assert.ok(monitorState.tradedMarkets["market:market-001"]);
  assert.ok(monitorState.tradedMarkets["event:event-001"]);
});

test("live monitor without explicit confirmation is rejected before broker execution", async () => {
  const config = await tempConfig({
    executionMode: "live",
    envFilePath: "/tmp/polypulse-live.env",
    privateKey: "test-placeholder-not-secret",
    funderAddress: "0x5555555555555555555555555555555555555555",
    signatureType: "1",
    polymarketHost: "https://clob.polymarket.com"
  });
  const context = contextFor(config);
  const result = await new Scheduler(context).monitorRun({ mode: "live", limit: 1, maxAmountUsd: 1 });

  assert.equal(result.ok, true);
  assert.equal(result.orders, 0);
  const dir = await assertMonitorArtifacts(result.artifact);
  const risks = await readJson(path.join(dir, "risk.json"));
  assert.ok(risks[0].blocked_reasons.includes("live_requires_confirm_live"));
});

test("live monitor can execute through a mock broker after confirm", async () => {
  const config = await tempConfig({
    executionMode: "live",
    envFilePath: "/tmp/polypulse-live.env",
    privateKey: "test-placeholder-not-secret",
    funderAddress: "0x6666666666666666666666666666666666666666",
    signatureType: "1",
    polymarketHost: "https://clob.polymarket.com"
  });
  const liveBroker = new LiveBroker(config, {
    client: {
      preflight: async () => ({ ok: true, source: "mock" }),
      getCollateralBalance: async () => ({ collateralBalance: 100, allowance: 100, raw: {} }),
      postMarketOrder: async () => ({ ok: true, orderId: "mock-monitor-live-order", filledUsd: 1, avgPrice: 0.43, raw: { ok: true } })
    }
  });
  const context = contextFor(config);
  const result = await new Scheduler(context, { liveBroker }).monitorRun({
    mode: "live",
    confirmation: "LIVE",
    limit: 1,
    maxAmountUsd: 1
  });

  assert.equal(result.action, "live-orders");
  assert.equal(result.orders, 1);
  const dir = await assertMonitorArtifacts(result.artifact);
  const orders = await readJson(path.join(dir, "orders.json"));
  assert.equal(orders[0].orderId, "mock-monitor-live-order");
});

test("monitor recovers a stale in-flight run before starting a new round", async () => {
  const config = await tempConfig();
  const context = contextFor(config);
  await context.stateStore.startMonitorRun({ runId: "stale-run", mode: "paper" });

  const result = await new Scheduler(context).monitorRun({ mode: "paper", limit: 1, maxAmountUsd: 1 });

  assert.equal(result.ok, true);
  const monitorState = await context.stateStore.getMonitorState();
  assert.equal(monitorState.runHistory.some((run) => run.runId === "stale-run" && run.status === "recovered_after_crash"), true);
});

test("monitor prediction work respects configured concurrency", async () => {
  const config = await tempConfig({
    monitor: { maxTradesPerRound: 0, concurrency: 2, backoffMs: 0 }
  });
  const context = contextFor(config);
  let active = 0;
  let maxActive = 0;
  const evidenceCrawler = {
    async collect({ market }) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(25);
      active -= 1;
      return [
        {
          evidenceId: `${market.marketId}-a`,
          marketId: market.marketId,
          source: "test",
          sourceUrl: `test://${market.marketId}/a`,
          url: `test://${market.marketId}/a`,
          title: "Official signal",
          summary: "Official evidence says the event will proceed.",
          status: "fetched",
          credibility: "high",
          retrievedAt: new Date().toISOString(),
          timestamp: new Date().toISOString(),
          relevanceScore: 0.9,
          relevance_score: 0.9
        },
        {
          evidenceId: `${market.marketId}-b`,
          marketId: market.marketId,
          source: "test",
          sourceUrl: `test://${market.marketId}/b`,
          url: `test://${market.marketId}/b`,
          title: "Resolution evidence",
          summary: "Resolution source is available.",
          status: "fetched",
          credibility: "medium",
          retrievedAt: new Date().toISOString(),
          timestamp: new Date().toISOString(),
          relevanceScore: 0.7,
          relevance_score: 0.7
        }
      ];
    }
  };

  const result = await new Scheduler(context, { evidenceCrawler }).monitorRun({ mode: "paper", limit: 3, maxAmountUsd: 1 });

  assert.equal(result.predictions, 3);
  assert.ok(maxActive <= 2);
});

test("monitor stop and resume state gates new rounds", async () => {
  const config = await tempConfig();
  const context = contextFor(config);
  const scheduler = new Scheduler(context);

  await context.stateStore.stopMonitor("test_stop");
  const stopped = await scheduler.monitorRun({ mode: "paper", limit: 1, maxAmountUsd: 1 });
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.artifact, null);

  await context.stateStore.resumeMonitor();
  const resumed = await scheduler.monitorRun({ mode: "paper", limit: 1, maxAmountUsd: 1 });
  assert.equal(resumed.status, "completed");
});

test("monitor watchlist and blocklist filter candidates before prediction", async () => {
  const config = await tempConfig({
    monitor: {
      watchlist: ["economics"],
      blocklist: ["fed-cut-before-july"]
    }
  });
  const context = contextFor(config);
  const result = await new Scheduler(context).monitorRun({ mode: "paper", limit: 3, maxAmountUsd: 1 });

  assert.equal(result.candidates, 0);
  assert.equal(result.predictions, 0);
  const dir = await assertMonitorArtifacts(result.artifact);
  const candidates = await readJson(path.join(dir, "candidates.json"));
  assert.equal(candidates.every((item) => item.selected === false), true);
});
