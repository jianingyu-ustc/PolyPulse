import { randomUUID } from "node:crypto";
import { loadEnvConfig, summarizeEnvConfig, validateEnvConfig } from "./config/env.js";
import { PolymarketMarketSource } from "./adapters/polymarket-market-source.js";
import { DecisionEngine } from "./core/decision-engine.js";
import { RiskEngine } from "./core/risk-engine.js";
import { FileStateStore } from "./state/file-state-store.js";
import { ArtifactWriter } from "./artifacts/artifact-writer.js";
import { Scheduler } from "./scheduler/scheduler.js";
import { AccountService } from "./account/account-service.js";
import { EvidenceCrawler } from "./adapters/evidence-crawler.js";
import { TopicDiscoveryProvider } from "./runtime/topic-discovery-runtime.js";
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
  if (args.includes("--source")) {
    throw new Error("unsupported_option: --source has been removed; PolyPulse only reads Polymarket markets");
  }
  const config = await loadEnvConfig({
    envFile,
    overrides
  });
  if (config.executionMode !== "live") {
    throw new Error(`unsupported_execution_mode: ${config.executionMode}; only live is supported`);
  }
  if (config.marketSource !== "polymarket") {
    throw new Error(`unsupported_market_source: ${config.marketSource}; only polymarket is supported`);
  }
  const stateStore = new FileStateStore(config);
  const artifactWriter = new ArtifactWriter(config);
  const marketSource = new PolymarketMarketSource(config, stateStore);
  return { config, stateStore, artifactWriter, marketSource };
}

function liveModeFromArgs(args) {
  const mode = option(args, "--mode", "live");
  if (mode !== "live") {
    throw new Error(`unsupported_execution_mode: ${mode}; only live is supported`);
  }
  return mode;
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
  const mode = liveModeFromArgs(args);
  const context = await createContext(args, mode ? { POLYPULSE_EXECUTION_MODE: mode } : {});
  const report = validateEnvConfig(context.config, { mode: mode ?? context.config.executionMode });
  const runId = randomUUID();
  const artifact = await context.artifactWriter.writeJson("env-check", runId, report);
  print({ ok: report.ok, env: summarizeEnvConfig(context.config, { mode: report.mode }), report, artifact });
}

async function commandBalance(args) {
  const mode = liveModeFromArgs(args);
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

async function commandAccountAudit(args) {
  const mode = liveModeFromArgs(args);
  const context = await createContext(args, mode ? { POLYPULSE_EXECUTION_MODE: mode } : {});
  const service = new AccountService({ config: context.config, stateStore: context.stateStore });
  const audit = await service.audit({ mode: mode ?? context.config.executionMode });
  const artifact = await context.artifactWriter.writeAccountAudit(audit);
  print({
    ok: audit.ok,
    executionMode: audit.executionMode,
    scope: audit.scope ?? "real-remote",
    envFilePath: audit.env.envFilePath,
    chainId: audit.env.chainId,
    wallet: audit.wallet,
    collateral: audit.collateral,
    positionSummary: audit.positionSummary,
    positions: audit.positions.slice(0, 50),
    closedPositions: audit.closedPositions.slice(0, 50),
    performance: audit.performance,
    tradeSummary: audit.tradeSummary,
    recentTrades: audit.trades.slice(0, 50),
    openOrderSummary: audit.openOrderSummary,
    openOrders: audit.openOrders.slice(0, 50),
    localState: audit.localState,
    warnings: audit.warnings ?? [],
    errors: audit.errors,
    blockingReasons: audit.blockingReasons,
    artifact
  });
}

async function commandAccountApprove(args) {
  const mode = liveModeFromArgs(args);
  const context = await createContext(args, mode ? { POLYPULSE_EXECUTION_MODE: mode } : {});
  const service = new AccountService({ config: context.config, stateStore: context.stateStore });
  const approval = await service.approveCollateral({
    mode: mode ?? context.config.executionMode,
    confirmation: option(args, "--confirm")
  });
  const artifact = await context.artifactWriter.writeAccountApproval(approval);
  print({
    ok: true,
    executionMode: approval.executionMode,
    envFilePath: approval.env.envFilePath,
    chainId: approval.env.chainId,
    wallet: approval.wallet,
    before: approval.before,
    after: approval.after,
    artifact
  });
}

async function commandTopics(args) {
  const context = await createContext(args);
  const rawLimit = option(args, "--limit");
  const limit = rawLimit == null ? null : Number(rawLimit);
  const quick = flag(args, "--quick") || flag(args, "--preflight");
  const scan = await context.marketSource.scan({
    ...(limit == null ? {} : { limit }),
    minLiquidityUsd: option(args, "--min-liquidity"),
    minVolumeUsd: option(args, "--min-volume"),
    categoryKeyword: option(args, "--category"),
    endsAfter: option(args, "--ends-after"),
    endsBefore: option(args, "--ends-before"),
    tradableOnly: parseOptionalBoolean(args, "--tradable"),
    activeOnly: parseOptionalBoolean(args, "--active"),
    closedOnly: parseOptionalBoolean(args, "--closed"),
    pulseCompatible: quick ? false : undefined
  });
  const artifacts = await context.artifactWriter.writeMarketScan(scan);
  print({
    ok: true,
    quick,
    source: scan.source,
    topics: scan.markets,
    totalFetched: scan.totalFetched,
    totalReturned: scan.totalReturned,
    riskFlags: scan.riskFlags,
    pulse: scan.pulse,
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
  const decision = new DecisionEngine(context.config).analyze({
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
    provider: prediction.estimate.diagnostics?.provider,
    effectiveProvider: prediction.estimate.diagnostics?.effectiveProvider,
    market_question: prediction.market.question,
    ai_probability: prediction.estimate.ai_probability,
    market_implied_probability: decision.market_implied_probability,
    edge: decision.edge,
    net_edge: decision.netEdge,
    entry_fee_pct: decision.entryFeePct,
    quarter_kelly_pct: decision.quarterKellyPct,
    monthly_return: decision.monthlyReturn,
    suggested_notional_before_risk: decision.suggested_notional_before_risk,
    confidence: prediction.estimate.confidence,
    action: "predict-only",
    artifact: artifacts.decision.path
  });
}

async function commandDiscoverTopics(args) {
  const context = await createContext(args);
  const scan = await context.marketSource.scan({ limit: 100, pulseCompatible: false });
  const categories = [...new Set(scan.markets.map((m) => m.category).filter(Boolean))];
  const provider = new TopicDiscoveryProvider(context.config);
  const discovery = await provider.discover({
    currentCategories: categories,
    currentMarketCount: scan.totalFetched,
    recentTopics: []
  });
  const artifact = await context.artifactWriter.writeJson("topic-discovery", randomUUID(), discovery);
  print({
    ok: !discovery.failed,
    skipped: discovery.skipped ?? false,
    provider: discovery.provider ?? null,
    topics: discovery.discovered_topics,
    topicCount: discovery.discovered_topics.length,
    failureReason: discovery.failureReason ?? null,
    artifact
  });
}

async function commandEvidenceCollect(args) {
  const context = await createContext(args);
  const marketId = option(args, "--market");
  if (!marketId) {
    throw new Error("evidence collect requires --market <market-id-or-slug>");
  }
  const market = await context.marketSource.getMarket(marketId);
  if (!market) {
    throw new Error(`Market not found: ${marketId}`);
  }
  const crawler = new EvidenceCrawler(context.config);
  const evidence = await crawler.collect({ market });
  const artifact = await context.artifactWriter.writeJson("evidence-collect", randomUUID(), {
    marketId: market.marketId,
    question: market.question,
    evidence
  });
  print({
    ok: true,
    market_question: market.question,
    marketId: market.marketId,
    evidenceCount: evidence.items?.length ?? evidence.length ?? 0,
    sources: [...new Set((evidence.items ?? evidence).map((e) => e.source))],
    artifact
  });
}

async function commandRiskEvaluate(args) {
  const mode = liveModeFromArgs(args);
  const context = await createContext(args, { POLYPULSE_EXECUTION_MODE: mode });
  const marketId = option(args, "--market");
  if (!marketId) {
    throw new Error("risk evaluate requires --market <market-id-or-slug>");
  }
  const maxAmountUsd = parseAmount(args);
  const side = option(args, "--side");
  const confirmation = option(args, "--confirm");

  const { market, evidence, estimate } = await buildPrediction(context, marketId);
  const portfolio = await context.stateStore.getPortfolio();
  const decisionEngine = new DecisionEngine(context.config);
  const analysis = decisionEngine.analyze({ market, estimate, portfolio, amountUsd: maxAmountUsd });
  const chosenSide = side ?? analysis.suggested_side ?? "yes";
  const decision = decisionEngine.decide({ market, estimate, side: chosenSide, amountUsd: maxAmountUsd, portfolio });

  const risk = await new RiskEngine(context.config, { stateStore: context.stateStore }).evaluate({
    decision,
    market,
    portfolio,
    mode,
    confirmation,
    evidence,
    estimate
  });

  const artifact = await context.artifactWriter.writeJson("risk-evaluate", randomUUID(), {
    market: { marketId: market.marketId, question: market.question },
    estimate: { ai_probability: estimate.ai_probability, confidence: estimate.confidence },
    decision: { side: decision.side, edge: decision.edge, netEdge: decision.netEdge, quarterKellyPct: decision.quarterKellyPct },
    risk
  });
  print({
    ok: true,
    mode,
    market_question: market.question,
    ai_probability: estimate.ai_probability,
    confidence: estimate.confidence,
    side: decision.side,
    edge: decision.edge,
    net_edge: decision.netEdge,
    entry_fee_pct: decision.entryFeePct,
    quarter_kelly_pct: decision.quarterKellyPct,
    monthly_return: decision.monthlyReturn,
    risk_allowed: risk.allowed,
    blocked_reasons: risk.blockedReasons ?? [],
    warnings: risk.warnings ?? [],
    approved_usd: risk.approvedUsd ?? null,
    artifact
  });
}

async function commandTradeOnce(args) {
  const mode = liveModeFromArgs(args);
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
    ok: result.ok ?? true,
    status: result.status,
    mode: result.mode,
    provider: result.provider,
    effectiveProvider: result.effectiveProvider,
    market_question: result.market_question,
    ai_probability: result.ai_probability,
    market_probability: result.market_probability,
    edge: result.edge,
    net_edge: result.decision?.netEdge,
    entry_fee_pct: result.decision?.entryFeePct,
    quarter_kelly_pct: result.decision?.quarterKellyPct,
    monthly_return: result.decision?.monthlyReturn,
    action: result.action,
    artifact: result.artifact,
    log: result.log
  });
}

async function commandMonitorRun(args) {
  const mode = liveModeFromArgs(args);
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
  const mode = liveModeFromArgs(args);
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
      "polypulse account audit --mode live --env-file <path>",
      "polypulse account approve --mode live --env-file <path> --confirm APPROVE",
      "polypulse market topics --limit 20",
      "polypulse market topics --quick --limit 20",
      "polypulse market topics --limit 20 --min-liquidity 1000 --min-volume 500 --category politics --tradable true",
      "Use topics[].marketId or topics[].marketSlug as --market.",
      "polypulse discover topics --env-file <path>",
      "polypulse evidence collect --market <market-id-or-slug> --env-file <path>",
      "polypulse predict --market <market-id-or-slug>",
      "polypulse risk evaluate --market <market-id-or-slug> --max-amount 1 --env-file <path>",
      "polypulse trade once --mode live --market <id> --max-amount 1 --env-file <path> --confirm LIVE",
      "polypulse risk status|pause|halt|resume",
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
  if (group === "account" && command === "audit") return await commandAccountAudit(args);
  if (group === "account" && command === "approve") return await commandAccountApprove(args);
  if (group === "market" && command === "topics") return await commandTopics(args);
  if (group === "discover" && command === "topics") return await commandDiscoverTopics(args);
  if (group === "evidence" && command === "collect") return await commandEvidenceCollect(args);
  if (group === "predict") return await commandPredict(args);
  if (group === "risk" && command === "evaluate") return await commandRiskEvaluate(args);
  if (group === "trade" && command === "once") return await commandTradeOnce(args);
  if (group === "risk") return await commandRisk(args);
  if (group === "monitor") return await commandMonitor(args);
  throw new Error(`Unknown command: ${args.join(" ")}`);
}
