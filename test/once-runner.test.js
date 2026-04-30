import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runTradeOnce } from "../src/flows/once-runner.js";
import { FileStateStore } from "../src/state/file-state-store.js";
import { ArtifactWriter } from "../src/artifacts/artifact-writer.js";
import { MockMarketSource } from "../src/adapters/mock-market-source.js";
import { LiveBroker } from "../src/brokers/live-broker.js";

async function tempConfig(overrides = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "polypulse-once-"));
  const { risk = {}, ...rest } = overrides;
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
      rateLimitMs: 250,
      minFetchedMarkets: 20
    },
    monitor: { intervalSeconds: 300 },
    evidence: {
      cacheTtlSeconds: 1800,
      requestTimeoutMs: 10000,
      requestRetries: 1,
      minEvidenceItems: 2
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

async function assertOnceArtifacts(artifacts) {
  const expected = ["input", "market", "evidence", "estimate", "decision", "risk", "order", "summary"];
  for (const key of expected) {
    await access(path.resolve(artifacts[key].path));
  }
  const summary = await readFile(path.resolve(artifacts.summary.path), "utf8");
  assert.match(summary, /PolyPulse One-Shot Run/);
}

test("paper one-shot succeeds and writes complete run artifacts", async () => {
  const config = await tempConfig();
  const result = await runTradeOnce({
    context: contextFor(config),
    marketId: "market-001",
    mode: "paper",
    maxAmountUsd: 1
  });

  assert.equal(result.action, "paper-order");
  assert.equal(result.orderResult.status, "filled");
  assert.match(result.artifact, /runs\/.+-once\/summary\.md$/);
  await assertOnceArtifacts(result.artifacts);
});

test("one-shot no-trades when risk rejects below minimum amount", async () => {
  const config = await tempConfig();
  const result = await runTradeOnce({
    context: contextFor(config),
    marketId: "market-001",
    mode: "paper",
    maxAmountUsd: 0.5
  });

  assert.equal(result.action, "no-trade");
  assert.equal(result.risk.allowed, false);
  assert.ok(result.risk.blocked_reasons.includes("below_min_trade_usd"));
});

test("live one-shot rejects missing confirmation", async () => {
  const config = await tempConfig({
    executionMode: "live",
    envFilePath: "/tmp/polypulse-live.env",
    privateKey: "in-memory-test-secret",
    funderAddress: "0x5555555555555555555555555555555555555555",
    signatureType: "1",
    polymarketHost: "https://clob.polymarket.com"
  });
  const result = await runTradeOnce({
    context: contextFor(config),
    marketId: "market-001",
    mode: "live",
    maxAmountUsd: 1
  });

  assert.equal(result.action, "no-trade");
  assert.ok(result.risk.blocked_reasons.includes("live_requires_confirm_live"));
});

test("live one-shot can execute through mock broker after confirm", async () => {
  const config = await tempConfig({
    executionMode: "live",
    envFilePath: "/tmp/polypulse-live.env",
    privateKey: "in-memory-test-secret",
    funderAddress: "0x6666666666666666666666666666666666666666",
    signatureType: "1",
    polymarketHost: "https://clob.polymarket.com"
  });
  const liveBroker = new LiveBroker(config, {
    client: {
      preflight: async () => ({ ok: true, source: "mock" }),
      getCollateralBalance: async () => ({ collateralBalance: 100, allowance: 100, raw: {} }),
      postMarketOrder: async () => ({ ok: true, orderId: "mock-live-order", filledUsd: 1, avgPrice: 0.43, raw: { ok: true } })
    }
  });

  const result = await runTradeOnce({
    context: contextFor(config),
    marketId: "market-001",
    mode: "live",
    maxAmountUsd: 1,
    confirmation: "LIVE",
    options: { liveBroker }
  });

  assert.equal(result.action, "live-order");
  assert.equal(result.orderResult.orderId, "mock-live-order");
  assert.equal(result.orderResult.status, "filled");
  await assertOnceArtifacts(result.artifacts);
});

test("live one-shot risk rejection does not call broker submit", async () => {
  const config = await tempConfig({
    executionMode: "live",
    envFilePath: "/tmp/polypulse-live.env",
    privateKey: "in-memory-test-secret",
    funderAddress: "0x7777777777777777777777777777777777777777",
    signatureType: "1",
    polymarketHost: "https://clob.polymarket.com"
  });
  let submitCalls = 0;
  const liveBroker = {
    async getBalance() {
      return { collateralBalance: 100, allowance: 100, raw: {}, source: "mock" };
    },
    async submit() {
      submitCalls += 1;
      throw new Error("submit should not be called");
    }
  };

  const result = await runTradeOnce({
    context: contextFor(config),
    marketId: "market-001",
    mode: "live",
    maxAmountUsd: 0.5,
    confirmation: "LIVE",
    options: { liveBroker }
  });

  assert.equal(result.action, "no-trade");
  assert.equal(submitCalls, 0);
  assert.ok(result.risk.blocked_reasons.includes("below_min_trade_usd"));
});
