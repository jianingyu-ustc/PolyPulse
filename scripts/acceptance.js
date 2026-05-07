#!/usr/bin/env node
/**
 * 一次性验收脚本 —— 顺序执行 7 个 pipeline step
 *
 * 用法：
 *   node scripts/acceptance.js --env-file .env
 *   node scripts/acceptance.js --env-file .env --skip-discovery
 *   node scripts/acceptance.js --env-file .env --market <slug>
 *
 * 选项：
 *   --env-file <path>     指定 env 文件（默认 .env）
 *   --market <slug>       手动指定市场 slug/id，跳过自动选取
 *   --skip-discovery      跳过 Step 3（AI 话题发现）
 *   --max-amount <n>      交易金额上限（默认 1 USD）
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// ─── 工具函数 ───────────────────────────────────────────────────────────────

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

// ─── 参数解析 ───────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const envFile = option(argv, "--env-file", ".env");
const manualMarket = option(argv, "--market", null);
const skipDiscovery = hasFlag(argv, "--skip-discovery");
const maxAmount = option(argv, "--max-amount", "1");

// ─── 产出目录 ───────────────────────────────────────────────────────────────

const runId = timestamp();
const artifactDir = path.resolve("runtime-artifacts", "acceptance-runs", runId);
mkdirSync(artifactDir, { recursive: true });

// ─── 执行器 ─────────────────────────────────────────────────────────────────

const results = [];

function exec(step, args, { allowFail = false } = {}) {
  const label = `[Step ${step}]`;
  const fullArgs = ["./bin/polypulse.js", ...args];
  console.log(`\n${label} polypulse ${args.join(" ")}`);

  const result = spawnSync(process.execPath, fullArgs, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
    timeout: 300_000, // 5 分钟硬超时
  });

  const logName = `step${step}-${args.slice(0, 2).join("-")}`;
  writeFileSync(path.join(artifactDir, `${logName}.stdout.log`), result.stdout ?? "", "utf8");
  writeFileSync(path.join(artifactDir, `${logName}.stderr.log`), result.stderr ?? "", "utf8");

  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {}

  const ok = result.status === 0 && (parsed?.ok !== false || allowFail);
  const entry = { step, command: `polypulse ${args.join(" ")}`, ok, status: result.status };
  results.push(entry);

  if (ok) {
    console.log(`${label} ✓ 成功`);
  } else {
    const reason = parsed?.failureReason || parsed?.error || `exit code ${result.status}`;
    console.log(`${label} ✗ 失败: ${typeof reason === "string" ? reason.slice(0, 200) : JSON.stringify(reason).slice(0, 200)}`);
    if (!allowFail) {
      throw new Error(`${label} 中断: ${entry.command}`);
    }
  }

  return parsed;
}

// ─── 主流程 ─────────────────────────────────────────────────────────────────

let failed = false;
let marketId = manualMarket;
let skippedLiveExecution = false;

try {
  // ── Step 1: 环境检查 ──────────────────────────────────────────────────────
  const envCheck = exec(1, ["env", "check", "--mode", "live", "--env-file", envFile]);

  // ── Step 2: 规则扫描市场候选池 ────────────────────────────────────────────
  if (!marketId) {
    const topics = exec(2, ["market", "topics", "--env-file", envFile, "--limit", "20", "--quick"]);
    const market = topics?.topics?.[0];
    marketId = market?.marketId ?? market?.marketSlug;
    if (!marketId) {
      throw new Error("Step 2 未返回任何市场，无法继续");
    }
    console.log(`  → 自动选取市场: ${marketId}`);
  } else {
    console.log(`\n[Step 2] 跳过（使用手动指定市场: ${marketId}）`);
    results.push({ step: 2, command: "(manual market)", ok: true, status: 0 });
  }

  // ── Step 3: AI 话题发现（可选）────────────────────────────────────────────
  if (skipDiscovery) {
    console.log(`\n[Step 3] 跳过（--skip-discovery）`);
    results.push({ step: 3, command: "(skipped)", ok: true, status: 0 });
  } else {
    exec(3, ["discover", "topics", "--env-file", envFile], { allowFail: true });
  }

  // ── Step 4: 证据收集 + AI 研究指导 ───────────────────────────────────────
  exec(4, ["evidence", "collect", "--env-file", envFile, "--market", marketId]);

  // ── Step 5: AI 预测 ──────────────────────────────────────────────────────
  exec(5, ["predict", "--env-file", envFile, "--market", marketId]);

  // ── Step 6: 风控评估 ─────────────────────────────────────────────────────
  exec(6, ["risk", "evaluate", "--env-file", envFile, "--market", marketId, "--max-amount", maxAmount]);

  // ── Step 7: 交易执行 ─────────────────────────────────────────────────────
  if (envCheck?.report?.liveWalletMode === "simulated") {
    exec(7, ["trade", "once", "--mode", "live", "--env-file", envFile, "--market", marketId, "--max-amount", maxAmount, "--confirm", "LIVE"]);
  } else {
    skippedLiveExecution = true;
    console.log(`\n[Step 7] 跳过（live real 模式下不自动执行交易，需手动确认）`);
    results.push({ step: 7, command: "(skipped: live real)", ok: true, status: 0 });
  }
} catch (error) {
  failed = true;
  results.push({ step: "?", command: "acceptance", ok: false, error: error instanceof Error ? error.message : String(error) });
}

// ─── 汇总 ───────────────────────────────────────────────────────────────────

const summary = {
  ok: !failed,
  steps: results.length,
  pass: results.filter((r) => r.ok).length,
  fail: results.filter((r) => !r.ok).length,
  skippedLiveExecution,
  market: marketId,
  artifactDir: path.relative(process.cwd(), artifactDir),
};

writeFileSync(path.join(artifactDir, "summary.json"), `${JSON.stringify({ ...summary, results }, null, 2)}\n`, "utf8");

console.log("\n" + "─".repeat(60));
console.log("验收结果：");
console.log(JSON.stringify(summary, null, 2));

if (failed) {
  process.exit(1);
}
