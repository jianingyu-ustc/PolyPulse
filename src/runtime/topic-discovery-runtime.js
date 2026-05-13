/**
 * TopicDiscoveryRuntime
 *
 * Aligns with Predict-Raven's AI-driven external topic discovery:
 * Uses the configured AI provider to propose new topics from external signals
 * (news, RSS, sports, macro, on-chain) that can be mapped to Polymarket markets.
 *
 * 提示词模板（zh locale 示例，由 buildPrompt() 动态生成）：
 * ─────────────────────────────────────────────────────────────────
 * 你是 PolyPulse 的外部话题发现运行时。
 * 当前 provider：codex
 * 必须先阅读这些 skill 文件：
 * - <skill id>: <skill SKILL.md path>
 *
 * 当前 Polymarket 市场状态摘要：
 * - 活跃市场数量：<N>
 * - 已覆盖类别：<categories>
 * - 最近已发现话题（避免重复）：<topics>
 *
 * 任务：
 * 基于你对当前新闻、体育赛事、宏观经济日历、加密市场动态、政治事件和科技发展的知识，
 * 提出 5-10 个可能在 Polymarket 有对应市场但可能被规则预筛遗漏的话题。
 *
 * 每个话题需要包含：
 * 1. topic: 话题简要描述
 * 2. category: 分类（politics, sports, crypto, tech, finance, economics, weather, culture, geopolitics, other）
 * 3. signal_source: 信号来源类型（news, social_media, sports_data, macro_calendar, on_chain, regulatory, other）
 * 4. rationale: 为什么这个话题可能有交易价值（市场可能低估/高估的原因）
 * 5. search_terms: 用于在 Polymarket 搜索对应市场的关键词列表
 * 6. urgency: 紧迫性（high=即将结算, medium=近期相关, low=长期趋势）
 * 7. confidence: 你对这个话题有交易价值的信心（low/medium/high）
 *
 * 硬规则：
 * 1. 只能输出合法 JSON。
 * 2. 不允许输出交易指令、token、仓位金额或 broker 参数。
 * 3. 不允许编造事实；只推荐你有合理理由相信存在 edge 的话题。
 * 4. 优先推荐有明确、可验证外部信号的话题（如赛程、日历事件、已公布数据）。
 * 5. 避免推荐太随机或纯粹依赖内幕信息的话题。
 *
 * 只输出最终 JSON。
 * ─────────────────────────────────────────────────────────────────
 *
 * Key properties:
 * - Provider may ONLY output topic suggestions with categories and rationale
 * - Provider CANNOT output broker parameters, trade instructions, or orders
 * - Each suggested topic includes: topic text, category, signal source, rationale,
 *   and suggested Polymarket search terms
 * - Topics are then matched against the full Polymarket market list to find
 *   opportunities not covered by the standard rule-based scan
 * - Timeout-protected (default 60s); on failure, returns empty list (no blocking)
 * - Works with both codex and claude-code providers
 *
 * This enables the system to find markets that rule-based scanning might miss,
 * particularly markets in emerging categories or markets driven by breaking news.
 */

import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveEffectiveProvider, resolveCodexSkillSettings } from "./codex-skill-settings.js";
import { resolveClaudeSkillSettings } from "./claude-skill-settings.js";
import { codexRuntimeInternals } from "./codex-runtime.js";
import { claudeRuntimeInternals } from "./claude-runtime.js";

const { runCodex } = codexRuntimeInternals;
const { runClaude } = claudeRuntimeInternals;

function isChineseLocale(locale) {
  return locale === "zh";
}

function buildTopicDiscoverySchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["discovered_topics"],
    properties: {
      discovered_topics: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["topic", "category", "signal_source", "rationale", "search_terms", "urgency", "confidence"],
          properties: {
            topic: { type: "string", minLength: 1 },
            category: { type: "string", enum: ["politics", "sports", "crypto", "tech", "finance", "economics", "weather", "culture", "geopolitics", "other"] },
            signal_source: { type: "string", minLength: 1 },
            rationale: { type: "string", minLength: 1 },
            search_terms: {
              type: "array",
              items: { type: "string" },
              minItems: 1
            },
            urgency: { type: "string", enum: ["low", "medium", "high"] },
            confidence: { type: "string", enum: ["low", "medium", "high"] }
          }
        }
      }
    }
  };
}

function buildPrompt({ settings, currentCategories, currentMarketCount, recentTopics }) {
  const localeIsChinese = isChineseLocale(settings.locale);
  const skillLines = settings.skills.map((skill) => `- ${skill.id}: ${skill.skillFile}`);

  if (localeIsChinese) {
    return [
      "你是 PolyPulse 的外部话题发现运行时。",
      `当前 provider：${settings.provider}`,
      "必须先阅读这些 skill 文件：",
      ...skillLines,
      "",
      "当前 Polymarket 市场状态摘要：",
      `- 活跃市场数量：${currentMarketCount}`,
      `- 已覆盖类别：${currentCategories.join(", ")}`,
      recentTopics.length > 0 ? `- 最近已发现话题（避免重复）：${recentTopics.join("; ")}` : "",
      "",
      "任务：",
      "基于你对当前新闻、体育赛事、宏观经济日历、加密市场动态、政治事件和科技发展的知识，",
      "提出 5-10 个可能在 Polymarket 有对应市场但可能被规则预筛遗漏的话题。",
      "",
      "每个话题需要包含：",
      "1. topic: 话题简要描述",
      "2. category: 分类（politics, sports, crypto, tech, finance, economics, weather, culture, geopolitics, other）",
      "3. signal_source: 信号来源类型（news, social_media, sports_data, macro_calendar, on_chain, regulatory, other）",
      "4. rationale: 为什么这个话题可能有交易价值（市场可能低估/高估的原因）",
      "5. search_terms: 用于在 Polymarket 搜索对应市场的关键词列表",
      "6. urgency: 紧迫性（high=即将结算, medium=近期相关, low=长期趋势）",
      "7. confidence: 你对这个话题有交易价值的信心（low/medium/high）",
      "",
      "硬规则：",
      "1. 只能输出合法 JSON。",
      "2. 不允许输出交易指令、token、仓位金额或 broker 参数。",
      "3. 不允许编造事实；只推荐你有合理理由相信存在 edge 的话题。",
      "4. 优先推荐有明确、可验证外部信号的话题（如赛程、日历事件、已公布数据）。",
      "5. 避免推荐太随机或纯粹依赖内幕信息的话题。",
      "",
      "只输出最终 JSON。"
    ].filter(Boolean).join("\n");
  }

  return [
    "You are the external topic discovery runtime for PolyPulse, a Polymarket analysis system.",
    `Active provider: ${settings.provider}`,
    "Read these selected skill files:",
    ...skillLines,
    "",
    "Current Polymarket state summary:",
    `- Active market count: ${currentMarketCount}`,
    `- Covered categories: ${currentCategories.join(", ")}`,
    recentTopics.length > 0 ? `- Recently discovered topics (avoid duplicates): ${recentTopics.join("; ")}` : "",
    "",
    "Task:",
    "Based on your knowledge of current news, sports events, macro economic calendar,",
    "crypto market dynamics, political events, and tech developments, propose 5-10 topics",
    "that likely have corresponding Polymarket markets but may be missed by rule-based scanning.",
    "",
    "Each topic must include:",
    "1. topic: Brief topic description",
    "2. category: One of politics, sports, crypto, tech, finance, economics, weather, culture, geopolitics, other",
    "3. signal_source: Signal source type (news, social_media, sports_data, macro_calendar, on_chain, regulatory, other)",
    "4. rationale: Why this topic may have trading value (reason market may be mispriced)",
    "5. search_terms: Keywords to search for matching Polymarket markets",
    "6. urgency: high (resolving soon), medium (near-term relevant), low (long-term trend)",
    "7. confidence: Your confidence this topic has trading value (low/medium/high)",
    "",
    "Hard rules:",
    "1. Output valid JSON only.",
    "2. Do not output trade instructions, tokens, sizing, or broker parameters.",
    "3. Do not fabricate facts; only recommend topics where you have reasonable basis to believe edge exists.",
    "4. Prefer topics with clear, verifiable external signals (schedules, calendar events, published data).",
    "5. Avoid topics that are too random or depend on insider information.",
    "",
    "Output final JSON only."
  ].filter(Boolean).join("\n");
}

function extractJsonPayload(text) {
  const trimmed = String(text ?? "").trim();
  const candidates = [trimmed];
  if (trimmed.startsWith("```")) {
    const lines = trimmed.split("\n");
    if (lines.length >= 3) {
      candidates.push(lines.slice(1, -1).join("\n").trim());
    }
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try next strategy
    }
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
  }
  throw new Error("Topic discovery output did not contain valid JSON.");
}

function normalizeTopic(item) {
  const validCategories = ["politics", "sports", "crypto", "tech", "finance", "economics", "weather", "culture", "geopolitics", "other"];
  const validUrgency = ["low", "medium", "high"];
  const validConfidence = ["low", "medium", "high"];
  return {
    topic: String(item?.topic ?? "").trim(),
    category: validCategories.includes(item?.category) ? item.category : "other",
    signal_source: String(item?.signal_source ?? "other").trim(),
    rationale: String(item?.rationale ?? "").trim(),
    search_terms: Array.isArray(item?.search_terms) ? item.search_terms.map(String).filter(Boolean) : [],
    urgency: validUrgency.includes(item?.urgency) ? item.urgency : "medium",
    confidence: validConfidence.includes(item?.confidence) ? item.confidence : "low"
  };
}

export class TopicDiscoveryProvider {
  constructor(config = {}) {
    this.config = config;
    this.enabled = config.pulse?.aiTopicDiscovery !== false;
    this.timeoutMs = config.pulse?.topicDiscoveryTimeoutMs ?? 60000;
  }

  async discover({ currentCategories = [], currentMarketCount = 0, recentTopics = [] } = {}) {
    if (!this.enabled) {
      return { discovered_topics: [], failed: false, skipped: true };
    }

    const provider = resolveEffectiveProvider(this.config);
    const settings = provider === "claude-code"
      ? resolveClaudeSkillSettings(this.config)
      : resolveCodexSkillSettings(this.config);
    const repoRoot = path.resolve(this.config.repoRoot ?? process.cwd());
    const tempDir = await mkdtemp(path.join(tmpdir(), "polypulse-topic-"));
    const outputPath = path.join(tempDir, "provider-output.json");
    const schemaPath = path.join(tempDir, "topic-discovery.schema.json");
    let preserveTempDir = false;

    try {
      const prompt = buildPrompt({ settings, currentCategories, currentMarketCount, recentTopics });
      await writeFile(schemaPath, JSON.stringify(buildTopicDiscoverySchema(), null, 2), "utf8");

      const timeoutMs = this.timeoutMs;

      if (provider === "claude-code") {
        await runClaude({ prompt, settings, repoRoot, tempDir, outputPath, schemaPath, timeoutMs });
      } else if (provider === "codex") {
        await runCodex({ prompt, settings, repoRoot, tempDir, outputPath, schemaPath, timeoutMs, maxRetries: this.config.providerMaxRetries });
      } else {
        throw new Error(`unsupported_topic_discovery_provider: ${provider}`);
      }

      const rawOutput = await readFile(outputPath, "utf8");
      const payload = extractJsonPayload(rawOutput);
      const topics = Array.isArray(payload?.discovered_topics)
        ? payload.discovered_topics.map(normalizeTopic).filter((t) => t.topic && t.search_terms.length > 0)
        : [];

      return {
        discovered_topics: topics,
        failed: false,
        skipped: false,
        provider,
        elapsedMs: Date.now() - Date.parse(new Date().toISOString())
      };
    } catch (error) {
      preserveTempDir = true;
      const message = error instanceof Error ? error.message : String(error);
      return {
        discovered_topics: [],
        failed: true,
        skipped: false,
        failureReason: message,
        provider
      };
    } finally {
      if (!preserveTempDir && existsSync(tempDir)) {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  }
}

export const topicDiscoveryInternals = {
  buildTopicDiscoverySchema,
  buildPrompt,
  normalizeTopic,
  extractJsonPayload
};
