import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvConfig, validateEnvConfig } from "../src/config/env.js";
import { FileStateStore } from "../src/state/file-state-store.js";
import { ArtifactWriter } from "../src/artifacts/artifact-writer.js";
import { runTradeOnce } from "../src/flows/once-runner.js";
import { Scheduler } from "../src/scheduler/scheduler.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "bin", "polypulse.js");

function execCli(args, options = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [cliPath, ...args], { cwd: repoRoot, ...options }, (error, stdout, stderr) => {
      resolve({ error, stdout, stderr, status: error?.code ?? 0 });
    });
  });
}

function liveEnvLines({ stateDir, artifactDir, walletMode = "simulated" }) {
  return [
    "POLYPULSE_EXECUTION_MODE=live",
    "POLYPULSE_LIVE_CONFIRM=LIVE",
    `POLYPULSE_LIVE_WALLET_MODE=${walletMode}`,
    "SIMULATED_WALLET_BALANCE_USD=100",
    "POLYPULSE_MARKET_SOURCE=polymarket",
    "POLYMARKET_GAMMA_HOST=https://gamma-api.polymarket.com",
    "CHAIN_ID=137",
    "POLYMARKET_HOST=https://clob.polymarket.com",
    "AI_PROVIDER=codex",
    "AGENT_RUNTIME_PROVIDER=codex",
    `STATE_DIR=${stateDir}`,
    `ARTIFACT_DIR=${artifactDir}`
  ];
}

async function createConfig(overrides = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "polypulse-live-only-"));
  const stateDir = path.join(dir, "state");
  const artifactDir = path.join(dir, "artifacts");
  const envPath = path.join(dir, "live.env");
  await writeFile(envPath, liveEnvLines({ stateDir, artifactDir }).join("\n"), "utf8");
  const config = await loadEnvConfig({
    envFile: envPath,
    overrides
  });
  return { config, envPath, stateDir, artifactDir };
}

function sampleMarket() {
  return {
    marketId: "polymarket-sample-1",
    eventId: "polymarket-event-1",
    marketSlug: "polymarket-sample-1",
    eventSlug: "polymarket-event-1",
    question: "Will this Polymarket sample resolve to Yes?",
    title: "Polymarket sample",
    marketUrl: "https://polymarket.com/event/polymarket-event-1/polymarket-sample-1",
    outcomes: [
      { id: "yes", label: "Yes", tokenId: "token-yes", bestAsk: 0.4, bestBid: 0.39, lastPrice: 0.4, impliedProbability: 0.4 },
      { id: "no", label: "No", tokenId: "token-no", bestAsk: 0.61, bestBid: 0.6, lastPrice: 0.6, impliedProbability: 0.6 }
    ],
    endDate: new Date(Date.now() + 45 * 86_400_000).toISOString(),
    resolutionRules: "Resolves according to the linked Polymarket market rules.",
    resolutionSourceUrl: "https://polymarket.com",
    liquidityUsd: 25000,
    volumeUsd: 100000,
    volume24hUsd: 5000,
    category: "politics",
    tags: ["polymarket"],
    active: true,
    closed: false,
    tradable: true,
    source: "polymarket-gamma",
    riskFlags: [],
    fetchedAt: new Date().toISOString()
  };
}

function sampleEvidence(market) {
  const now = new Date().toISOString();
  return [
    {
      evidenceId: "evidence-1",
      marketId: market.marketId,
      source: "public-source",
      sourceUrl: "https://example.com/source-1",
      url: "https://example.com/source-1",
      title: "Relevant public source",
      summary: "Current public evidence supports the Yes outcome.",
      status: "fetched",
      credibility: "high",
      retrievedAt: now,
      timestamp: now,
      relevanceScore: 0.9,
      relevance_score: 0.9
    },
    {
      evidenceId: "evidence-2",
      marketId: market.marketId,
      source: "public-source",
      sourceUrl: "https://example.com/source-2",
      url: "https://example.com/source-2",
      title: "Additional public source",
      summary: "Recent information is consistent with the primary source.",
      status: "fetched",
      credibility: "medium",
      retrievedAt: now,
      timestamp: now,
      relevanceScore: 0.75,
      relevance_score: 0.75
    }
  ];
}

class SampleMarketSource {
  constructor(market) {
    this.market = market;
  }

  async getMarket() {
    return this.market;
  }

  async scan({ limit = 1 } = {}) {
    return {
      source: "polymarket-gamma",
      fetchedAt: new Date().toISOString(),
      fromCache: false,
      fallback: false,
      totalFetched: 1,
      totalNormalized: 1,
      filteredOut: 0,
      totalReturned: Math.min(1, limit),
      cursor: null,
      filters: {},
      pulse: null,
      paging: null,
      markets: [this.market].slice(0, limit),
      riskFlags: [],
      errors: []
    };
  }
}

class StaticEvidenceCrawler {
  constructor(items) {
    this.items = items;
  }

  async collect() {
    return this.items;
  }
}

class StaticProbabilityProvider {
  async estimate({ evidence }) {
    return {
      ai_probability: 0.7,
      confidence: "high",
      reasoning_summary: "The configured AI provider result is represented by this controlled test provider.",
      key_evidence: evidence,
      counter_evidence: [],
      uncertainty_factors: [],
      freshness_score: 0.9
    };
  }
}

class ControlledLiveBroker {
  constructor() {
    this.orders = [];
  }

  async getBalance() {
    return {
      collateralBalance: 100,
      allowance: 100,
      source: "simulated-live-wallet",
      raw: { source: "simulated-live-wallet" }
    };
  }

  async submit(order, market, confirmation) {
    assert.equal(confirmation, "LIVE");
    const result = {
      orderId: `controlled-${this.orders.length + 1}`,
      status: "filled",
      mode: "live",
      requestedUsd: order.amountUsd,
      filledUsd: order.amountUsd,
      avgPrice: market.outcomes[0].bestAsk,
      reason: null
    };
    this.orders.push(result);
    return result;
  }
}

test("live simulated env passes and non-polymarket market source fails validation", async () => {
  const { config } = await createConfig();
  const report = validateEnvConfig(config, { mode: "live" });
  assert.equal(report.ok, true);
  assert.equal(report.mode, "live");
  assert.equal(config.marketSource, "polymarket");

  const invalid = await loadEnvConfig({
    envFile: config.envFilePath,
    overrides: { POLYPULSE_MARKET_SOURCE: "synthetic" }
  });
  const invalidReport = validateEnvConfig(invalid, { mode: "live" });
  assert.equal(invalidReport.ok, false);
  assert.ok(invalidReport.checks.some((item) => item.key === "market-source" && !item.ok));
});

test("CLI rejects removed source override", async () => {
  const { envPath } = await createConfig();
  const result = await execCli(["market", "topics", "--source", "synthetic", "--env-file", envPath], {
    env: { ...process.env }
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr || result.stdout, /unsupported_option/);
});

test("live simulated trade once uses live broker and writes artifacts", async () => {
  const { config } = await createConfig();
  const market = sampleMarket();
  const evidence = sampleEvidence(market);
  const stateStore = new FileStateStore(config);
  const artifactWriter = new ArtifactWriter(config);
  const liveBroker = new ControlledLiveBroker();
  const result = await runTradeOnce({
    context: {
      config,
      stateStore,
      artifactWriter,
      marketSource: new SampleMarketSource(market)
    },
    marketId: market.marketId,
    mode: "live",
    maxAmountUsd: 1,
    confirmation: "LIVE",
    options: {
      evidenceCrawler: new StaticEvidenceCrawler(evidence),
      probabilityEstimator: { estimate: async ({ market: currentMarket, evidence: currentEvidence }) => {
        const provider = new StaticProbabilityProvider();
        const { ProbabilityEstimator } = await import("../src/core/probability-estimator.js");
        return await new ProbabilityEstimator(config, { provider }).estimate({ market: currentMarket, evidence: currentEvidence });
      } },
      liveBroker
    }
  });

  assert.equal(result.mode, "live");
  assert.equal(result.action, "live-order");
  assert.equal(result.orderResult.status, "filled");
  assert.equal(liveBroker.orders.length, 1);
  assert.match(result.artifact, /once/);
});

test("live monitor round can evaluate and execute one controlled live order", async () => {
  const { config } = await createConfig({
    MONITOR_MAX_TRADES_PER_ROUND: "1",
    MONITOR_MAX_DAILY_TRADE_USD: "5"
  });
  const market = sampleMarket();
  const evidence = sampleEvidence(market);
  const stateStore = new FileStateStore(config);
  const artifactWriter = new ArtifactWriter(config);
  const liveBroker = new ControlledLiveBroker();
  const { ProbabilityEstimator } = await import("../src/core/probability-estimator.js");
  const scheduler = new Scheduler({
    config,
    stateStore,
    artifactWriter,
    marketSource: new SampleMarketSource(market)
  }, {
    evidenceCrawler: new StaticEvidenceCrawler(evidence),
    probabilityEstimator: new ProbabilityEstimator(config, { provider: new StaticProbabilityProvider() }),
    liveBroker
  });

  const result = await scheduler.monitorRun({ mode: "live", confirmation: "LIVE", limit: 1, maxAmountUsd: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "live");
  assert.equal(result.orders, 1);
  assert.equal(result.action, "live-orders");
  assert.equal(liveBroker.orders.length, 1);
});
