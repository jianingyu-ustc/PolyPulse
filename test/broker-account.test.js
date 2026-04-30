import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvConfig, validateEnvConfig } from "../src/config/env.js";
import { FileStateStore } from "../src/state/file-state-store.js";
import { AccountService } from "../src/account/account-service.js";
import { PaperBroker } from "../src/brokers/paper-broker.js";
import { LiveBroker } from "../src/brokers/live-broker.js";
import { OrderExecutor } from "../src/execution/order-executor.js";
import { SAMPLE_MARKETS } from "../src/adapters/mock-market-source.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "bin", "polypulse.js");

async function tempConfig(overrides = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "polypulse-broker-"));
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
      minTradeUsd: 1
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
    ...overrides
  };
}

function order(side = "BUY") {
  return {
    orderId: `order-${side.toLowerCase()}`,
    mode: "paper",
    marketId: SAMPLE_MARKETS[0].marketId,
    tokenId: SAMPLE_MARKETS[0].outcomes[0].tokenId,
    side,
    amountUsd: 10
  };
}

test("live env preflight fails fast when required fields are missing", async () => {
  const config = await loadEnvConfig({ overrides: { POLYPULSE_EXECUTION_MODE: "live" } });
  const report = validateEnvConfig(config, { mode: "live" });
  assert.equal(report.ok, false);
  const failed = report.checks.filter((item) => !item.ok).map((item) => item.key);
  assert.ok(failed.includes("PRIVATE_KEY"));
  assert.ok(failed.includes("FUNDER_ADDRESS"));
  assert.ok(failed.includes("SIGNATURE_TYPE"));
  assert.ok(failed.includes("POLYMARKET_HOST"));
});

test("private key is not printed by env check", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "polypulse-env-"));
  const secretValue = "test-secret-value-never-print";
  const envPath = path.join(dir, "live.env");
  const keyName = "PRIVATE" + "_KEY";
  await writeFile(envPath, [
    "POLYPULSE_EXECUTION_MODE=live",
    `${keyName}=${secretValue}`,
    "FUNDER_ADDRESS=0x1111111111111111111111111111111111111111",
    "SIGNATURE_TYPE=1",
    "CHAIN_ID=137",
    "POLYMARKET_HOST=https://clob.polymarket.com"
  ].join("\n"), "utf8");
  const output = await new Promise((resolve, reject) => {
    execFile(process.execPath, [cliPath, "env", "check", "--mode", "live", "--env-file", envPath], { cwd: repoRoot }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || stdout || error.message));
        return;
      }
      resolve(stdout);
    });
  });
  assert.equal(output.includes(secretValue), false);
  assert.match(output, /0x1111\*\*\*1111/);
});

test("account balance uses mock live broker without exposing credentials", async () => {
  const config = await tempConfig({
    executionMode: "live",
    envFilePath: "/tmp/polypulse-live.env",
    privateKey: "in-memory-test-secret",
    funderAddress: "0x2222222222222222222222222222222222222222",
    signatureType: "1",
    polymarketHost: "https://clob.polymarket.com"
  });
  const stateStore = new FileStateStore(config);
  const liveBroker = new LiveBroker(config, {
    client: {
      preflight: async () => ({ ok: true, source: "mock" }),
      getCollateralBalance: async () => ({
        collateralBalance: 123.45,
        allowance: 1000,
        raw: { balance: "123.45" }
      })
    }
  });
  const balance = await new AccountService({ config, stateStore, liveBroker }).getBalance({ mode: "live" });
  assert.equal(balance.executionMode, "live");
  assert.equal(balance.collateral.balanceUsd, 123.45);
  assert.equal(JSON.stringify(balance).includes(config.privateKey), false);
});

test("paper broker supports buy, sell, mark-to-market, and crash recovery", async () => {
  const config = await tempConfig();
  const stateStore = new FileStateStore(config);
  const broker = new PaperBroker(stateStore);
  const market = SAMPLE_MARKETS[0];

  const buy = await broker.submit(order("BUY"), market);
  assert.equal(buy.status, "filled");
  const afterBuy = await stateStore.getPortfolio();
  assert.equal(afterBuy.positions.length, 1);
  assert.ok(afterBuy.cashUsd < 1000);

  const sell = await broker.submit({ ...order("SELL"), amountUsd: 4 }, market);
  assert.equal(sell.status, "filled");
  const marked = await broker.sync([{
    ...market,
    outcomes: market.outcomes.map((outcome) => ({ ...outcome, lastPrice: 0.5 }))
  }]);
  assert.ok(marked.totalEquityUsd > 0);

  const recovered = await new FileStateStore(config).getPortfolio();
  assert.equal(recovered.accountId, "paper");
  assert.ok(recovered.positions.length <= 1);
});

test("live broker rejects by default and without confirm LIVE", async () => {
  const config = await tempConfig({
    executionMode: "live",
    envFilePath: "/tmp/polypulse-live.env",
    privateKey: "in-memory-test-secret",
    funderAddress: "0x3333333333333333333333333333333333333333",
    signatureType: "1",
    polymarketHost: "https://clob.polymarket.com"
  });
  const liveBroker = new LiveBroker(config, {
    client: {
      preflight: async () => ({ ok: true, source: "mock" }),
      getCollateralBalance: async () => ({ collateralBalance: 100, allowance: 100, raw: {} }),
      postMarketOrder: async () => ({ ok: true, orderId: "live-1", filledUsd: 1, avgPrice: 0.5, raw: {} })
    }
  });

  const result = await liveBroker.submit({ ...order("BUY"), mode: "live", amountUsd: 1 }, SAMPLE_MARKETS[0]);
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "live_requires_confirm_live");
});

test("OrderExecutor blocks when RiskDecision is not allowed", async () => {
  const config = await tempConfig();
  const stateStore = new FileStateStore(config);
  const executor = new OrderExecutor({
    paperBroker: new PaperBroker(stateStore),
    liveBroker: new LiveBroker(config)
  });
  const result = await executor.execute({
    mode: "paper",
    market: SAMPLE_MARKETS[0],
    risk: { allowed: false, reasons: ["test_block"], approvedUsd: 0, order: null }
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "test_block");
});

test("live broker can execute through a mock client only after confirm", async () => {
  const config = await tempConfig({
    executionMode: "live",
    envFilePath: "/tmp/polypulse-live.env",
    privateKey: "in-memory-test-secret",
    funderAddress: "0x4444444444444444444444444444444444444444",
    signatureType: "1",
    polymarketHost: "https://clob.polymarket.com"
  });
  let posted = false;
  const liveBroker = new LiveBroker(config, {
    client: {
      preflight: async () => ({ ok: true, source: "mock" }),
      getCollateralBalance: async () => ({ collateralBalance: 100, allowance: 100, raw: {} }),
      postMarketOrder: async () => {
        posted = true;
        return { ok: true, orderId: "live-filled", filledUsd: 1, avgPrice: 0.42, raw: { ok: true } };
      }
    }
  });
  const result = await liveBroker.submit({ ...order("BUY"), mode: "live", amountUsd: 1 }, SAMPLE_MARKETS[0], "LIVE");
  assert.equal(posted, true);
  assert.equal(result.status, "filled");
  assert.equal(result.orderId, "live-filled");
});
