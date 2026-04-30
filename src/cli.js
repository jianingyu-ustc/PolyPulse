import { randomUUID } from "node:crypto";
import { loadEnvConfig, summarizeEnvConfig, validateEnvConfig } from "./config/env.js";
import { MockMarketSource } from "./adapters/mock-market-source.js";
import { PolymarketMarketSource } from "./adapters/polymarket-market-source.js";
import { DecisionEngine } from "./core/decision-engine.js";
import { FileStateStore } from "./state/file-state-store.js";
import { ArtifactWriter } from "./artifacts/artifact-writer.js";
import { Scheduler } from "./scheduler/scheduler.js";
import { AccountService } from "./account/account-service.js";
import { buildPrediction, runTradeOnce } from "./flows/once-runner.js";

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0) {
    return fallback;
  }
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : fallback;
}

function flag(args, name) {
  return args.includes(name);
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function createContext(args, overrides = {}) {
  const envFile = option(args, "--env-file");
  const source = option(args, "--source");
  const config = await loadEnvConfig({
    envFile,
    overrides: {
      ...overrides,
      ...(source ? { POLYPULSE_MARKET_SOURCE: source } : {})
    }
  });
  const stateStore = new FileStateStore(config);
  const artifactWriter = new ArtifactWriter(config);
  const marketSource = config.marketSource === "mock"
    ? new MockMarketSource(config, stateStore)
    : new PolymarketMarketSource(config, stateStore);
  return { config, stateStore, artifactWriter, marketSource };
}

function parseAmount(args) {
  const amount = Number(option(args, "--max-amount", option(args, "--amount", "1")));
  return Number.isFinite(amount) ? amount : 1;
}

function parseOptionalBoolean(args, name) {
  const value = option(args, name);
  if (value == null) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  return null;
}

async function commandEnv(args) {
  const mode = option(args, "--mode");
  const context = await createContext(args, mode ? { POLYPULSE_EXECUTION_MODE: mode } : {});
  const report = validateEnvConfig(context.config, { mode: mode ?? context.config.executionMode });
  const runId = randomUUID();
  const artifact = await context.artifactWriter.writeJson("env-check", runId, report);
  print({ ok: report.ok, env: summarizeEnvConfig(context.config, { mode: report.mode }), report, artifact });
}

async function commandBalance(args) {
  const mode = option(args, "--mode");
  const context = await createContext(args, mode ? { POLYPULSE_EXECUTION_MODE: mode } : {});
  const service = new AccountService({ config: context.config, stateStore: context.stateStore });
  const balance = await service.getBalance({ mode: mode ?? context.config.executionMode });
  const artifact = await context.artifactWriter.writeAccountBalance(balance);
  print({
    ok: true,
    executionMode: balance.executionMode,
    envFilePath: balance.env.envFilePath,
    chainId: balance.env.chainId,
    wallet: balance.wallet,
    collateralBalance: balance.collateral.balanceUsd,
    collateral: balance.collateral,
    artifact
  });
}

async function commandTopics(args) {
  const context = await createContext(args);
  const limit = Number(option(args, "--limit", String(context.config.scan.marketScanLimit)));
  const scan = await context.marketSource.scan({
    limit,
    minLiquidityUsd: option(args, "--min-liquidity"),
    minVolumeUsd: option(args, "--min-volume"),
    categoryKeyword: option(args, "--category"),
    endsAfter: option(args, "--ends-after"),
    endsBefore: option(args, "--ends-before"),
    tradableOnly: parseOptionalBoolean(args, "--tradable"),
    activeOnly: parseOptionalBoolean(args, "--active"),
    closedOnly: parseOptionalBoolean(args, "--closed")
  });
  const artifacts = await context.artifactWriter.writeMarketScan(scan);
  print({
    ok: true,
    source: scan.source,
    topics: scan.markets,
    totalFetched: scan.totalFetched,
    totalReturned: scan.totalReturned,
    riskFlags: scan.riskFlags,
    artifacts,
    artifact: artifacts.markets
  });
}

async function commandPredict(args) {
  const context = await createContext(args);
  const marketId = option(args, "--market");
  if (!marketId) {
    throw new Error("predict requires --market <market-id-or-slug>");
  }
  const prediction = await buildPrediction(context, marketId);
  const portfolio = await context.stateStore.getPortfolio();
  const decision = new DecisionEngine().analyze({
    market: prediction.market,
    estimate: prediction.estimate,
    portfolio,
    amountUsd: context.config.risk.minTradeUsd
  });
  const artifacts = await context.artifactWriter.writePrediction({
    ...prediction,
    decision
  });
  print({
    ok: true,
    mode: "predict",
    market_question: prediction.market.question,
    ai_probability: prediction.estimate.ai_probability,
    market_implied_probability: decision.market_implied_probability,
    edge: decision.edge,
    confidence: prediction.estimate.confidence,
    action: "predict-only",
    artifact: artifacts.decision.path
  });
}

async function commandTradeOnce(args) {
  const mode = option(args, "--mode", "paper");
  const context = await createContext(args, { POLYPULSE_EXECUTION_MODE: mode });
  const marketId = option(args, "--market");
  const side = option(args, "--side");
  const maxAmountUsd = parseAmount(args);
  const confirmation = option(args, "--confirm");
  if (!marketId) {
    throw new Error("trade once requires --market <id-or-slug>");
  }

  const result = await runTradeOnce({
    context,
    marketId,
    mode,
    side,
    maxAmountUsd,
    confirmation
  });
  print({
    ok: true,
    mode: result.mode,
    market_question: result.market_question,
    ai_probability: result.ai_probability,
    market_probability: result.market_probability,
    edge: result.edge,
    action: result.action,
    artifact: result.artifact
  });
}

async function commandMonitorRun(args) {
  const mode = option(args, "--mode", "paper");
  const context = await createContext(args, { POLYPULSE_EXECUTION_MODE: mode });
  const scheduler = new Scheduler(context);
  const roundsOption = option(args, "--rounds");
  const parsedRounds = Number(roundsOption ?? "1");
  const rounds = flag(args, "--loop")
    ? null
    : Math.max(1, Number.isFinite(parsedRounds) ? parsedRounds : 1);
  const limit = option(args, "--limit");
  const maxAmountUsd = option(args, "--max-amount", option(args, "--amount"));
  const compact = (result) => ({
    ok: result.ok,
    status: result.status,
    mode: result.mode,
    runId: result.runId,
    markets: result.markets,
    candidates: result.candidates,
    predictions: result.predictions,
    orders: result.orders,
    action: result.action,
    artifact: result.artifact,
    reason: result.reason,
    error: result.error
  });
  const result = await scheduler.monitorLoop({
    mode,
    confirmation: option(args, "--confirm"),
    rounds,
    limit: limit == null ? null : Number(limit),
    maxAmountUsd: maxAmountUsd == null ? null : Number(maxAmountUsd),
    onRound: flag(args, "--loop") ? async (round) => print(compact(round)) : null
  });
  if (!flag(args, "--loop")) {
    print(compact(result.last ?? result));
  }
}

async function commandMonitor(args) {
  const mode = option(args, "--mode", "paper");
  const context = await createContext(args, { POLYPULSE_EXECUTION_MODE: mode });
  if (args[1] === "run") {
    return await commandMonitorRun(args);
  }
  if (args[1] === "status") {
    const state = await context.stateStore.getMonitorState();
    print({
      ok: true,
      mode,
      status: state.status,
      lastRunId: state.lastRunId,
      lastStartedAt: state.lastStartedAt,
      lastCompletedAt: state.lastCompletedAt,
      dailyTradeUsd: state.dailyTradeUsd,
      tradedMarketKeys: Object.keys(state.tradedMarkets ?? {}).length,
      watchlist: state.watchlist,
      blocklist: state.blocklist,
      inFlightRun: state.inFlightRun?.runId ?? null,
      lastError: state.lastError
    });
    return;
  }
  if (args[1] === "stop") {
    const state = await context.stateStore.stopMonitor(option(args, "--reason", "manual_stop"));
    print({ ok: true, mode, status: state.status, stopReason: state.stopReason, updatedAt: state.updatedAt });
    return;
  }
  if (args[1] === "resume") {
    const state = await context.stateStore.resumeMonitor();
    print({ ok: true, mode, status: state.status, resumedAt: state.resumedAt, updatedAt: state.updatedAt });
    return;
  }
  throw new Error(`Unknown monitor command: ${args.join(" ")}`);
}

async function commandRisk(args) {
  const context = await createContext(args);
  if (args[1] === "status") {
    print({ ok: true, riskState: await context.stateStore.getRiskState() });
    return;
  }
  if (args[1] === "pause") {
    print({ ok: true, riskState: await context.stateStore.pauseRisk(option(args, "--reason", "manual_pause")) });
    return;
  }
  if (args[1] === "halt") {
    print({ ok: true, riskState: await context.stateStore.haltRisk(option(args, "--reason", "manual_halt")) });
    return;
  }
  if (args[1] === "resume") {
    print({ ok: true, riskState: await context.stateStore.resumeRisk() });
    return;
  }
  throw new Error(`Unknown risk command: ${args.join(" ")}`);
}

function help() {
  return {
    ok: true,
    commands: [
      "polypulse env check",
      "polypulse account balance --env-file <path>",
      "polypulse market topics --limit 20",
      "polypulse market topics --limit 20 --min-liquidity 1000 --min-volume 500 --category politics --tradable true",
      "polypulse predict --market <market-id-or-slug>",
      "polypulse trade once --mode paper --market <id> --max-amount 1",
      "polypulse trade once --mode live --market <id> --max-amount 1 --env-file <path> --confirm LIVE",
      "polypulse risk status|pause|halt|resume",
      "polypulse monitor run --mode paper --rounds 1",
      "polypulse monitor run --mode paper --loop",
      "polypulse monitor run --mode live --env-file <path> --confirm LIVE --rounds 1",
      "polypulse monitor status|stop|resume"
    ]
  };
}

export async function main(args = []) {
  const [group, command] = args;
  if (!group || flag(args, "--help") || group === "help") {
    print(help());
    return;
  }
  if (group === "env" && command === "check") return await commandEnv(args);
  if (group === "account" && command === "balance") return await commandBalance(args);
  if (group === "market" && command === "topics") return await commandTopics(args);
  if (group === "predict") return await commandPredict(args);
  if (group === "trade" && command === "once") return await commandTradeOnce(args);
  if (group === "risk") return await commandRisk(args);
  if (group === "monitor") return await commandMonitor(args);
  throw new Error(`Unknown command: ${args.join(" ")}`);
}
