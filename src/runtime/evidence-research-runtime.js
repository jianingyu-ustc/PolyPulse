/**
 * EvidenceResearchRuntime
 *
 * AI-guided evidence research: after rule-based adapters collect base evidence,
 * this runtime asks the AI provider to assess evidence sufficiency, identify
 * specific information gaps, and direct further search queries.
 *
 * Aligns with Predict-Raven's AI-driven research pipeline where AI actively
 * guides the evidence collection process rather than passively receiving
 * whatever adapters find.
 *
 * 提示词模板（zh locale 示例，由 buildPrompt() 动态生成）：
 * ─────────────────────────────────────────────────────────────────
 * 你是 PolyPulse 的 AI 证据研究运行时。
 * 当前 provider：codex
 * 必须先阅读这些 skill 文件，再进行研究分析：
 * - <skill id>: <skill SKILL.md path>
 *
 * 必须先阅读这份风险控制文档：
 * - <repoRoot>/docs/specs/risk-controls.md
 *
 * 只允许阅读上面列出的 skill 文件、这份风险文档、输入 JSON 文件和下面给出的结构化上下文。
 * 不要扫描无关仓库文件，不要运行测试，不要做代码修改，不要尝试下单，不要抓取外部网页。
 *
 * 输入文件：
 * - Market JSON: <tempDir>/market.json
 * - Evidence JSON: <tempDir>/evidence.json
 *
 * 市场快照：
 * <market JSON>
 *
 * 已收集的证据：
 * <evidence summary JSON>
 *
 * Triage 评估：
 * <triage JSON 或 "无">
 *
 * 任务：
 * 1. 评估已收集证据的质量、相关性、新鲜度和充分性，用于估算该市场结算概率。
 * 2. 识别具体信息缺口——如果填补这些缺口，能显著改善概率估算。
 * 3. 对每个缺口，提出一个具体的网络搜索查询，能找到相关且可信的信息。
 * 4. 评定证据整体充分性："sufficient"/"needs_more"/"critical_gap"。
 * 5. 总结现有证据中与概率估算最相关的关键发现。
 *
 * 硬规则：
 * 1. 只能输出合法 JSON，不要输出 markdown 代码块。
 * 2. 不允许编造证据或搜索结果。
 * 3. 不允许估算概率——概率由后续的概率估算运行时负责。
 * 4. 不允许输出交易指令、token 改写、仓位金额或 broker 参数。
 * 5. directed_searches 必须是具体可执行的搜索查询，不能是模糊主题。
 * 6. 最多 5 个定向搜索，按预期信息价值排优先级（1=最高优先级）。
 * 7. 每个搜索必须包含清晰的 rationale，说明搜索什么信息以及为什么重要。
 *
 * 输出字段：
 * - research_strategy, evidence_assessment, evidence_sufficiency,
 *   key_findings, directed_searches
 * 只输出最终 JSON。
 * ─────────────────────────────────────────────────────────────────
 *
 * Key properties:
 * - AI assesses quality, relevance, freshness, sufficiency of collected evidence
 * - AI identifies specific information gaps that would improve probability estimation
 * - AI outputs directed search queries (≤5) with category, rationale, and priority
 * - AI does NOT estimate probabilities or output trade instructions
 * - Timeout-protected (default 60s); on failure, caller falls back to legacy gap-fill
 * - Works with both codex and claude-code providers
 */

import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { redactSecrets } from "../config/env.js";
import { resolveEffectiveProvider, resolveCodexSkillSettings } from "./codex-skill-settings.js";
import { resolveClaudeSkillSettings } from "./claude-skill-settings.js";
import { codexRuntimeInternals } from "./codex-runtime.js";
import { claudeRuntimeInternals } from "./claude-runtime.js";

const { runCodex } = codexRuntimeInternals;
const { runClaude } = claudeRuntimeInternals;

function timestampId(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function isChineseLocale(locale) {
  return locale === "zh";
}

function truncate(text, maxChars = 24000) {
  const value = String(text ?? "");
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 24))}\n\n... truncated ...\n`;
}

function stripCodeFences(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }
  const lines = trimmed.split("\n");
  return lines.length >= 3 ? lines.slice(1, -1).join("\n").trim() : trimmed;
}

function extractJsonPayload(text) {
  const candidates = [
    String(text ?? "").trim(),
    stripCodeFences(text)
  ];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next parse strategy.
    }
  }
  const value = String(text ?? "");
  const firstBrace = value.indexOf("{");
  const lastBrace = value.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return JSON.parse(value.slice(firstBrace, lastBrace + 1));
  }
  throw new Error("Provider output did not contain a valid EvidenceResearch JSON payload.");
}

function buildEvidenceResearchSchema() {
  const directedSearchSchema = {
    type: "object",
    additionalProperties: false,
    required: ["query", "category", "rationale", "priority"],
    properties: {
      query: { type: "string", minLength: 5 },
      category: {
        type: "string",
        enum: ["news", "social", "expert", "official", "schedule", "financial", "on-chain", "weather", "general"]
      },
      rationale: { type: "string", minLength: 10 },
      priority: { type: "number", minimum: 1, maximum: 5 }
    }
  };

  return {
    type: "object",
    additionalProperties: false,
    required: [
      "research_strategy",
      "evidence_assessment",
      "evidence_sufficiency",
      "key_findings",
      "directed_searches"
    ],
    properties: {
      research_strategy: { type: "string", minLength: 10 },
      evidence_assessment: { type: "string", minLength: 10 },
      evidence_sufficiency: {
        type: "string",
        enum: ["sufficient", "needs_more", "critical_gap"]
      },
      key_findings: {
        type: "array",
        items: { type: "string" }
      },
      directed_searches: {
        type: "array",
        items: directedSearchSchema,
        maxItems: 5
      }
    }
  };
}

function marketSnapshot(market) {
  return {
    marketId: market.marketId,
    marketSlug: market.marketSlug,
    eventId: market.eventId,
    eventSlug: market.eventSlug,
    question: market.question,
    outcomes: (market.outcomes ?? []).map((outcome) => ({
      label: outcome.label,
      impliedProbability: outcome.impliedProbability ?? outcome.lastPrice ?? outcome.bestAsk ?? outcome.bestBid ?? null,
      bestBid: outcome.bestBid ?? null,
      bestAsk: outcome.bestAsk ?? null
    })),
    endDate: market.endDate,
    liquidityUsd: market.liquidityUsd,
    volumeUsd: market.volumeUsd,
    volume24hUsd: market.volume24hUsd,
    category: market.category,
    tags: market.tags,
    resolutionSource: market.resolutionSource,
    resolutionRules: market.resolutionRules,
    active: market.active,
    closed: market.closed,
    tradable: market.tradable
  };
}

function evidenceSummary(evidence) {
  const items = Array.isArray(evidence) ? evidence : (evidence?.items ?? []);
  return items.map((item) => ({
    source: item.source,
    title: item.title,
    summary: String(item.summary ?? "").slice(0, 500),
    status: item.status,
    credibility: item.credibility,
    relevanceScore: item.relevanceScore,
    retrievedAt: item.retrievedAt
  }));
}

function buildPrompt({ market, evidence, triage, settings, riskDocPath, marketPath, evidencePath }) {
  const skillLines = settings.skills.map((skill) => `- ${skill.id}: ${skill.skillFile}`);
  const localeIsChinese = isChineseLocale(settings.locale);
  const marketData = JSON.stringify(marketSnapshot(market), null, 2);
  const evidenceData = JSON.stringify(evidenceSummary(evidence), null, 2);
  const triageData = triage ? JSON.stringify(triage, null, 2) : (localeIsChinese ? "无" : "none");

  if (localeIsChinese) {
    return [
      "你是 PolyPulse 的 AI 证据研究运行时。",
      `当前 provider：${settings.provider}`,
      "必须先阅读这些 skill 文件，再进行研究分析：",
      ...skillLines,
      "",
      "必须先阅读这份风险控制文档：",
      `- ${riskDocPath}`,
      "",
      "只允许阅读上面列出的 skill 文件、这份风险文档、输入 JSON 文件和下面给出的结构化上下文。",
      "不要扫描无关仓库文件，不要运行测试，不要做代码修改，不要尝试下单，不要抓取外部网页。",
      "",
      "输入文件：",
      `- Market JSON: ${marketPath}`,
      `- Evidence JSON: ${evidencePath}`,
      "",
      "市场快照：",
      marketData,
      "",
      "已收集的证据：",
      evidenceData,
      "",
      "Triage 评估：",
      triageData,
      "",
      "任务：",
      "1. 评估已收集证据的质量、相关性、新鲜度和充分性，用于估算该市场结算概率。",
      "2. 识别具体信息缺口——如果填补这些缺口，能显著改善概率估算。",
      "3. 对每个缺口，提出一个具体的网络搜索查询，能找到相关且可信的信息。",
      "4. 评定证据整体充分性：\"sufficient\"（足够进行置信估算）、\"needs_more\"（可以估算但不确定性高）或 \"critical_gap\"（缺少关键信息，可能大幅改变估算）。",
      "5. 总结现有证据中与概率估算最相关的关键发现。",
      "",
      "硬规则：",
      "1. 只能输出合法 JSON，不要输出 markdown 代码块。",
      "2. 不允许编造证据或搜索结果。",
      "3. 不允许估算概率——概率由后续的概率估算运行时负责。",
      "4. 不允许输出交易指令、token 改写、仓位金额或 broker 参数。",
      "5. directed_searches 必须是具体可执行的搜索查询，不能是模糊主题。",
      "6. 最多 5 个定向搜索，按预期信息价值排优先级（1=最高优先级）。",
      "7. 每个搜索必须包含清晰的 rationale，说明搜索什么信息以及为什么重要。",
      "",
      "输出字段：",
      "- research_strategy: 你的研究策略和思路（简述）",
      "- evidence_assessment: 对现有证据的整体评价",
      "- evidence_sufficiency: sufficient | needs_more | critical_gap",
      "- key_findings: 现有证据中最相关的关键发现列表",
      "- directed_searches: 定向搜索列表，每项含 query, category, rationale, priority",
      "",
      "只输出最终 JSON。"
    ].join("\n");
  }

  return [
    "You are the AI evidence research runtime for PolyPulse, a Polymarket analysis system.",
    `Active provider: ${settings.provider}`,
    "Read these selected skill files before conducting research:",
    ...skillLines,
    "",
    "Read this risk control document:",
    `- ${riskDocPath}`,
    "",
    "Only inspect the listed skill files, this risk document, the input JSON files, and the structured context below.",
    "Do not scan unrelated repository files, do not run tests, do not modify code, do not place orders, and do not fetch external webpages.",
    "",
    "Input files:",
    `- Market JSON: ${marketPath}`,
    `- Evidence JSON: ${evidencePath}`,
    "",
    "Market snapshot:",
    marketData,
    "",
    "Evidence collected so far:",
    evidenceData,
    "",
    "Triage assessment:",
    triageData,
    "",
    "Task:",
    "1. Assess the quality, relevance, freshness, and sufficiency of the collected evidence for estimating the probability of this market's resolution.",
    "2. Identify specific information gaps that, if filled, would materially improve probability estimation.",
    "3. For each gap, propose a specific web search query that would likely find relevant, credible information.",
    "4. Rate the overall evidence sufficiency: \"sufficient\" (enough for confident estimate), \"needs_more\" (estimate possible but uncertain), or \"critical_gap\" (key information missing that could change estimate dramatically).",
    "5. Summarize key findings from existing evidence that are most relevant to probability estimation.",
    "",
    "Hard rules:",
    "1. Output valid JSON only. Do not wrap it in markdown fences.",
    "2. Do not fabricate evidence or search results.",
    "3. Do not estimate probabilities - that is handled by the probability estimation runtime.",
    "4. Do not output trade instructions, token rewrites, sizing, or broker parameters.",
    "5. directed_searches must be specific, actionable search queries - not vague topics.",
    "6. Maximum 5 directed searches, prioritized by expected information value (1 = highest priority).",
    "7. Each search must include a clear rationale explaining what information it targets and why it matters.",
    "",
    "Output fields:",
    "- research_strategy: Your research approach and reasoning (brief)",
    "- evidence_assessment: Overall evaluation of existing evidence",
    "- evidence_sufficiency: sufficient | needs_more | critical_gap",
    "- key_findings: List of most relevant findings from existing evidence",
    "- directed_searches: Directed search list, each with query, category, rationale, priority",
    "",
    "Output final JSON only."
  ].join("\n");
}

async function archiveRuntimeLog({ config, settings, rawOutput, prompt, tempDir, outputPath }) {
  const artifactDir = path.join(config.artifactDir, "evidence-research-runtime", timestampId());
  await mkdir(artifactDir, { recursive: true });
  const logPath = path.join(artifactDir, "runtime-log.md");
  const zh = isChineseLocale(settings.locale);
  const content = truncate([
    zh ? "# AI 证据研究运行时日志" : "# AI Evidence Research Runtime Log",
    "",
    zh ? `Provider：${settings.provider}` : `Provider: ${settings.provider}`,
    zh ? `Locale：${settings.locale}` : `Locale: ${settings.locale}`,
    zh ? `Model：${settings.model || "default"}` : `Model: ${settings.model || "default"}`,
    zh ? `Temp：${tempDir}` : `Temp: ${tempDir}`,
    zh ? `Output：${outputPath}` : `Output: ${outputPath}`,
    "",
    "## Prompt",
    "",
    "```text",
    prompt,
    "```",
    "",
    zh ? "## Provider 原始输出" : "## Raw Provider Output",
    "",
    "```json",
    rawOutput.trim(),
    "```"
  ].join("\n"), config.pulse?.maxMarkdownChars ?? 24000);
  await writeFile(logPath, content, "utf8");
  return {
    kind: "evidence-research-runtime-log",
    path: path.relative(process.cwd(), logPath),
    publishedAt: new Date().toISOString()
  };
}

function normalizeResearchPayload(payload, { provider, runtimeLog, model, maxSearches }) {
  const validCategories = ["news", "social", "expert", "official", "schedule", "financial", "on-chain", "weather", "general"];
  const directedSearches = Array.isArray(payload?.directed_searches)
    ? payload.directed_searches
        .filter((s) => s && typeof s === "object" && typeof s.query === "string" && s.query.length >= 5)
        .slice(0, maxSearches)
        .map((s) => ({
          query: String(s.query),
          category: validCategories.includes(s.category) ? s.category : "general",
          rationale: String(s.rationale ?? ""),
          priority: Math.max(1, Math.min(5, Number(s.priority) || 3))
        }))
    : [];

  return {
    research_strategy: String(payload?.research_strategy ?? ""),
    evidence_assessment: String(payload?.evidence_assessment ?? ""),
    evidence_sufficiency: ["sufficient", "needs_more", "critical_gap"].includes(payload?.evidence_sufficiency)
      ? payload.evidence_sufficiency : "needs_more",
    key_findings: Array.isArray(payload?.key_findings) ? payload.key_findings.map(String) : [],
    directed_searches: directedSearches,
    diagnostics: {
      provider,
      effectiveProvider: provider,
      runtime: "evidence-research-runtime",
      model: model || provider,
      artifact: runtimeLog.path,
      generatedAt: new Date().toISOString(),
      promptTemplate: "src/runtime/evidence-research-runtime.js#buildPrompt"
    }
  };
}

export class EvidenceResearchProvider {
  constructor(config = {}) {
    this.config = config;
    this.timeoutMs = config.pulse?.evidenceResearchTimeoutMs ?? 60000;
    this.maxSearches = config.pulse?.evidenceResearchMaxSearches ?? 5;
    this.enabled = config.pulse?.aiEvidenceResearch !== false;
  }

  async research({ market, evidence, triage = null }) {
    if (!this.enabled) {
      return null;
    }

    const provider = resolveEffectiveProvider(this.config);
    const settings = provider === "claude-code"
      ? resolveClaudeSkillSettings(this.config)
      : resolveCodexSkillSettings(this.config);
    const repoRoot = path.resolve(this.config.repoRoot ?? process.cwd());
    const riskDocPath = path.resolve(repoRoot, "docs", "specs", "risk-controls.md");
    const tempDir = await mkdtemp(path.join(tmpdir(), "polypulse-evidence-research-"));
    const outputPath = path.join(tempDir, "provider-output.json");
    const promptPath = path.join(tempDir, "provider-prompt.txt");
    const schemaPath = path.join(tempDir, "evidence-research.schema.json");
    const marketPath = path.join(tempDir, "market.json");
    const evidencePath = path.join(tempDir, "evidence.json");
    const timeoutMs = this.timeoutMs;
    let preserveTempDir = false;

    try {
      await writeFile(marketPath, JSON.stringify(redactSecrets(marketSnapshot(market)), null, 2), "utf8");
      await writeFile(evidencePath, JSON.stringify(redactSecrets(evidenceSummary(evidence)), null, 2), "utf8");
      const prompt = buildPrompt({ market, evidence, triage, settings, riskDocPath, marketPath, evidencePath });
      await writeFile(promptPath, prompt, "utf8");
      await writeFile(schemaPath, JSON.stringify(buildEvidenceResearchSchema(), null, 2), "utf8");

      if (provider === "claude-code") {
        await runClaude({ prompt, settings, repoRoot, tempDir, outputPath, schemaPath, timeoutMs });
      } else if (provider === "codex") {
        await runCodex({ prompt, settings, repoRoot, tempDir, outputPath, schemaPath, timeoutMs });
      } else {
        throw new Error(`unsupported_evidence_research_provider: ${provider}`);
      }

      const rawOutput = await readFile(outputPath, "utf8");
      const payload = extractJsonPayload(rawOutput);
      const runtimeLog = this.config.suppressProviderRuntimeArtifacts
        ? { path: null }
        : await archiveRuntimeLog({ config: this.config, settings, rawOutput, prompt, tempDir, outputPath });

      return normalizeResearchPayload(payload, {
        provider,
        runtimeLog,
        model: settings.model || "",
        maxSearches: this.maxSearches
      });
    } catch (error) {
      preserveTempDir = true;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}\n\nEvidence research runtime temp preserved at ${tempDir}`, { cause: error });
    } finally {
      if (!preserveTempDir) {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  }
}

export const evidenceResearchRuntimeInternals = {
  buildEvidenceResearchSchema,
  buildPrompt,
  extractJsonPayload,
  normalizeResearchPayload,
  marketSnapshot,
  evidenceSummary
};
