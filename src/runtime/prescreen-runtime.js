/**
 * AI Pre-Screen Runtime
 *
 * Lightweight AI pre-screening step that classifies candidates as TRADE or SKIP.
 * This aligns with Predict-Raven's pulse-prescreen.ts:
 * - TRADE: AI can generate meaningful edge through reasoning, information synthesis,
 *   or precedent matching.
 * - SKIP: outcome is too random, depends on insider info, or is already efficiently priced.
 *
 * 提示词模板（zh locale 示例，由 buildPreScreenPrompt() 动态生成）：
 * ─────────────────────────────────────────────────────────────────
 * 给定以下候选市场，快速分类每个市场为 TRADE 或 SKIP：
 * - TRADE：AI 能通过推理、信息综合或先例匹配产生有意义的 edge
 * - SKIP：结果太随机、依赖内幕信息或市场已经高效定价
 *
 * 对于每个候选，严格输出一行，格式为：
 * TRADE|market_slug|一句话原因
 * 或
 * SKIP|market_slug|一句话原因
 *
 * 候选市场：
 * 1. <question> | slug: <slug> | category: <cat> | price: <price> | ends: <date> | liquidity: <liq>
 * 2. ...
 * ─────────────────────────────────────────────────────────────────
 *
 * Key properties:
 * - Runs BEFORE the heavier candidate triage step
 * - Short timeout (60s default), low reasoning effort
 * - Graceful failure: on timeout/error, all candidates default to TRADE
 * - Simple text output format (TRADE|slug|reason or SKIP|slug|reason)
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveEffectiveProvider, resolveCodexSkillSettings } from "./codex-skill-settings.js";
import { resolveClaudeSkillSettings } from "./claude-skill-settings.js";
import { codexRuntimeInternals } from "./codex-runtime.js";
import { claudeRuntimeInternals } from "./claude-runtime.js";

const { runCodex } = codexRuntimeInternals;
const { runClaude } = claudeRuntimeInternals;

function formatPrice(market) {
  const outcomes = market.outcomes ?? [];
  return outcomes
    .map((o) => `${Math.round((o.impliedProbability ?? o.lastPrice ?? 0) * 100)}%`)
    .join("/");
}

function formatLiquidity(usd) {
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(1)}M`;
  if (usd >= 1_000) return `$${Math.round(usd / 1_000)}K`;
  return `$${Math.round(usd)}`;
}

function formatEndDate(endDate) {
  if (!endDate) return "n/a";
  try {
    return new Date(endDate).toISOString().slice(0, 10);
  } catch {
    return endDate;
  }
}

function isChineseLocale(locale) {
  return locale === "zh";
}

function buildPreScreenPrompt({ candidates, settings }) {
  const localeIsChinese = isChineseLocale(settings.locale);

  const candidateLines = candidates.map((market, index) => {
    const price = formatPrice(market);
    const liq = formatLiquidity(market.liquidityUsd ?? 0);
    const endDate = formatEndDate(market.endDate);
    const category = market.category || "uncategorized";
    return `${index + 1}. ${market.question} | slug: ${market.marketSlug} | category: ${category} | price: ${price} | ends: ${endDate} | liquidity: ${liq}`;
  });

  if (localeIsChinese) {
    return [
      "给定以下候选市场，快速分类每个市场为 TRADE 或 SKIP：",
      "- TRADE：AI 能通过推理、信息综合或先例匹配产生有意义的 edge",
      "- SKIP：结果太随机、依赖内幕信息或市场已经高效定价",
      "",
      "对于每个候选，严格输出一行，格式为：",
      "TRADE|market_slug|一句话原因",
      "或",
      "SKIP|market_slug|一句话原因",
      "",
      "候选市场：",
      ...candidateLines
    ].join("\n");
  }

  return [
    "Given these market candidates, quickly classify each as TRADE (AI can generate meaningful edge through reasoning, information synthesis, or precedent matching) or SKIP (outcome is too random, depends on insider info, or is already efficiently priced).",
    "",
    "For each candidate, respond with exactly one line in this format:",
    "TRADE|market_slug|one-line reason",
    "or",
    "SKIP|market_slug|one-line reason",
    "",
    "Candidates:",
    ...candidateLines
  ].join("\n");
}

function parsePreScreenResponse(output, candidates) {
  const results = new Map();
  const lines = String(output ?? "").split("\n").filter((line) => line.trim());

  for (const line of lines) {
    const parts = line.split("|").map((part) => part.trim());
    if (parts.length < 2) continue;
    const action = parts[0].toUpperCase();
    if (action !== "TRADE" && action !== "SKIP") continue;
    const slug = parts[1];
    const reason = parts[2] || "";
    results.set(slug.toLowerCase(), { suitable: action === "TRADE", reason });
  }

  return candidates.map((market) => {
    const key = (market.marketSlug ?? "").toLowerCase();
    const found = results.get(key);
    return {
      marketSlug: market.marketSlug,
      suitable: found?.suitable ?? true,
      reason: found?.reason ?? "not classified by pre-screen"
    };
  });
}

export class PreScreenProvider {
  constructor(config) {
    this.config = config;
    this.timeoutMs = config.pulse?.prescreenTimeoutMs ?? 120000;
    this.enabled = config.pulse?.aiPrescreen !== false;
  }

  async preScreen({ candidates }) {
    if (!this.enabled || candidates.length === 0) {
      return {
        results: candidates.map((m) => ({ marketSlug: m.marketSlug, suitable: true, reason: "prescreen_disabled" })),
        tradeCount: candidates.length,
        skipCount: 0,
        elapsedMs: 0,
        failed: false
      };
    }

    const startTime = Date.now();
    const provider = resolveEffectiveProvider(this.config);
    const settings = provider === "claude-code"
      ? resolveClaudeSkillSettings(this.config)
      : resolveCodexSkillSettings(this.config);

    const prompt = buildPreScreenPrompt({ candidates, settings });

    let tmpDir;
    try {
      tmpDir = await mkdtemp(path.join(tmpdir(), "polypulse-prescreen-"));
      const promptPath = path.join(tmpDir, "prescreen-prompt.txt");
      const outputPath = path.join(tmpDir, "prescreen-output.txt");
      await writeFile(promptPath, prompt, "utf8");

      let output;
      if (provider === "claude-code") {
        await this.runWithTimeout(
          () => runClaude({
            prompt,
            outputPath,
            repoRoot: this.config.repoRoot,
            settings,
            schemaPath: null,
            timeoutMs: this.timeoutMs
          }),
          this.timeoutMs
        );
        output = await readFile(outputPath, "utf8");
      } else {
        await this.runWithTimeout(
          () => runCodex({
            prompt,
            outputPath,
            repoRoot: this.config.repoRoot,
            settings,
            schemaPath: null,
            timeoutMs: this.timeoutMs,
            configOverrides: ['model_reasoning_effort="low"'],
            maxRetries: this.config.providerMaxRetries
          }),
          this.timeoutMs
        );
        output = await readFile(outputPath, "utf8");
      }

      const results = parsePreScreenResponse(output, candidates);
      const tradeCount = results.filter((r) => r.suitable).length;
      const skipCount = results.filter((r) => !r.suitable).length;

      return {
        results,
        tradeCount,
        skipCount,
        elapsedMs: Date.now() - startTime,
        failed: false
      };
    } catch (error) {
      return {
        results: candidates.map((m) => ({ marketSlug: m.marketSlug, suitable: true, reason: "prescreen_failed_fallback" })),
        tradeCount: candidates.length,
        skipCount: 0,
        elapsedMs: Date.now() - startTime,
        failed: true,
        failureReason: error instanceof Error ? error.message : String(error)
      };
    } finally {
      if (tmpDir) {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  async runWithTimeout(fn, timeoutMs) {
    let timer;
    return await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`prescreen_timeout_${timeoutMs}ms`)), timeoutMs);
      })
    ]).finally(() => clearTimeout(timer));
  }
}

export const prescreenInternals = {
  buildPreScreenPrompt,
  parsePreScreenResponse,
  formatPrice,
  formatLiquidity,
  formatEndDate
};
