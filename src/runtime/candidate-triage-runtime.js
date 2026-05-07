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
  throw new Error("Provider output did not contain a valid CandidateTriage JSON payload.");
}

function buildCandidateTriageSchema() {
  const assessmentSchema = {
    type: "object",
    additionalProperties: false,
    required: [
      "marketId",
      "marketSlug",
      "recommended_action",
      "priority_score",
      "researchability",
      "information_advantage",
      "cluster",
      "rationale",
      "evidence_gaps"
    ],
    properties: {
      marketId: { type: "string" },
      marketSlug: { type: "string" },
      recommended_action: { type: "string", enum: ["prioritize", "watch", "defer", "reject"] },
      priority_score: { type: "number", minimum: 0, maximum: 1 },
      researchability: { type: "string", enum: ["low", "medium", "high"] },
      information_advantage: { type: "string", enum: ["low", "medium", "high"] },
      cluster: { type: "string" },
      rationale: { type: "string" },
      evidence_gaps: {
        type: "array",
        items: { type: "string" }
      }
    }
  };
  const clusterSchema = {
    type: "object",
    additionalProperties: false,
    required: ["name", "marketIds", "rationale"],
    properties: {
      name: { type: "string" },
      marketIds: {
        type: "array",
        items: { type: "string" }
      },
      rationale: { type: "string" }
    }
  };
  return {
    type: "object",
    additionalProperties: false,
    required: ["candidate_assessments", "clusters", "research_gaps"],
    properties: {
      candidate_assessments: {
        type: "array",
        items: assessmentSchema
      },
      clusters: {
        type: "array",
        items: clusterSchema
      },
      research_gaps: {
        type: "array",
        items: { type: "string" }
      }
    }
  };
}

function candidateSnapshot(market) {
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
    active: market.active,
    closed: market.closed,
    tradable: market.tradable,
    riskFlags: market.riskFlags
  };
}

function buildPrompt({ candidates, context, settings, riskDocPath, candidatesPath }) {
  const skillLines = settings.skills.map((skill) => `- ${skill.id}: ${skill.skillFile}`);
  const localeIsChinese = isChineseLocale(settings.locale);
  const snapshots = candidates.map(candidateSnapshot);
  const contextSnapshot = {
    strategy: context.strategy ?? "pulse-direct",
    maxCandidates: context.maxCandidates ?? null,
    maxTradesPerRound: context.maxTradesPerRound ?? null,
    minLiquidityUsd: context.minLiquidityUsd ?? null,
    source: context.source ?? "polymarket-gamma"
  };

  if (localeIsChinese) {
    return [
      "你是 PolyPulse 的 Polymarket 候选市场 triage 运行时。",
      `当前 provider：${settings.provider}`,
      "必须先阅读这些 skill 文件，再做候选 triage：",
      ...skillLines,
      "",
      "必须先阅读这份风险控制文档：",
      `- ${riskDocPath}`,
      "",
      "只允许阅读上面列出的 skill 文件、这份风险文档、输入 JSON 文件和下面给出的结构化上下文。",
      "不要扫描无关仓库文件，不要运行测试，不要做代码修改，不要尝试下单，不要抓取外部网页。",
      "",
      "输入文件：",
      `- Candidates JSON: ${candidatesPath}`,
      "",
      "运行上下文：",
      JSON.stringify(contextSnapshot),
      "",
      "候选市场快照：",
      JSON.stringify(snapshots),
      "",
      "任务：",
      "1. 对规则预筛后的候选做语义聚类、主题优先级和候选解释。",
      "2. 判断每个候选是否可研究、是否可能有独立外部证据、相对盘口是否可能存在信息优势。",
      "3. 输出每个候选的 recommended_action：prioritize、watch、defer 或 reject。",
      "4. reject 只能用于结算问题模糊、不可研究、明显缺少独立外部证据或信息优势很低的候选。",
      "5. 为每个候选列出 evidence_gaps；这些是后续应该补充的外部信号类别，不是你编造出来的证据。",
      "",
      "硬规则：",
      "1. 只能输出合法 JSON，不要输出 markdown 代码块。",
      "2. 不允许编造事实、概率或证据。",
      "3. 不允许输出交易方向、token、仓位金额、broker 参数或订单。",
      "4. 不要直接估算 ai_probability；单市场概率估算由后续 ProbabilityEstimate runtime 完成。",
      "5. priority_score 只表示研究/执行优先级，不是交易信号。",
      "",
      "输出字段必须匹配 CandidateTriage provider schema：",
      "- candidate_assessments",
      "- clusters",
      "- research_gaps",
      "只输出最终 JSON。"
    ].join("\n");
  }

  return [
    "You are the candidate-market triage runtime for PolyPulse, a Polymarket analysis system.",
    `Active provider: ${settings.provider}`,
    "Read these selected skill files before triaging candidates:",
    ...skillLines,
    "",
    "Read this risk control document before triaging:",
    `- ${riskDocPath}`,
    "",
    "Only inspect the listed skill files, this risk document, the input JSON file, and the structured context below.",
    "Do not scan unrelated repository files, do not run tests, do not modify code, do not place orders, and do not fetch external webpages.",
    "",
    "Input files:",
    `- Candidates JSON: ${candidatesPath}`,
    "",
    "Runtime context:",
    JSON.stringify(contextSnapshot),
    "",
    "Candidate market snapshots:",
    JSON.stringify(snapshots),
    "",
    "Task:",
    "1. Perform semantic clustering, theme priority, and candidate explanation over the rule-prefiltered candidates.",
    "2. Judge whether each candidate is researchable, whether independent external evidence is likely available, and whether there may be information advantage versus the market price.",
    "3. Output each candidate's recommended_action: prioritize, watch, defer, or reject.",
    "4. Use reject only when resolution is vague, the market is unresearchable, independent external evidence is clearly lacking, or information advantage is very low.",
    "5. List evidence_gaps for each candidate; these are external signal categories to collect later, not fabricated evidence.",
    "",
    "Hard rules:",
    "1. Output valid JSON only. Do not wrap it in markdown fences.",
    "2. Do not fabricate facts, probabilities, or evidence.",
    "3. Do not output trade side, token, sizing, broker parameters, or orders.",
    "4. Do not estimate ai_probability directly; the per-market ProbabilityEstimate runtime handles probabilities later.",
    "5. priority_score is research/execution priority only, not a trading signal.",
    "",
    "The output must match the CandidateTriage provider schema:",
    "- candidate_assessments",
    "- clusters",
    "- research_gaps",
    "Output final JSON only."
  ].join("\n");
}

async function archiveRuntimeLog({ config, settings, rawOutput, prompt, tempDir, outputPath }) {
  if (config.suppressProviderRuntimeArtifacts) {
    return { path: null };
  }
  const artifactDir = path.join(config.artifactDir, "candidate-triage-runtime", timestampId());
  await mkdir(artifactDir, { recursive: true });
  const logPath = path.join(artifactDir, "runtime-log.md");
  const zh = isChineseLocale(settings.locale);
  const content = truncate([
    zh ? "# Candidate Triage Runtime 日志" : "# Candidate Triage Runtime Log",
    "",
    zh ? `Provider：${settings.provider}` : `Provider: ${settings.provider}`,
    zh ? `Locale：${settings.locale}` : `Locale: ${settings.locale}`,
    zh ? `Model：${settings.model || "default"}` : `Model: ${settings.model || "default"}`,
    zh ? `Temp：${tempDir}` : `Temp: ${tempDir}`,
    zh ? `Output：${outputPath}` : `Output: ${outputPath}`,
    "",
    zh ? "## Prompt" : "## Prompt",
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
    kind: "candidate-triage-runtime-log",
    path: path.relative(process.cwd(), logPath),
    publishedAt: new Date().toISOString()
  };
}

function normalizeAssessment(item) {
  return {
    marketId: String(item?.marketId ?? ""),
    marketSlug: String(item?.marketSlug ?? ""),
    recommended_action: ["prioritize", "watch", "defer", "reject"].includes(item?.recommended_action)
      ? item.recommended_action
      : "watch",
    priority_score: Math.max(0, Math.min(1, Number(item?.priority_score ?? 0))),
    researchability: ["low", "medium", "high"].includes(item?.researchability) ? item.researchability : "low",
    information_advantage: ["low", "medium", "high"].includes(item?.information_advantage) ? item.information_advantage : "low",
    cluster: String(item?.cluster ?? "uncategorized"),
    rationale: String(item?.rationale ?? ""),
    evidence_gaps: Array.isArray(item?.evidence_gaps) ? item.evidence_gaps.map(String) : []
  };
}

function normalizeTriagePayload(payload, { provider, runtimeLog, model }) {
  const assessments = Array.isArray(payload?.candidate_assessments)
    ? payload.candidate_assessments.map(normalizeAssessment)
    : [];
  return {
    candidate_assessments: assessments,
    clusters: Array.isArray(payload?.clusters) ? payload.clusters : [],
    research_gaps: Array.isArray(payload?.research_gaps) ? payload.research_gaps.map(String) : [],
    diagnostics: {
      provider,
      effectiveProvider: provider,
      runtime: "candidate-triage-runtime",
      model: model || provider,
      artifact: runtimeLog.path,
      generatedAt: new Date().toISOString(),
      promptTemplate: "src/runtime/candidate-triage-runtime.js#buildPrompt"
    }
  };
}

export class CandidateTriageProvider {
  constructor(config = {}) {
    this.config = config;
  }

  async triage({ candidates, context = {} }) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return normalizeTriagePayload({ candidate_assessments: [], clusters: [], research_gaps: [] }, {
        provider: resolveEffectiveProvider(this.config),
        runtimeLog: { path: null },
        model: ""
      });
    }

    const provider = resolveEffectiveProvider(this.config);
    const settings = provider === "claude-code"
      ? resolveClaudeSkillSettings(this.config)
      : resolveCodexSkillSettings(this.config);
    const repoRoot = path.resolve(this.config.repoRoot ?? process.cwd());
    const riskDocPath = path.resolve(repoRoot, "docs", "specs", "risk-controls.md");
    const tempDir = await mkdtemp(path.join(tmpdir(), "polypulse-triage-"));
    const outputPath = path.join(tempDir, "provider-output.json");
    const promptPath = path.join(tempDir, "provider-prompt.txt");
    const schemaPath = path.join(tempDir, "candidate-triage.schema.json");
    const candidatesPath = path.join(tempDir, "candidates.json");
    const timeoutMs = (this.config.providerTimeoutSeconds ?? 0) * 1000;
    let preserveTempDir = false;

    try {
      await writeFile(candidatesPath, JSON.stringify(redactSecrets(candidates.map(candidateSnapshot)), null, 2), "utf8");
      const prompt = buildPrompt({ candidates, context, settings, riskDocPath, candidatesPath });
      await writeFile(promptPath, prompt, "utf8");
      await writeFile(schemaPath, JSON.stringify(buildCandidateTriageSchema(), null, 2), "utf8");

      if (provider === "claude-code") {
        await runClaude({ prompt, settings, repoRoot, tempDir, outputPath, schemaPath, timeoutMs });
      } else if (provider === "codex") {
        await runCodex({ prompt, settings, repoRoot, tempDir, outputPath, schemaPath, timeoutMs });
      } else {
        throw new Error(`unsupported_candidate_triage_provider: ${provider}`);
      }

      const rawOutput = await readFile(outputPath, "utf8");
      const payload = extractJsonPayload(rawOutput);
      const runtimeLog = await archiveRuntimeLog({
        config: this.config,
        settings,
        rawOutput,
        prompt,
        tempDir,
        outputPath
      });
      return normalizeTriagePayload(payload, {
        provider,
        runtimeLog,
        model: settings.model || ""
      });
    } catch (error) {
      preserveTempDir = true;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}\n\nCandidate triage runtime temp preserved at ${tempDir}`, { cause: error });
    } finally {
      if (!preserveTempDir && existsSync(tempDir)) {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  }
}

export const candidateTriageRuntimeInternals = {
  buildCandidateTriageSchema,
  buildPrompt,
  extractJsonPayload,
  normalizeTriagePayload
};
