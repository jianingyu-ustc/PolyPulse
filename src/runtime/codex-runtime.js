/**
 * CodexRuntime (概率估算)
 *
 * AI 概率估算运行时：综合市场信息和全部证据，估算事件在结算日发生的概率。
 * 对齐 Predict-Raven pulse-direct 的概率估算分工。
 *
 * 提示词模板（zh locale 示例，由 buildPrompt() 动态生成）：
 * ─────────────────────────────────────────────────────────────────
 * 你是 PolyPulse 的 Polymarket 概率估算运行时。
 * 当前 provider：codex
 * 必须先阅读这些 skill 文件，再做概率估算：
 * - <skill id>: <skill SKILL.md path>
 *
 * 必须先阅读这份风险控制文档：
 * - <repoRoot>/docs/specs/risk-controls.md
 *
 * 只允许阅读上面列出的 skill 文件、这份风险文档、输入 JSON 文件和下面给出的结构化上下文。
 * 不要扫描无关仓库文件，不要运行测试，不要做代码修改，不要尝试下单。
 *
 * 输入文件：
 * - Market JSON: <tempDir>/market.json
 * - Evidence JSON: <tempDir>/evidence.json
 *
 * 市场快照：
 * <JSON: marketId, marketSlug, eventId, eventSlug, question, outcomes,
 * endDate, liquidityUsd, volumeUsd, volume24hUsd, category, tags,
 * active, closed, tradable, riskFlags>
 *
 * 证据摘要：
 * <JSON array: evidenceId, source, title, sourceUrl, timestamp,
 * relevanceScore, credibility, status, summary>
 *
 * 硬规则：
 * 1. 只能输出合法 JSON，不要输出 markdown 代码块。
 * 2. 不允许编造证据；所有 key_evidence 和 counter_evidence 必须来自输入 Evidence JSON。
 * 3. 必须区分盘口价格和独立证据；盘口价格只能作为对照基准，不能当作支持事件发生的证据。
 * 4. 必须判断该市场是否可研究、证据是否足够独立新鲜、是否存在相对盘口的信息优势；
 *    把判断写进 reasoning_summary。
 * 5. 证据不足、来源陈旧、结算规则不清、不可研究、信息优势不足或市场不可交易时，
 *    confidence 必须为 low，并在 uncertainty_factors 中写出原因。
 * 6. ai_probability 必须是该事件 Yes outcome 发生概率，范围 0 到 1。
 * 7. 按 predict-raven pulse-direct 的分工处理：你只给概率、证据质量和信息优势判断；
 *    fee、net edge、quarter Kelly、monthly return、排序和风控由代码计算。
 * 8. 不允许输出交易指令、token 改写、仓位金额或 broker 参数。
 *
 * 输出字段必须匹配 ProbabilityEstimate provider schema：
 * - ai_probability
 * - confidence: low | medium | high
 * - reasoning_summary
 * - key_evidence
 * - counter_evidence
 * - uncertainty_factors
 * - freshness_score
 * 只输出最终 JSON。
 * ─────────────────────────────────────────────────────────────────
 *
 * Key properties:
 * - Provider outputs ProbabilityEstimate JSON (probability, confidence, reasoning)
 * - Provider CANNOT output trade instructions, sizing, or broker parameters
 * - Timeout-protected; on failure, market is skipped
 * - Works with both codex and claude-code providers
 */

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { redactSecrets } from "../config/env.js";
import {
  combineTextMetrics,
  formatTextMetrics,
  measureText,
  readTextMetrics
} from "./text-metrics.js";
import { resolveCodexSkillSettings } from "./codex-skill-settings.js";

const RUNTIME_HEARTBEAT_INTERVAL_MS = 5000;
const SUPPORTED_WRAPPER_KEYS = ["estimate", "probabilityEstimate", "result", "output", "payload", "final"];

function timestampId(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function isChineseLocale(locale) {
  return locale === "zh";
}

function stripCodeFences(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }
  const lines = trimmed.split("\n");
  return lines.length >= 3 ? lines.slice(1, -1).join("\n").trim() : trimmed;
}

function truncate(text, maxChars = 24000) {
  const value = String(text ?? "");
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 24))}\n\n... truncated ...\n`;
}

function readOutputSizeBytes(outputPath) {
  if (!outputPath || !existsSync(outputPath)) {
    return 0;
  }
  try {
    return statSync(outputPath).size;
  } catch {
    return 0;
  }
}

function formatRemainingTimeoutMs(startedAt, timeoutMs) {
  if (timeoutMs == null) {
    return "disabled";
  }
  const remainingMs = Math.max(0, timeoutMs - (Date.now() - startedAt));
  return `${Math.ceil(remainingMs / 1000)}s`;
}

function buildRuntimeHeartbeatDetail(input) {
  return [
    `stage ${input.stage}`,
    input.providerDetail,
    `elapsed ${Math.round((Date.now() - input.startedAt) / 1000)}s`,
    `temp ${input.tempDir}`,
    `output ${input.outputPath}`,
    `output bytes ${readOutputSizeBytes(input.outputPath)}`,
    `timeout remaining ${formatRemainingTimeoutMs(input.startedAt, input.timeoutMs)}`
  ].join(" | ");
}

function normalizeSourceUrl(url) {
  const trimmed = String(url ?? "").trim();
  if (!trimmed) {
    return "about:blank";
  }
  try {
    return new URL(trimmed).href;
  } catch {
    const absolutePath = path.isAbsolute(trimmed)
      ? trimmed
      : path.resolve(process.cwd(), trimmed);
    return pathToFileURL(absolutePath).href;
  }
}

function normalizeEvidenceReference(item) {
  if (!item || typeof item !== "object") {
    return item;
  }
  const sourceUrl = item.sourceUrl ?? item.url;
  return {
    ...item,
    ...(sourceUrl ? { sourceUrl: normalizeSourceUrl(sourceUrl), url: normalizeSourceUrl(sourceUrl) } : {})
  };
}

function normalizeEstimateLike(value) {
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = { ...value };
  for (const key of ["key_evidence", "keyEvidence", "counter_evidence", "counterEvidence"]) {
    if (Array.isArray(record[key])) {
      record[key] = record[key].map(normalizeEvidenceReference);
    }
  }
  for (const key of SUPPORTED_WRAPPER_KEYS) {
    if (record[key] && typeof record[key] === "object") {
      record[key] = normalizeEstimateLike(record[key]);
    }
  }
  return record;
}

function hasEstimateShape(value) {
  return Boolean(
    value
      && typeof value === "object"
      && (value.ai_probability != null || value.aiProbability != null)
      && (value.reasoning_summary != null || value.reasoningSummary != null)
  );
}

function parseEstimateValue(value) {
  const normalized = normalizeEstimateLike(value);
  if (hasEstimateShape(normalized)) {
    return normalized;
  }
  if (normalized && typeof normalized === "object") {
    const issues = [];
    for (const key of SUPPORTED_WRAPPER_KEYS) {
      if (!(key in normalized)) {
        continue;
      }
      if (hasEstimateShape(normalized[key])) {
        return normalized[key];
      }
      issues.push(`${key}: missing ai_probability/reasoning_summary`);
    }
    if (issues.length > 0) {
      throw new Error(`Provider output used a supported wrapper key, but the wrapped ProbabilityEstimate was invalid.\n${issues.join("\n")}`);
    }
  }
  throw new Error("Provider output did not contain a ProbabilityEstimate object.");
}

function extractJsonPayload(text) {
  const candidates = [
    String(text ?? "").trim(),
    stripCodeFences(text)
  ];
  for (const candidate of candidates) {
    try {
      return parseEstimateValue(JSON.parse(candidate));
    } catch {
      // Try the next parse strategy.
    }
  }
  const value = String(text ?? "");
  const firstBrace = value.indexOf("{");
  const lastBrace = value.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return parseEstimateValue(JSON.parse(value.slice(firstBrace, lastBrace + 1)));
  }
  throw new Error("Provider output did not contain a valid ProbabilityEstimate JSON payload.");
}

function buildProbabilityEstimateSchema() {
  const evidenceProperties = {
    evidenceId: { type: "string", minLength: 1 },
    marketId: { type: "string" },
    title: { type: "string", minLength: 1 },
    summary: { type: "string" },
    source: { type: "string" },
    sourceUrl: { type: "string" },
    url: { type: "string" },
    timestamp: { type: "string" },
    retrievedAt: { type: "string" },
    relevanceScore: { type: "number" },
    relevance_score: { type: "number" },
    credibility: { type: "string" },
    status: { type: "string" }
  };
  const evidenceItemSchema = {
    type: "object",
    additionalProperties: false,
    required: Object.keys(evidenceProperties),
    properties: evidenceProperties
  };
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "ai_probability",
      "confidence",
      "reasoning_summary",
      "key_evidence",
      "counter_evidence",
      "uncertainty_factors",
      "freshness_score"
    ],
    properties: {
      ai_probability: { type: "number", minimum: 0, maximum: 1 },
      confidence: { type: "string", enum: ["low", "medium", "high"] },
      reasoning_summary: { type: "string", minLength: 1 },
      key_evidence: {
        type: "array",
        items: evidenceItemSchema
      },
      counter_evidence: {
        type: "array",
        items: evidenceItemSchema
      },
      uncertainty_factors: {
        type: "array",
        items: { type: "string" }
      },
      freshness_score: { type: "number", minimum: 0, maximum: 1 }
    }
  };
}

function buildPrompt({ market, evidence, settings, riskDocPath, marketPath, evidencePath }) {
  const skillLines = settings.skills.map((skill) => `- ${skill.id}: ${skill.skillFile}`);
  const localeIsChinese = isChineseLocale(settings.locale);
  const marketSnapshot = {
    marketId: market.marketId,
    marketSlug: market.marketSlug,
    eventId: market.eventId,
    eventSlug: market.eventSlug,
    question: market.question,
    outcomes: market.outcomes,
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

  if (localeIsChinese) {
    return [
      "你是 PolyPulse 的 Polymarket 概率估算运行时。",
      `当前 provider：${settings.provider}`,
      "必须先阅读这些 skill 文件，再做概率估算：",
      ...skillLines,
      "",
      "必须先阅读这份风险控制文档：",
      `- ${riskDocPath}`,
      "",
      "只允许阅读上面列出的 skill 文件、这份风险文档、输入 JSON 文件和下面给出的结构化上下文。",
      "不要扫描无关仓库文件，不要运行测试，不要做代码修改，不要尝试下单。",
      "",
      "输入文件：",
      `- Market JSON: ${marketPath}`,
      `- Evidence JSON: ${evidencePath}`,
      "",
      "市场快照：",
      JSON.stringify(marketSnapshot),
      "",
      "证据摘要：",
      JSON.stringify(evidence.map((item) => ({
        evidenceId: item.evidenceId,
        source: item.source,
        title: item.title,
        sourceUrl: item.sourceUrl ?? item.url,
        timestamp: item.timestamp ?? item.retrievedAt,
        relevanceScore: item.relevanceScore,
        credibility: item.credibility,
        status: item.status,
        summary: item.summary
      }))),
      "",
      "硬规则：",
      "1. 只能输出合法 JSON，不要输出 markdown 代码块。",
      "2. 不允许编造证据；所有 key_evidence 和 counter_evidence 必须来自输入 Evidence JSON。",
      "3. 必须区分盘口价格和独立证据；盘口价格只能作为对照基准，不能当作支持事件发生的证据。",
      "4. 必须判断该市场是否可研究、证据是否足够独立新鲜、是否存在相对盘口的信息优势；把判断写进 reasoning_summary。",
      "5. 证据不足、来源陈旧、结算规则不清、不可研究、信息优势不足或市场不可交易时，confidence 必须为 low，并在 uncertainty_factors 中写出 insufficient_external_evidence、low_information_advantage 或 unresearchable_market 等原因。",
      "6. ai_probability 必须是该事件 Yes outcome 发生概率，范围 0 到 1。",
      "7. 按 predict-raven pulse-direct 的分工处理：你只给概率、证据质量和信息优势判断；fee、net edge、quarter Kelly、monthly return、排序和风控由代码计算。",
      "8. 不允许输出交易指令、token 改写、仓位金额或 broker 参数。",
      "",
      "输出字段必须匹配 ProbabilityEstimate provider schema：",
      "- ai_probability",
      "- confidence: low | medium | high",
      "- reasoning_summary",
      "- key_evidence",
      "- counter_evidence",
      "- uncertainty_factors",
      "- freshness_score",
      "只输出最终 JSON。"
    ].join("\n");
  }

  return [
    "You are the probability estimation runtime for PolyPulse, a Polymarket analysis system.",
    `Active provider: ${settings.provider}`,
    "Read these selected skill files before estimating:",
    ...skillLines,
    "",
    "Read this risk control document before estimating:",
    `- ${riskDocPath}`,
    "",
    "Only inspect the listed skill files, this risk document, the input JSON files, and the structured context below.",
    "Do not scan unrelated repository files, do not run tests, do not modify code, and do not place orders.",
    "",
    "Input files:",
    `- Market JSON: ${marketPath}`,
    `- Evidence JSON: ${evidencePath}`,
    "",
    "Market snapshot:",
    JSON.stringify(marketSnapshot),
    "",
    "Evidence summary:",
    JSON.stringify(evidence.map((item) => ({
      evidenceId: item.evidenceId,
      source: item.source,
      title: item.title,
      sourceUrl: item.sourceUrl ?? item.url,
      timestamp: item.timestamp ?? item.retrievedAt,
      relevanceScore: item.relevanceScore,
      credibility: item.credibility,
      status: item.status,
      summary: item.summary
    }))),
    "",
    "Hard rules:",
    "1. Output valid JSON only. Do not wrap it in markdown fences.",
    "2. Do not fabricate evidence; key_evidence and counter_evidence must come from the input Evidence JSON.",
    "3. Separate market prices from independent evidence; market prices are a comparison baseline, not supporting evidence that the event will resolve true.",
    "4. Assess whether the market is researchable, whether the evidence is independent and fresh enough, and whether there is an information advantage versus the market price; include that assessment in reasoning_summary.",
    "5. If evidence is insufficient, stale, ambiguous, unresearchable, low-information-advantage, or the market is not tradable, confidence must be low and uncertainty_factors must name reasons such as insufficient_external_evidence, low_information_advantage, or unresearchable_market.",
    "6. ai_probability is the probability that the Yes outcome resolves true, from 0 to 1.",
    "7. Follow the predict-raven pulse-direct separation of duties: provide probability, evidence-quality, and information-advantage judgment only; code computes fees, net edge, quarter Kelly, monthly return, ranking, and risk controls.",
    "8. Do not output trade instructions, token rewrites, sizing, or broker parameters.",
    "",
    "The output must match the ProbabilityEstimate provider schema:",
    "- ai_probability",
    "- confidence: low | medium | high",
    "- reasoning_summary",
    "- key_evidence",
    "- counter_evidence",
    "- uncertainty_factors",
    "- freshness_score",
    "Output final JSON only."
  ].join("\n");
}

async function runCodex({
  prompt,
  settings,
  repoRoot,
  tempDir,
  outputPath,
  schemaPath,
  timeoutMs,
  configOverrides
}) {
  const effectiveTimeoutMs = timeoutMs > 0 ? timeoutMs : null;
  const args = [
    "exec",
    "--skip-git-repo-check",
    "-C",
    repoRoot,
    "-s",
    "read-only"
  ];
  if (schemaPath) {
    args.push("--output-schema", schemaPath);
  }
  args.push("-o", outputPath, "--color", "never");

  if (settings.model) {
    args.push("-m", settings.model);
  }

  if (Array.isArray(configOverrides)) {
    for (const override of configOverrides) {
      args.push("-c", override);
    }
  }

  const skillRootOutsideRepo = settings.skillRootDir !== repoRoot
    && !settings.skillRootDir.startsWith(`${repoRoot}${path.sep}`);
  if (skillRootOutsideRepo) {
    args.push("--add-dir", settings.skillRootDir);
  }
  args.push("-");

  await new Promise((resolve, reject) => {
    const child = spawn("codex", args, {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stderr = "";
    const startedAt = Date.now();
    const heartbeat = setInterval(() => {}, RUNTIME_HEARTBEAT_INTERVAL_MS);
    const timeout = effectiveTimeoutMs == null
      ? null
      : setTimeout(() => {
        clearInterval(heartbeat);
        child.kill?.("SIGTERM");
        reject(new Error(
          `codex exec timed out after ${effectiveTimeoutMs}ms\n` +
          `${buildRuntimeHeartbeatDetail({
            stage: "Probability runtime is running",
            providerDetail: `${settings.provider} provider`,
            startedAt,
            timeoutMs: effectiveTimeoutMs,
            tempDir,
            outputPath
          })}`
        ));
      }, effectiveTimeoutMs);
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearInterval(heartbeat);
      if (timeout) clearTimeout(timeout);
      reject(new Error(
        `${error.message}\n` +
        `${buildRuntimeHeartbeatDetail({
          stage: "Probability runtime is running",
          providerDetail: `${settings.provider} provider`,
          startedAt,
          timeoutMs: effectiveTimeoutMs,
          tempDir,
          outputPath
        })}`,
        { cause: error }
      ));
    });
    child.on("close", (code) => {
      clearInterval(heartbeat);
      if (timeout) clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(
        `${stderr || `codex exec exited with code ${code}`}\n` +
        `${buildRuntimeHeartbeatDetail({
          stage: "Probability runtime is running",
          providerDetail: `${settings.provider} provider`,
          startedAt,
          timeoutMs: effectiveTimeoutMs,
          tempDir,
          outputPath
        })}`
      ));
    });
    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}

async function archiveRuntimeLog({ config, settings, rawOutput, promptMetrics, schemaMetrics, inputMetrics, tempDir, outputPath }) {
  const artifactDir = path.join(config.artifactDir, "codex-runtime", timestampId());
  await mkdir(artifactDir, { recursive: true });
  const logPath = path.join(artifactDir, "runtime-log.md");
  const zh = isChineseLocale(settings.locale);
  const content = truncate([
    zh ? "# Codex 概率运行时日志" : "# Codex Probability Runtime Log",
    "",
    zh ? `Provider：${settings.provider}` : `Provider: ${settings.provider}`,
    zh ? `Locale：${settings.locale}` : `Locale: ${settings.locale}`,
    zh ? `Model：${settings.model || "default"}` : `Model: ${settings.model || "default"}`,
    zh ? `Skills：${settings.skills.map((skill) => skill.id).join(", ")}` : `Skills: ${settings.skills.map((skill) => skill.id).join(", ")}`,
    zh ? `Temp：${tempDir}` : `Temp: ${tempDir}`,
    zh ? `Output：${outputPath}` : `Output: ${outputPath}`,
    zh ? `Prompt：${formatTextMetrics(promptMetrics)}` : `Prompt: ${formatTextMetrics(promptMetrics)}`,
    zh ? `Schema：${formatTextMetrics(schemaMetrics)}` : `Schema: ${formatTextMetrics(schemaMetrics)}`,
    zh ? `Inputs：${formatTextMetrics(inputMetrics)}` : `Inputs: ${formatTextMetrics(inputMetrics)}`,
    "",
    zh ? "## Provider 原始输出" : "## Raw Provider Output",
    "",
    "```json",
    rawOutput.trim(),
    "```"
  ].join("\n"), config.pulse?.maxMarkdownChars ?? 24000);
  await writeFile(logPath, content, "utf8");
  return {
    kind: "codex-runtime-log",
    path: path.relative(process.cwd(), logPath),
    publishedAt: new Date().toISOString()
  };
}

export class CodexProbabilityProvider {
  constructor(config = {}) {
    this.config = config;
  }

  async estimate({ market, evidence }) {
    const settings = resolveCodexSkillSettings(this.config);
    const repoRoot = path.resolve(this.config.repoRoot ?? process.cwd());
    const riskDocPath = path.resolve(repoRoot, "docs", "specs", "risk-controls.md");
    const tempDir = await mkdtemp(path.join(tmpdir(), "polypulse-codex-"));
    const outputPath = path.join(tempDir, "provider-output.json");
    const promptPath = path.join(tempDir, "provider-prompt.txt");
    const schemaPath = path.join(tempDir, "probability-estimate.schema.json");
    const marketPath = path.join(tempDir, "market.json");
    const evidencePath = path.join(tempDir, "evidence.json");
    const timeoutMs = (this.config.providerTimeoutSeconds ?? 0) * 1000;
    const effectiveTimeoutMs = timeoutMs > 0 ? timeoutMs : null;
    const runtimeStartedAt = Date.now();
    let preserveTempDir = false;

    try {
      await writeFile(marketPath, JSON.stringify(redactSecrets(market), null, 2), "utf8");
      await writeFile(evidencePath, JSON.stringify(redactSecrets(evidence), null, 2), "utf8");
      const prompt = buildPrompt({ market, evidence, settings, riskDocPath, marketPath, evidencePath });
      const schemaContent = JSON.stringify(buildProbabilityEstimateSchema(), null, 2);
      await writeFile(promptPath, prompt, "utf8");
      await writeFile(schemaPath, schemaContent, "utf8");

      const [
        marketMetrics,
        evidenceMetrics,
        riskDocMetrics,
        ...skillMetrics
      ] = await Promise.all([
        readTextMetrics(marketPath),
        readTextMetrics(evidencePath),
        existsSync(riskDocPath) ? readTextMetrics(riskDocPath) : Promise.resolve(measureText("")),
        ...settings.skills.map((skill) => readTextMetrics(skill.skillFile))
      ]);
      const promptMetrics = measureText(prompt);
      const schemaMetrics = measureText(schemaContent);
      const inputMetrics = combineTextMetrics([marketMetrics, evidenceMetrics, riskDocMetrics, ...skillMetrics]);

      await runCodex({
        prompt,
        settings,
        repoRoot,
        tempDir,
        outputPath,
        schemaPath,
        timeoutMs
      });

      const rawOutput = await readFile(outputPath, "utf8");
      const parsed = extractJsonPayload(rawOutput);
      const runtimeLog = this.config.suppressProviderRuntimeArtifacts
        ? { path: null }
        : await archiveRuntimeLog({
          config: this.config,
          settings,
          rawOutput,
          promptMetrics,
          schemaMetrics,
          inputMetrics,
          tempDir,
          outputPath
        });
      return {
        ...parsed,
        diagnostics: {
          ...(parsed.diagnostics ?? {}),
          provider: "codex",
          runtime: "codex-skill-runtime",
          model: settings.model || "default",
          artifact: runtimeLog.path,
          outputMetrics: measureText(rawOutput)
        }
      };
    } catch (error) {
      preserveTempDir = true;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${message}\n` +
        `${buildRuntimeHeartbeatDetail({
          stage: "Probability runtime failure",
          providerDetail: `${settings.provider} provider`,
          startedAt: runtimeStartedAt,
          timeoutMs: effectiveTimeoutMs,
          tempDir,
          outputPath
        })}\n\nProbability runtime temp preserved at ${tempDir}`,
        { cause: error }
      );
    } finally {
      if (!preserveTempDir) {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  }
}

export const codexRuntimeInternals = {
  buildProbabilityEstimateSchema,
  buildPrompt,
  extractJsonPayload,
  normalizeSourceUrl,
  runCodex
};
