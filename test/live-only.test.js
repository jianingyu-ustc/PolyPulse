import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvConfig, validateEnvConfig } from "../src/config/env.js";
import { FileStateStore } from "../src/state/file-state-store.js";
import { PolymarketMarketSource } from "../src/adapters/polymarket-market-source.js";
import { RiskEngine } from "../src/core/risk-engine.js";

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
    `POLYPULSE_LIVE_WALLET_MODE=${walletMode}`,
    "SIMULATED_WALLET_BALANCE_USD=100",
    "POLYPULSE_MARKET_SOURCE=polymarket",
    "POLYMARKET_GAMMA_HOST=https://gamma-api.polymarket.com",
    "CHAIN_ID=137",
    "POLYMARKET_HOST=https://clob.polymarket.com",
    "AI_PROVIDER=codex",
    "AGENT_RUNTIME_PROVIDER=codex",
    "MARKET_SCAN_LIMIT=50",
    "MARKET_PAGE_SIZE=50",
    "MARKET_MAX_PAGES=2",
    "MARKET_MIN_FETCHED=20",
    "MARKET_REQUEST_TIMEOUT_MS=5000",
    "MARKET_REQUEST_RETRIES=0",
    "MARKET_RATE_LIMIT_MS=0",
    "PULSE_MIN_LIQUIDITY_USD=0",
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

async function requireGamma(t, config) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const url = `${config.polymarketGammaHost}/markets?limit=1&active=true&closed=false`;
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      t.skip(`Polymarket Gamma unavailable: HTTP ${response.status}`);
      return false;
    }
    return true;
  } catch (error) {
    t.skip(`Polymarket Gamma unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function gammaMarketRow(index) {
  return {
    id: String(10_000 + index),
    slug: `pulse-candidate-${index}`,
    question: `Will pulse candidate ${index} resolve yes?`,
    outcomes: JSON.stringify(["Yes", "No"]),
    clobTokenIds: JSON.stringify([`yes-token-${index}`, `no-token-${index}`]),
    outcomePrices: JSON.stringify([0.4, 0.6]),
    liquidity: 10000 + index,
    volume24hr: 100 + index,
    endDate: "2026-12-31T00:00:00.000Z",
    active: true,
    closed: false,
    acceptingOrders: true,
    resolutionRules: "Resolves according to test rules."
  };
}

test("live env accepts only Polymarket as the market source", async () => {
  const { config } = await createConfig();
  const report = validateEnvConfig(config, { mode: "live" });
  assert.equal(report.ok, true);
  assert.equal(report.mode, "live");
  assert.equal(config.marketSource, "polymarket");

  const invalid = await loadEnvConfig({
    envFile: config.envFilePath,
    overrides: { POLYPULSE_MARKET_SOURCE: "alternate-source" }
  });
  const invalidReport = validateEnvConfig(invalid, { mode: "live" });
  assert.equal(invalidReport.ok, false);
  assert.ok(invalidReport.checks.some((item) => item.key === "market-source" && !item.ok));
});

test("CLI rejects removed source override", async () => {
  const { envPath } = await createConfig();
  const result = await execCli(["market", "topics", "--source", "alternate-source", "--env-file", envPath], {
    env: { ...process.env }
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr || result.stdout, /unsupported_option/);
});

test("pulse scan defaults to PULSE_MAX_CANDIDATES unless --limit overrides it", async () => {
  const { config } = await createConfig({
    PULSE_MAX_CANDIDATES: "3",
    MARKET_SCAN_LIMIT: "10",
    MARKET_PAGE_SIZE: "10",
    MARKET_MIN_FETCHED: "10",
    MARKET_CACHE_TTL_SECONDS: "0"
  });
  const source = new PolymarketMarketSource(config, new FileStateStore(config));
  const rows = Array.from({ length: 10 }, (_, index) => gammaMarketRow(index + 1));
  source.fetchMarketPage = async ({ limit }) => rows.slice(0, limit);

  const defaultScan = await source.scan({ noCache: true });
  assert.equal(defaultScan.totalReturned, 3);
  assert.equal(defaultScan.pulse.strategy, "pulse-direct");
  assert.equal(defaultScan.pulse.postFilterCount, 10);

  const explicitScan = await source.scan({ noCache: true, limit: 5 });
  assert.equal(explicitScan.totalReturned, 5);
});

test("market source reads current Polymarket markets from Gamma", async (t) => {
  const { config } = await createConfig();
  if (!await requireGamma(t, config)) return;
  const source = new PolymarketMarketSource(config, new FileStateStore(config));
  const scan = await source.scan({ limit: 3, minLiquidityUsd: 0 });

  assert.equal(scan.source, "polymarket-gamma");
  assert.equal(scan.fromCache, false);
  assert.ok(scan.totalFetched > 0, "expected Gamma to return current market rows");
  assert.ok(scan.markets.length > 0, "expected at least one current Polymarket market");
  assert.ok(scan.markets.every((market) => market.source === "polymarket-gamma"));
  assert.ok(scan.markets.every((market) => market.marketId || market.marketSlug));
});

test("CLI market topics returns current Polymarket topics", async (t) => {
  const { config, envPath } = await createConfig();
  if (!await requireGamma(t, config)) return;
  const result = await execCli(["market", "topics", "--env-file", envPath, "--limit", "3", "--quick"], {
    env: { ...process.env }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);

  assert.equal(output.ok, true);
  assert.equal(output.quick, true);
  assert.equal(output.source, "polymarket-gamma");
  assert.ok(output.totalFetched > 0);
  assert.ok(output.topics.length > 0);
  assert.ok(output.topics.every((market) => market.marketId || market.marketSlug));
  assert.equal(output.pulse, null);
});

test("live simulated balance uses the live broker path", async () => {
  const { envPath } = await createConfig();
  const result = await execCli(["account", "balance", "--env-file", envPath], {
    env: { ...process.env }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);

  assert.equal(output.ok, true);
  assert.equal(output.wallet.walletMode, "simulated");
  assert.equal(output.collateral.source, "simulated-live-wallet");
  assert.equal(output.collateralBalance, 100);
});

test("live simulated account audit stays on the live broker path without remote account checks", async () => {
  const { envPath } = await createConfig();
  const result = await execCli(["account", "audit", "--env-file", envPath], {
    env: { ...process.env }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);

  assert.equal(output.ok, true);
  assert.equal(output.scope, "simulated-local");
  assert.equal(output.wallet.walletMode, "simulated");
  assert.equal(output.collateral.source, "simulated-live-wallet");
  assert.deepEqual(output.blockingReasons, []);
  assert.ok(output.warnings.includes("simulated_wallet_mode_no_real_account_audit"));
});

test("allowance approval requires explicit APPROVE confirmation", async () => {
  const { envPath } = await createConfig();
  const denied = await execCli(["account", "approve", "--env-file", envPath], {
    env: { ...process.env }
  });
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr || denied.stdout, /account_approve_requires_confirm_approve/);

  const approved = await execCli(["account", "approve", "--env-file", envPath, "--confirm", "APPROVE"], {
    env: { ...process.env }
  });
  assert.equal(approved.status, 0, approved.stderr || approved.stdout);
  const output = JSON.parse(approved.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.after.allowanceUsd, 100);
});

test("risk engine blocks live BUY orders when collateral allowance is insufficient", async () => {
  const { config } = await createConfig();
  const risk = await new RiskEngine(config).evaluate({
    decision: {
      action: "open",
      marketId: "market-1",
      tokenId: "yes-token",
      side: "BUY",
      requestedUsd: 5,
      suggested_notional_before_risk: 5,
      confidence: "high"
    },
    market: {
      marketId: "market-1",
      eventId: "event-1",
      outcomes: [{ tokenId: "yes-token" }],
      closed: false,
      active: true,
      tradable: true,
      liquidityUsd: 1000,
      fetchedAt: new Date().toISOString()
    },
    portfolio: {
      totalEquityUsd: 100,
      positions: []
    },
    mode: "live",
    confirmation: "LIVE",
    evidence: [
      { status: "ok", relevanceScore: 1 },
      { status: "ok", relevanceScore: 1 }
    ],
    estimate: {
      confidence: "high",
      uncertainty_factors: []
    },
    systemState: {
      status: "active",
      highWaterMarkUsd: 100
    },
    liveBalance: {
      collateralBalance: 100,
      allowance: 0
    }
  });

  assert.equal(risk.allow, false);
  assert.ok(risk.blockedReasons.includes("insufficient_live_allowance"));
  assert.equal(risk.order, null);
});
