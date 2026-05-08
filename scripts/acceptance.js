#!/usr/bin/env node
/**
 * 一次性验收脚本 —— 用 live monitor 同一套调度逻辑执行 7 个验收阶段
 *
 * 用法：
 *   node scripts/acceptance.js --env-file .env
 *   node scripts/acceptance.js --env-file .env --market <slug>
 *   node scripts/acceptance.js --env-file .env --max-amount <n>
 *
 * 说明：
 *   - Step 2-7 复用 Scheduler 的 live monitor scan/candidate/predict/risk/order 流程。
 *   - live simulated 会带 --confirm LIVE 走模拟订单路径，不连接真实钱包。
 *   - live real 默认不传 LIVE confirmation，因此会跑到风控/订单执行器但不会自动提交真实订单。
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadEnvConfig, redactSecrets, summarizeEnvConfig, validateEnvConfig } from "../src/config/env.js";
import { PolymarketMarketSource } from "../src/adapters/polymarket-market-source.js";
import { FileStateStore } from "../src/state/file-state-store.js";
import { ArtifactWriter } from "../src/artifacts/artifact-writer.js";
import { Scheduler } from "../src/scheduler/scheduler.js";

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : fallback;
}

function hasFlag(args, name) {
  return args.includes(name);
}

function parseNumber(value, fallback = null) {
  if (value == null) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function writeStep(artifactDir, results, step, name, payload, ok = true) {
  const safeName = name.replace(/[^a-zA-Z0-9_.-]+/g, "-");
  writeFileSync(
    path.join(artifactDir, `step${step}-${safeName}.stdout.log`),
    `${JSON.stringify(redactSecrets(payload), null, 2)}\n`,
    "utf8"
  );
  writeFileSync(path.join(artifactDir, `step${step}-${safeName}.stderr.log`), "", "utf8");
  const entry = { step, name, ok: Boolean(ok), status: ok ? 0 : 1 };
  results.push(entry);
  console.log(`\n[Step ${step}] ${name}`);
  console.log(`[Step ${step}] ${ok ? "✓ 成功" : "✗ 失败"}`);
  return entry;
}

function summarizeEvidence(stage) {
  return {
    ok: stage?.ok === true,
    predictions: (stage?.predictions ?? []).map((prediction) => ({
      marketId: prediction.marketId,
      marketSlug: prediction.marketSlug,
      question: prediction.question,
      evidenceCount: prediction.evidenceCount,
      sources: prediction.sources,
      evidence: prediction.evidence
    }))
  };
}

function summarizePrediction(stage) {
  return {
    ok: stage?.ok === true,
    ranked: (stage?.ranked ?? []).map((item) => ({
      rank: item.rank,
      marketId: item.marketId,
      marketSlug: item.marketSlug,
      question: item.question,
      provider: item.provider,
      effectiveProvider: item.effectiveProvider,
      providerRuntimeArtifact: item.providerRuntimeArtifact,
      ai_probability: item.ai_probability,
      confidence: item.confidence,
      reasoning_summary: item.reasoning_summary,
      key_evidence: item.key_evidence,
      counter_evidence: item.counter_evidence,
      uncertainty_factors: item.uncertainty_factors,
      analysis: item.analysis,
      riskAdjusted: item.riskAdjusted,
      downsideRisk: item.downsideRisk
    }))
  };
}

const argv = process.argv.slice(2);
const envFile = option(argv, "--env-file", ".env");
const manualMarket = option(argv, "--market", null);
const maxAmount = parseNumber(option(argv, "--max-amount", "1"), 1);
const allowLiveExecution = hasFlag(argv, "--allow-live-execution");

const runId = timestamp();
const artifactDir = path.resolve("runtime-artifacts", "acceptance-runs", runId);
mkdirSync(artifactDir, { recursive: true });

const results = [];
let failed = false;
let acceptance = null;

try {
  const config = await loadEnvConfig({
    envFile
  });
  if (config.marketSource !== "polymarket") {
    throw new Error(`unsupported_market_source: ${config.marketSource}; only polymarket is supported`);
  }

  const stateStore = new FileStateStore(config);
  const artifactWriter = new ArtifactWriter(config);
  const marketSource = new PolymarketMarketSource(config, stateStore);
  const scheduler = new Scheduler({ config, stateStore, artifactWriter, marketSource });

  const report = validateEnvConfig(config);
  const envArtifact = await artifactWriter.writeJson("env-check", randomUUID(), report);
  writeStep(artifactDir, results, 1, "env-check", {
    ok: report.ok,
    env: summarizeEnvConfig(config),
    report,
    artifact: envArtifact
  }, report.ok);
  if (!report.ok) {
    throw new Error("acceptance_env_check_failed");
  }

  const confirmation = config.liveWalletMode === "simulated" || allowLiveExecution ? "LIVE" : null;
  acceptance = await scheduler.runAcceptanceRound({
    confirmation,
    maxAmountUsd: maxAmount,
    marketId: manualMarket
  });

  writeStep(artifactDir, results, 2, "monitor-scan-and-candidates", {
    ok: acceptance.stages.scan?.ok === true,
    liveMonitorAligned: true,
    manualMarket,
    scan: acceptance.stages.scan,
    candidates: acceptance.stages.discovery?.candidates ?? []
  }, acceptance.stages.scan?.ok === true);

  writeStep(artifactDir, results, 3, "monitor-ai-prescreen-triage", {
    ok: acceptance.stages.discovery?.ok === true,
    liveMonitorAligned: true,
    topicDiscovery: acceptance.stages.discovery?.topicDiscovery ?? null,
    semanticDiscovery: acceptance.stages.discovery?.semanticDiscovery ?? null,
    preScreen: acceptance.stages.discovery?.preScreen ?? null,
    candidateTriage: acceptance.stages.discovery?.candidateTriage ?? null,
    selectedCandidates: acceptance.stages.discovery?.selectedCandidates ?? []
  }, acceptance.stages.discovery?.ok === true);

  writeStep(artifactDir, results, 4, "monitor-evidence-collect", summarizeEvidence(acceptance.stages.evidence), acceptance.stages.evidence?.ok === true);

  writeStep(artifactDir, results, 5, "monitor-ai-prediction-ranking", summarizePrediction(acceptance.stages.prediction), acceptance.stages.prediction?.ok === true);

  writeStep(artifactDir, results, 6, "monitor-risk-evaluate", {
    ok: acceptance.stages.risk?.ok === true,
    risks: acceptance.stages.risk?.risks ?? []
  }, acceptance.stages.risk?.ok === true);

  writeStep(artifactDir, results, 7, "monitor-execution", {
    ok: acceptance.stages.execution?.ok === true,
    walletMode: config.liveWalletMode,
    liveRealExecutionEnabled: config.liveWalletMode === "real" && allowLiveExecution,
    confirmationPassed: confirmation === "LIVE",
    orders: acceptance.stages.execution?.orders ?? [],
    filledOrders: acceptance.stages.execution?.filledOrders ?? [],
    action: acceptance.stages.execution?.action ?? acceptance.action,
    artifact: acceptance.stages.execution?.artifact ?? acceptance.artifact,
    log: acceptance.stages.execution?.log ?? acceptance.log,
    performance: acceptance.stages.execution?.performance ?? null
  }, acceptance.stages.execution?.ok === true);

  if (!acceptance.ok) {
    throw new Error(acceptance.error ?? "acceptance_monitor_round_failed");
  }
} catch (error) {
  failed = true;
  const message = error instanceof Error ? error.message : String(error);
  results.push({ step: "?", name: "acceptance", ok: false, status: 1, error: message });
  writeFileSync(path.join(artifactDir, "error.log"), `${message}\n`, "utf8");
}

const summary = {
  ok: !failed,
  steps: results.filter((item) => typeof item.step === "number").length,
  pass: results.filter((item) => item.ok).length,
  fail: results.filter((item) => !item.ok).length,
  liveMonitorAligned: true,
  walletMode: acceptance?.walletMode ?? null,
  runId: acceptance?.runId ?? null,
  market: acceptance?.stages?.prediction?.ranked?.[0]?.marketId
    ?? acceptance?.stages?.scan?.markets?.[0]?.marketId
    ?? manualMarket
    ?? null,
  action: acceptance?.action ?? "no-trade",
  monitorArtifact: acceptance?.artifact ?? null,
  monitorLog: acceptance?.log ?? null,
  artifactDir: path.relative(process.cwd(), artifactDir),
  results
};

writeFileSync(path.join(artifactDir, "summary.json"), `${JSON.stringify(redactSecrets(summary), null, 2)}\n`, "utf8");

console.log("\n" + "─".repeat(60));
console.log("验收结果：");
console.log(JSON.stringify(redactSecrets({
  ok: summary.ok,
  steps: summary.steps,
  pass: summary.pass,
  fail: summary.fail,
  liveMonitorAligned: summary.liveMonitorAligned,
  walletMode: summary.walletMode,
  runId: summary.runId,
  market: summary.market,
  action: summary.action,
  monitorArtifact: summary.monitorArtifact,
  monitorLog: summary.monitorLog,
  artifactDir: summary.artifactDir
}), null, 2));

if (failed) {
  process.exit(1);
}
