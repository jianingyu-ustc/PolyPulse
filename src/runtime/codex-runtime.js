/**
 * CodexRuntime (概率估算)
 *
 * AI 概率估算运行时：综合市场信息和全部证据，估算事件在结算日发生的概率。
 * 对齐 Predict-Raven pulse-direct 的概率估算分工。
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

function nowContext() {
  const now = new Date();
  return now.toISOString().replace("T", " ").slice(0, 19) + " UTC";
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
      "freshness_score",
      "base_rate",
      "base_rate_source",
      "evidence_adjustment",
      "deviation_justification"
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
      freshness_score: { type: "number", minimum: 0, maximum: 1 },
      base_rate: { type: "number", minimum: 0, maximum: 1 },
      base_rate_source: { type: "string" },
      evidence_adjustment: { type: "number", minimum: -1, maximum: 1 },
      deviation_justification: { type: "string" }
    }
  };
}

function buildPrompt({ market, evidence, settings, riskDocPath, marketPath, evidencePath, upstreamContext = null }) {
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
      `当前时间：${nowContext()}`,
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
      upstreamContext ? [
        "",
        "上游分析上下文（来自 candidate-triage 和 evidence-research 阶段）：",
        JSON.stringify(upstreamContext)
      ].join("\n") : "",
      "",
      "硬规则：",
      "1. 只能输出合法 JSON，不要输出 markdown 代码块。",
      "2. 不允许编造证据；所有 key_evidence 和 counter_evidence 必须来自输入 Evidence JSON。",
      "3. 必须区分盘口价格和独立证据；盘口价格只能作为对照基准，不能当作支持事件发生的证据。",
      "4. 必须判断该市场是否可研究、证据是否足够独立新鲜、是否存在相对盘口的信息优势；把判断写进 reasoning_summary。",
      "5. confidence 分级标准（重要：大多数可研究市场应为 medium，low 是例外而非默认）：",
      "   - high：有多条独立、新鲜（7天内）、高可信度证据，且推理链清晰指向一个方向，市场可研究。",
      "   - medium（默认选择）：只要满足以下任一条件即应给 medium：",
      "     * 有至少1条14天内的相关证据",
      "     * 市场类型有公开可查的数据源（天气预报、赛程表、官方日历、民调、链上数据）",
      "     * 你能基于公开信息形成有方向性的概率判断（即使不完全确定）",
      "     政治选举有民调/公开声明、宏观经济有官方数据预期、体育有赛程/伤病/历史对阵、天气有预报模型、科技有公司公告/产品路线图、加密有链上数据/监管文件时，均应给 medium。",
      "   - low（仅限以下情况）：证据为零且无公开数据源可查、结算规则完全不清、纯粹依赖内幕信息、或市场不可交易。",
      "   记住：你是在做概率估算，不是在做确定性判断。存在不确定性≠low confidence。如果你能说出合理的推理依据，就应该是 medium。",
      "6. 估算方法（两阶段法）：",
      "   阶段一：独立估算",
      "   - 首先确定基础概率（base_rate）：该类事件的历史频率、先例统计或结构性先验。写明来源（base_rate_source），例如'该选区历史上共和党胜率80%'、'同类天气事件过去5年发生率30%'。",
      "   - 然后根据当前收集到的证据进行调整（evidence_adjustment）：正数表示证据支持事件发生，负数表示证据反对。",
      "   - ai_probability 应逻辑上约等于 base_rate + evidence_adjustment（允许合理偏差）。",
      "   - 这一阶段不要参考盘口价格，完全基于证据和先验进行独立判断。",
      "   阶段二：与盘口对比审视",
      "   - 完成独立估算后，将你的 ai_probability 与当前盘口价格对比。",
      "   - 如果偏离盘口超过15个百分点，必须在 deviation_justification 中明确说明支撑偏离的具体证据。",
      "   - 如果偏离盘口超过25个百分点且无法给出有力的 deviation_justification，应重新审视推理过程。",
      "   - 如果对该事件完全没有认知且证据为零，在 uncertainty_factors 中注明 'no_specific_knowledge'。",
      "7. ai_probability 必须是该事件 Yes outcome 发生概率，范围 0 到 1。",
      "8. 按 predict-raven pulse-direct 的分工处理：你只给概率、证据质量和信息优势判断；fee、net edge、quarter Kelly、monthly return、排序和风控由代码计算。",
      "9. 不允许输出交易指令、token 改写、仓位金额或 broker 参数。",
      "10. 短期体育赛事与无独立证据场景的特殊规则（极重要）：",
      "   当满足以下任一条件时，你必须将盘口价格作为强先验锚定，而非使用 0.50 或其他无信息默认值：",
      "   a) 市场在48小时内到期（endDate 与当前时间差≤2天）且属于体育/电竞单场赛事；",
      "   b) 证据列表中没有任何独立的、与赛事结果直接相关的高质量证据（如伤病报告、阵容确认、近期状态数据）；",
      "   c) 你无法从证据中提取出支持偏离盘口的具体、可验证的理由。",
      "   在这些情况下，应用 favorite-longshot bias 修正：",
      "   - 预测市场存在公认的统计规律：散户系统性地高估冷门，导致热门被系统性低估。",
      "   - 最终结算时，热门选项（盘口价格高的一侧）的实际胜率通常高于盘口隐含概率。",
      "   - 因此当你缺乏独立信息时：",
      "     * 如果盘口 Yes 价格 > 0.50（热门）：ai_probability = 盘口价格 + 0.03 到 +0.06",
      "     * 如果盘口 Yes 价格 < 0.50（冷门）：ai_probability = 盘口价格 - 0.02 到 -0.04",
      "     * 如果盘口价格接近 0.50（45%-55%）：ai_probability = 盘口价格 ± 0.02",
      "   - base_rate 应设为盘口价格，base_rate_source 写明'市场盘口 + favorite-longshot bias 修正'；",
      "   - 绝对禁止在无证据时输出 ai_probability = 0.50 来与低于0.35或高于0.65的盘口形成虚假edge；",
      "   - 绝对禁止给冷门侧（No side when Yes is favorite）高于盘口的概率，除非有明确证据支持；",
      "   - 在 reasoning_summary 中注明'应用 favorite-longshot bias，热门侧相对盘口获得正向调整'；",
      "   - 在 uncertainty_factors 中注明 'market_price_anchored'。",
      "   此规则的原理：学术研究（Snowberg & Wolfers 2010, Ottaviani & Sørensen 2015）证实预测市场中热门选项的实际胜率高于盘口定价。散户倾向于购买高赔率冷门，压低了热门的隐含概率。在无独立信息时，利用这个系统性偏差是最可靠的正期望策略。",
      "",
      "输出字段必须匹配 ProbabilityEstimate provider schema：",
      "- ai_probability",
      "- confidence: low | medium | high",
      "- reasoning_summary",
      "- key_evidence",
      "- counter_evidence",
      "- uncertainty_factors",
      "- freshness_score",
      "- base_rate (0-1): 该类事件的先验/历史概率",
      "- base_rate_source: base_rate 的来源（如历史统计、先例）",
      "- evidence_adjustment (-1 到 1): 证据对 base_rate 的调整量",
      "- deviation_justification: 当估算偏离盘口>15pp 时的解释（可选）",
      "",
      "示例输出（仅展示格式和质量标准）：",
      JSON.stringify({
        ai_probability: 0.32,
        confidence: "medium",
        reasoning_summary: "PSD 是议会第一大党（30% 议席），虽退出前联盟但仍拥有最大党团。基于议会算术和宪政流程，总统倾向提名能获得多数支持的候选人，PSD 通过与 AUR 合作具备组阁可能性。盘口 22% 低估了 PSD 的议会优势和联盟灵活性。",
        key_evidence: [{ evidenceId: "ev-001", title: "PSD exits coalition, allies with AUR on no-confidence motion", source: "reuters", relevanceScore: 0.92, credibility: "high", status: "fetched", summary: "PSD withdrew from Bolojan coalition and partnered with AUR to pass no-confidence vote on May 5" }],
        counter_evidence: [{ evidenceId: "ev-003", title: "President signals preference for technocratic PM", source: "romania-insider", relevanceScore: 0.75, credibility: "medium", status: "fetched", summary: "President Nicușor Dan indicated openness to non-partisan cabinet amid coalition fragmentation" }],
        uncertainty_factors: ["coalition_negotiations_ongoing", "president_discretion_in_nomination"],
        freshness_score: 0.85,
        base_rate: 0.25,
        base_rate_source: "PSD 历史上在类似政治危机后获得总理职位的频率约 25%（2000 年以来 4 次危机中 1 次）",
        evidence_adjustment: 0.07,
        deviation_justification: "盘口 22% 未充分反映 PSD 退出联盟后与 AUR 组成的议会多数优势（合计超 50% 议席），以及总统宪法义务优先提名多数支持候选人的约束"
      }),
      "",
      "只输出最终 JSON。"
    ].join("\n");
  }

  return [
    "You are the probability estimation runtime for PolyPulse, a Polymarket analysis system.",
    `Active provider: ${settings.provider}`,
    `Current time: ${nowContext()}`,
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
    upstreamContext ? [
      "",
      "Upstream analysis context (from candidate-triage and evidence-research stages):",
      JSON.stringify(upstreamContext)
    ].join("\n") : "",
    "",
    "Hard rules:",
    "1. Output valid JSON only. Do not wrap it in markdown fences.",
    "2. Do not fabricate evidence; key_evidence and counter_evidence must come from the input Evidence JSON.",
    "3. Separate market prices from independent evidence; market prices are a comparison baseline, not supporting evidence that the event will resolve true.",
    "4. Assess whether the market is researchable, whether the evidence is independent and fresh enough, and whether there is an information advantage versus the market price; include that assessment in reasoning_summary.",
    "5. Confidence levels:",
    "   - high: multiple independent, fresh (within 7 days), high-credibility evidence items with a clear reasoning chain pointing in one direction; market is researchable.",
    "   - medium: at least 2 relevant evidence items (at least 1 within 14 days) forming a directional inference, even if some uncertainty remains. Political markets with polls/public statements, macro-economics with official data expectations, sports with schedules/injuries/historical matchups, tech with company announcements/roadmaps, crypto with on-chain data/regulatory filings — all qualify for medium.",
    "   - low: severely insufficient evidence (0-1 items and stale), unclear settlement rules, completely unresearchable, purely dependent on insider information, or market is not tradable. Name reasons in uncertainty_factors.",
    "   Do not downgrade to low merely because you cannot guarantee the outcome — prediction markets are inherently probabilistic; uncertainty is normal.",
    "6. Estimation method (two-phase approach):",
    "   Phase 1: Independent estimation",
    "   - First determine the base rate (base_rate): historical frequency, precedent statistics, or structural prior for this class of event. State the source (base_rate_source), e.g. 'Republicans won this district 80% historically', 'similar weather events occurred 30% of time in past 5 years'.",
    "   - Then adjust based on current collected evidence (evidence_adjustment): positive means evidence supports the event, negative means it opposes.",
    "   - ai_probability should logically approximate base_rate + evidence_adjustment (reasonable deviation allowed).",
    "   - In this phase, do NOT reference the market price. Estimate purely from evidence and priors.",
    "   Phase 2: Market comparison review",
    "   - After completing independent estimation, compare your ai_probability to the current market price.",
    "   - If deviation from market exceeds 15 percentage points, provide explicit justification in deviation_justification citing specific evidence.",
    "   - If deviation exceeds 25 percentage points and you cannot provide strong deviation_justification, reconsider your reasoning.",
    "   - If you have zero knowledge about the event and evidence is empty, note 'no_specific_knowledge' in uncertainty_factors.",
    "7. ai_probability is the probability that the Yes outcome resolves true, from 0 to 1.",
    "8. Follow the predict-raven pulse-direct separation of duties: provide probability, evidence-quality, and information-advantage judgment only; code computes fees, net edge, quarter Kelly, monthly return, ranking, and risk controls.",
    "9. Do not output trade instructions, token rewrites, sizing, or broker parameters.",
    "10. Short-term sports events and no-independent-evidence scenarios (CRITICAL RULE):",
    "   When ANY of the following conditions are met, you MUST anchor to the market price as a strong prior instead of using 0.50 or any other uninformed default:",
    "   a) The market expires within 48 hours (endDate minus current time ≤ 2 days) AND is a single-match sports/esports event;",
    "   b) The evidence list contains NO independent, high-quality evidence directly relevant to the match outcome (e.g., injury reports, lineup confirmations, recent form data);",
    "   c) You cannot extract a specific, verifiable reason from the evidence to justify deviating from the market price.",
    "   In these scenarios, apply favorite-longshot bias correction:",
    "   - Prediction markets exhibit a well-documented statistical regularity: retail participants systematically overestimate longshots, causing favorites to be systematically underpriced.",
    "   - At final settlement, the favorite side (higher market price) wins far more often than the market price implies.",
    "   - Therefore, when you lack independent information:",
    "     * If market Yes price > 0.50 (favorite): ai_probability = market price + 0.03 to +0.06",
    "     * If market Yes price < 0.50 (longshot): ai_probability = market price - 0.02 to -0.04",
    "     * If market price near 0.50 (45%-55%): ai_probability = market price ± 0.02",
    "   - Set base_rate to the market price; set base_rate_source to 'market price + favorite-longshot bias correction';",
    "   - NEVER output ai_probability = 0.50 against a market price below 0.35 or above 0.65 when you lack independent evidence — this creates a false edge;",
    "   - NEVER give the longshot side (No side when Yes is favorite) a probability higher than market unless backed by concrete evidence;",
    "   - Note in reasoning_summary: 'Applied favorite-longshot bias; favorite side receives positive adjustment relative to market price.';",
    "   - Note 'market_price_anchored' in uncertainty_factors.",
    "   Purpose: Academic research (Snowberg & Wolfers 2010, Ottaviani & Sørensen 2015) confirms prediction market favorites' actual win rates exceed their market-implied probabilities. Retail participants prefer buying high-odds longshots, which depresses favorites' implied probabilities. Exploiting this systematic bias is the most reliable positive-EV strategy when no independent information is available.",
    "",
    "The output must match the ProbabilityEstimate provider schema:",
    "- ai_probability",
    "- confidence: low | medium | high",
    "- reasoning_summary",
    "- key_evidence",
    "- counter_evidence",
    "- uncertainty_factors",
    "- freshness_score",
    "- base_rate (0-1): prior/historical probability for this event class",
    "- base_rate_source: where the base rate comes from (e.g. historical statistics, precedent)",
    "- evidence_adjustment (-1 to 1): how much evidence shifts probability from base rate",
    "- deviation_justification: explanation when your estimate deviates >15pp from market price (optional)",
    "",
    "Example output (showing format and quality standard only):",
    JSON.stringify({
      ai_probability: 0.32,
      confidence: "medium",
      reasoning_summary: "PSD is the largest parliamentary party (30% of seats). Despite exiting the prior coalition, they retain the largest caucus. Based on parliamentary arithmetic and constitutional procedure, the president tends to nominate candidates who can command a majority; PSD's alliance with AUR gives them a plausible path to government formation. Market at 22% underestimates PSD's parliamentary leverage and coalition flexibility.",
      key_evidence: [{ evidenceId: "ev-001", title: "PSD exits coalition, allies with AUR on no-confidence motion", source: "reuters", relevanceScore: 0.92, credibility: "high", status: "fetched", summary: "PSD withdrew from Bolojan coalition and partnered with AUR to pass no-confidence vote on May 5" }],
      counter_evidence: [{ evidenceId: "ev-003", title: "President signals preference for technocratic PM", source: "romania-insider", relevanceScore: 0.75, credibility: "medium", status: "fetched", summary: "President indicated openness to non-partisan cabinet amid coalition fragmentation" }],
      uncertainty_factors: ["coalition_negotiations_ongoing", "president_discretion_in_nomination"],
      freshness_score: 0.85,
      base_rate: 0.25,
      base_rate_source: "PSD historically became PM in ~25% of similar political crises (1 of 4 since 2000)",
      evidence_adjustment: 0.07,
      deviation_justification: "Market at 22% does not fully reflect PSD+AUR combined parliamentary majority (>50% of seats) and constitutional obligation for president to first nominate a candidate with majority support"
    }),
    "",
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
  configOverrides,
  maxRetries
}) {
  const effectiveTimeoutMs = timeoutMs > 0 ? timeoutMs : null;
  const retries = maxRetries != null ? maxRetries : 2;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await runCodexOnce({
        prompt, settings, repoRoot, tempDir, outputPath, schemaPath,
        effectiveTimeoutMs, configOverrides
      });
      return;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const isRetryable = /capacity|overloaded|rate.?limit|503|529|too many requests/i.test(msg);
      if (!isRetryable || attempt >= retries) throw error;
      const delayMs = Math.min(30000, 5000 * 2 ** attempt);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function runCodexOnce({
  prompt,
  settings,
  repoRoot,
  tempDir,
  outputPath,
  schemaPath,
  effectiveTimeoutMs,
  configOverrides
}) {
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

  const hasReasoningOverride = Array.isArray(configOverrides)
    && configOverrides.some(o => o.includes("model_reasoning_effort"));
  if (!hasReasoningOverride && settings.reasoningEffort) {
    args.push("-c", `model_reasoning_effort="${settings.reasoningEffort}"`);
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

  async estimateGroup({ markets, evidenceMap, upstreamContexts = null }) {
    const settings = resolveCodexSkillSettings(this.config);
    const repoRoot = path.resolve(this.config.repoRoot ?? process.cwd());
    const riskDocPath = path.resolve(repoRoot, "docs", "specs", "risk-controls.md");
    const tempDir = await mkdtemp(path.join(tmpdir(), "polypulse-codex-group-"));
    const outputPath = path.join(tempDir, "provider-output.json");
    const promptPath = path.join(tempDir, "provider-prompt.txt");
    const schemaPath = path.join(tempDir, "event-group-estimate.schema.json");
    const marketsPath = path.join(tempDir, "markets.json");
    const evidencePath = path.join(tempDir, "evidence-all.json");
    const timeoutMs = (this.config.providerTimeoutSeconds ?? 0) * 1000;
    const effectiveTimeoutMs = timeoutMs > 0 ? timeoutMs : null;
    const runtimeStartedAt = Date.now();
    let preserveTempDir = false;

    try {
      await writeFile(marketsPath, JSON.stringify(redactSecrets(markets), null, 2), "utf8");
      const evidenceObj = Object.fromEntries(
        markets.map((m) => [m.marketId, redactSecrets(evidenceMap.get(m.marketId) ?? [])])
      );
      await writeFile(evidencePath, JSON.stringify(evidenceObj, null, 2), "utf8");
      const prompt = buildEventGroupPrompt({ markets, evidenceMap, settings, riskDocPath, upstreamContexts });
      const schemaContent = JSON.stringify(buildEventGroupProbabilityEstimateSchema(), null, 2);
      await writeFile(promptPath, prompt, "utf8");
      await writeFile(schemaPath, schemaContent, "utf8");

      const promptMetrics = measureText(prompt);
      const schemaMetrics = measureText(schemaContent);

      await runCodex({
        prompt,
        settings,
        repoRoot,
        tempDir,
        outputPath,
        schemaPath,
        timeoutMs,
        maxRetries: this.config.providerMaxRetries
      });

      const rawOutput = await readFile(outputPath, "utf8");
      const parsed = extractGroupJsonPayload(rawOutput);
      if (!this.config.suppressProviderRuntimeArtifacts) {
        const artifactDir = path.join(this.config.artifactDir, "codex-runtime-group", timestampId());
        await mkdir(artifactDir, { recursive: true });
        const logPath = path.join(artifactDir, "runtime-log.md");
        await writeFile(logPath, truncate([
          "# Codex Event Group Probability Runtime Log",
          `Provider: ${settings.provider}`,
          `Markets: ${markets.length}`,
          `Prompt: ${formatTextMetrics(promptMetrics)}`,
          `Schema: ${formatTextMetrics(schemaMetrics)}`,
          "",
          "## Raw Provider Output",
          "```json",
          rawOutput.trim(),
          "```"
        ].join("\n"), this.config.pulse?.maxMarkdownChars ?? 24000), "utf8");
      }
      return parsed;
    } catch (error) {
      preserveTempDir = true;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${message}\n` +
        `${buildRuntimeHeartbeatDetail({
          stage: "Event group probability runtime failure",
          providerDetail: `${settings.provider} provider`,
          startedAt: runtimeStartedAt,
          timeoutMs: effectiveTimeoutMs,
          tempDir,
          outputPath
        })}\n\nEvent group probability runtime temp preserved at ${tempDir}`,
        { cause: error }
      );
    } finally {
      if (!preserveTempDir) {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  }

  async estimate({ market, evidence, upstreamContext = null }) {
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
      const prompt = buildPrompt({ market, evidence, settings, riskDocPath, marketPath, evidencePath, upstreamContext });
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
        timeoutMs,
        maxRetries: this.config.providerMaxRetries
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

function buildEventGroupProbabilityEstimateSchema() {
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
  const outcomeItemSchema = {
    type: "object",
    additionalProperties: false,
    required: [
      "market_id", "market_slug", "label", "probability", "confidence",
      "reasoning_summary", "base_rate", "base_rate_source",
      "evidence_adjustment", "deviation_justification"
    ],
    properties: {
      market_id: { type: "string", minLength: 1 },
      market_slug: { type: "string", minLength: 1 },
      label: { type: "string", minLength: 1 },
      probability: { type: "number", minimum: 0, maximum: 1 },
      confidence: { type: "string", enum: ["low", "medium", "high"] },
      reasoning_summary: { type: "string", minLength: 1 },
      key_evidence: { type: "array", items: evidenceItemSchema },
      counter_evidence: { type: "array", items: evidenceItemSchema },
      uncertainty_factors: { type: "array", items: { type: "string" } },
      base_rate: { type: "number", minimum: 0, maximum: 1 },
      base_rate_source: { type: "string" },
      evidence_adjustment: { type: "number", minimum: -1, maximum: 1 },
      deviation_justification: { type: "string" }
    }
  };
  return {
    type: "object",
    additionalProperties: false,
    required: ["outcomes", "distribution_confidence", "distribution_reasoning", "freshness_score"],
    properties: {
      outcomes: { type: "array", items: outcomeItemSchema },
      distribution_confidence: { type: "string", enum: ["low", "medium", "high"] },
      distribution_reasoning: { type: "string", minLength: 1 },
      freshness_score: { type: "number", minimum: 0, maximum: 1 }
    }
  };
}

function buildEventGroupPrompt({ markets, evidenceMap, settings, riskDocPath, upstreamContexts = null }) {
  const skillLines = settings.skills.map((skill) => `- ${skill.id}: ${skill.skillFile}`);
  const localeIsChinese = isChineseLocale(settings.locale);
  const marketSnapshots = markets.map((market) => ({
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
    active: market.active
  }));

  const perMarketEvidence = markets.map((market) => {
    const items = evidenceMap.get(market.marketId) ?? [];
    return {
      marketId: market.marketId,
      marketSlug: market.marketSlug,
      question: market.question,
      evidence: items.map((item) => ({
        evidenceId: item.evidenceId,
        source: item.source,
        title: item.title,
        sourceUrl: item.sourceUrl ?? item.url,
        timestamp: item.timestamp ?? item.retrievedAt,
        relevanceScore: item.relevanceScore,
        credibility: item.credibility,
        status: item.status,
        summary: item.summary
      }))
    };
  });

  if (localeIsChinese) {
    return [
      "你是 PolyPulse 的 Polymarket 联合概率估算运行时。",
      `当前 provider：${settings.provider}`,
      `当前时间：${nowContext()}`,
      "必须先阅读这些 skill 文件，再做概率估算：",
      ...skillLines,
      "",
      "必须先阅读这份风险控制文档：",
      `- ${riskDocPath}`,
      "",
      "只允许阅读上面列出的 skill 文件、这份风险文档和下面给出的结构化上下文。",
      "不要扫描无关仓库文件，不要运行测试，不要做代码修改，不要尝试下单。",
      "",
      `本次估算是一个多选项事件的联合概率分布。以下 ${markets.length} 个子市场属于同一事件，结果互斥——只有一个候选人能获胜。`,
      "",
      "事件子市场快照：",
      JSON.stringify(marketSnapshots),
      "",
      "各子市场证据：",
      JSON.stringify(perMarketEvidence),
      upstreamContexts ? [
        "",
        "上游分析上下文（来自 candidate-triage 和 evidence-research 阶段）：",
        JSON.stringify(Object.fromEntries(upstreamContexts))
      ].join("\n") : "",
      "",
      "硬规则：",
      "1. 你正在估算同一事件下 N 个互斥结果的联合概率分布。这些结果是穷尽的——概率之和必须等于 1.0。",
      "2. 只能输出合法 JSON，不要输出 markdown 代码块。",
      "3. 不允许编造证据；所有 key_evidence 和 counter_evidence 必须来自输入证据。",
      "4. 必须区分盘口价格和独立证据；盘口价格只能作为对照基准。",
      "5. 对每个候选人分别判断 confidence：",
      "   - high：有多条独立、新鲜（7天内）、高可信度证据，推理链清晰。",
      "   - medium（默认）：有至少1条14天内的相关证据，或有公开可查数据源。",
      "   - low：证据为零且无公开数据源、结算规则不清、纯粹依赖内幕信息。",
      "6. 估算方法（两阶段法，对每个候选人）：",
      "   阶段一：独立估算",
      "   - 确定每个候选人的基础概率（base_rate）及来源（base_rate_source）。",
      "   - 根据证据调整（evidence_adjustment）。",
      "   - 确保所有候选人的概率之和 = 1.0。如果独立估算后总和不为 1，按比例调整。",
      "   阶段二：与盘口对比审视",
      "   - 将联合分布与盘口价格对比。",
      "   - 对任何偏离盘口超过15pp的候选人，提供 deviation_justification。",
      "7. probability 是该候选人 Yes outcome 发生的概率，范围 0 到 1。所有 probability 之和必须等于 1.0。",
      "8. 按 pulse-direct 分工：你只给概率分布和证据质量判断；fee、edge、Kelly 由代码计算。",
      "9. 不允许输出交易指令、token 改写、仓位金额或 broker 参数。",
      "10. 短期赛事与无独立证据场景的特殊规则（极重要）：",
      "   当满足以下任一条件时，你输出的概率分布必须以当前盘口价格分布为强先验：",
      "   a) 事件在48小时内到期（endDate 与当前时间差≤2天）且属于体育/电竞赛事；",
      "   b) 各子市场的证据中没有任何独立的、与赛事结果直接相关的高质量证据（如选手伤病、近期战绩统计、阵容变动）；",
      "   c) 你无法从证据中找到明确偏离当前市场分布的具体理由。",
      "   在这些情况下，应用 favorite-longshot bias 修正：",
      "   - 预测市场和体育博彩市场存在一个公认的统计规律：散户系统性地高估冷门（低概率选项），导致热门（高概率选项）被系统性低估。",
      "   - 最终结算时，往往是当前盘口价格最高的选项解决为100%。",
      "   - 因此当你缺乏独立信息时，应该对当前盘口概率最高的选项（热门）给予额外的正向调整（+0.03 到 +0.08），从冷门选项中等比例扣减。",
      "   - 具体修正幅度参考：",
      "     * 盘口 > 50% 的热门：evidence_adjustment = +0.05 到 +0.08",
      "     * 盘口 30%-50% 的次热门：evidence_adjustment = +0.02 到 +0.04",
      "     * 盘口 < 15% 的冷门：evidence_adjustment = -0.02 到 -0.05",
      "   - base_rate 设为市场盘口价格，base_rate_source 写明'市场盘口 + favorite-longshot bias 修正'；",
      "   - 绝对禁止在无证据时将概率平均分配（如给每个选项 1/N 的均匀分布）来取代市场当前的不均匀分布；",
      "   - 绝对禁止给冷门选项高于其盘口价格的概率，除非有明确证据支持；",
      "   - 在 distribution_reasoning 中注明'应用 favorite-longshot bias 修正，热门选项相对市场定价获得额外正向调整'。",
      "   此规则的原理：学术研究和博彩市场实证数据一致表明，预测市场中热门选项的实际胜率通常高于其市场定价（Snowberg & Wolfers 2010, Ottaviani & Sørensen 2015）。散户倾向于购买高赔率冷门选项（期望获得大倍数回报），这压低了热门选项的隐含概率。利用这个系统性偏差是没有独立信息时最可靠的正期望策略。",
      "",
      "输出必须匹配联合概率分布 schema：",
      "- outcomes: [{market_id, market_slug, label, probability, confidence, reasoning_summary, key_evidence, counter_evidence, uncertainty_factors, base_rate, base_rate_source, evidence_adjustment, deviation_justification}]",
      "- distribution_confidence: low | medium | high（对整体分布的信心）",
      "- distribution_reasoning: 整体分布推理摘要",
      "- freshness_score: 证据新鲜度 0-1",
      "重要约束：outcomes 中所有 probability 之和必须严格等于 1.0。",
      "",
      "示例输出（3 个候选人的联合分布，概率之和 = 1.0）：",
      JSON.stringify({
        outcomes: [
          { market_id: "m-001", market_slug: "candidate-a-wins", label: "Candidate A", probability: 0.45, confidence: "medium", reasoning_summary: "议会第一大党，联盟谈判中占主动", key_evidence: [], counter_evidence: [], uncertainty_factors: ["coalition_fluid"], base_rate: 0.40, base_rate_source: "最大党在类似危机中组阁成功率约40%", evidence_adjustment: 0.05, deviation_justification: "" },
          { market_id: "m-002", market_slug: "candidate-b-wins", label: "Candidate B", probability: 0.35, confidence: "medium", reasoning_summary: "第二大党，可通过跨阵营联盟获得多数", key_evidence: [], counter_evidence: [], uncertainty_factors: ["coalition_fluid"], base_rate: 0.30, base_rate_source: "第二大党在联合政府中获总理职位的历史频率", evidence_adjustment: 0.05, deviation_justification: "" },
          { market_id: "m-003", market_slug: "candidate-c-wins", label: "Candidate C", probability: 0.20, confidence: "low", reasoning_summary: "技术官僚候选人，总统偏好但需跨党派支持", key_evidence: [], counter_evidence: [], uncertainty_factors: ["no_party_base", "president_discretion"], base_rate: 0.15, base_rate_source: "无党派技术官僚在议会制国家获任命的基础概率", evidence_adjustment: 0.05, deviation_justification: "" }
        ],
        distribution_confidence: "medium",
        distribution_reasoning: "基于议会席位分布、联盟谈判信号和总统宪法权力的综合判断；三人概率之和为 1.0",
        freshness_score: 0.80
      }),
      "",
      "只输出最终 JSON。"
    ].join("\n");
  }

  return [
    "You are the JOINT probability estimation runtime for PolyPulse, a Polymarket analysis system.",
    `Active provider: ${settings.provider}`,
    `Current time: ${nowContext()}`,
    "Read these selected skill files before estimating:",
    ...skillLines,
    "",
    "Read this risk control document before estimating:",
    `- ${riskDocPath}`,
    "",
    "Only inspect the listed skill files, this risk document, and the structured context below.",
    "Do not scan unrelated repository files, do not run tests, do not modify code, and do not place orders.",
    "",
    `This estimation covers a MULTI-OUTCOME EVENT. The following ${markets.length} sub-markets belong to the same event with mutually-exclusive outcomes — only one candidate can win.`,
    "",
    "Event sub-market snapshots:",
    JSON.stringify(marketSnapshots),
    "",
    "Per-market evidence:",
    JSON.stringify(perMarketEvidence),
    upstreamContexts ? [
      "",
      "Upstream analysis context (from candidate-triage and evidence-research stages):",
      JSON.stringify(Object.fromEntries(upstreamContexts))
    ].join("\n") : "",
    "",
    "Hard rules:",
    "1. You are estimating a JOINT probability distribution across N mutually-exclusive outcomes for the SAME event. These outcomes are exhaustive — probabilities MUST sum to exactly 1.0.",
    "2. Output valid JSON only. Do not wrap it in markdown fences.",
    "3. Do not fabricate evidence; key_evidence and counter_evidence must come from the input evidence.",
    "4. Separate market prices from independent evidence; market prices are a comparison baseline, not supporting evidence.",
    "5. Per-outcome confidence levels:",
    "   - high: multiple independent, fresh (within 7 days), high-credibility evidence with clear reasoning chain.",
    "   - medium (default): at least 1 relevant evidence item within 14 days, or publicly available data sources exist.",
    "   - low: zero evidence and no public data sources, unclear settlement rules, or purely insider-dependent.",
    "6. Estimation method (two-phase, applied to each outcome):",
    "   Phase 1: Independent estimation",
    "   - Determine base_rate for each candidate (historical frequency, precedent). State base_rate_source.",
    "   - Adjust based on evidence (evidence_adjustment): positive supports, negative opposes.",
    "   - CRITICAL: Ensure all probabilities sum to 1.0. If independent estimates don't sum to 1, normalize proportionally.",
    "   Phase 2: Market comparison review",
    "   - Compare your joint distribution to current market prices.",
    "   - For any outcome deviating >15pp from market price, provide deviation_justification with specific evidence.",
    "   - If deviation >25pp without strong justification, reconsider.",
    "7. probability is P(Yes) for each candidate, from 0 to 1. ALL probabilities MUST sum to exactly 1.0.",
    "8. Follow pulse-direct separation of duties: provide probability distribution and evidence-quality judgment only; code computes fees, edge, Kelly, sizing.",
    "9. Do not output trade instructions, token rewrites, sizing, or broker parameters.",
    "10. Short-term events and no-independent-evidence scenarios (CRITICAL RULE):",
    "   When ANY of the following conditions are met, your probability distribution MUST anchor strongly to the current market price distribution:",
    "   a) The event expires within 48 hours (endDate minus current time ≤ 2 days) AND is a sports/esports event;",
    "   b) The evidence for sub-markets contains NO independent, high-quality data directly relevant to the outcome (e.g., player injury reports, recent form statistics, lineup changes);",
    "   c) You cannot identify a specific, evidence-backed reason to deviate from the current market distribution.",
    "   In these scenarios, apply favorite-longshot bias correction:",
    "   - Prediction markets exhibit a well-documented statistical regularity: retail participants systematically overestimate longshots (low-probability options), causing favorites (high-probability options) to be systematically underpriced.",
    "   - At final settlement, the current market favorite (highest-priced option) resolves to 100% far more often than its market price implies.",
    "   - Therefore, when you lack independent information, you MUST give the current market favorite an additional positive adjustment (+0.03 to +0.08), deducted proportionally from longshot options.",
    "   - Specific adjustment guidelines:",
    "     * Favorite (market price > 50%): evidence_adjustment = +0.05 to +0.08",
    "     * Mid-tier (market price 30%-50%): evidence_adjustment = +0.02 to +0.04",
    "     * Longshot (market price < 15%): evidence_adjustment = -0.02 to -0.05",
    "   - Set base_rate to each candidate's current market price; set base_rate_source to 'market price + favorite-longshot bias correction';",
    "   - NEVER assign a uniform distribution (1/N to each outcome) when the market has a non-uniform distribution and you lack evidence to justify flattening it;",
    "   - NEVER give a longshot option a probability HIGHER than its current market price unless you have concrete evidence supporting it;",
    "   - Note in distribution_reasoning: 'Applied favorite-longshot bias correction; favorite receives additional positive adjustment relative to market pricing.'",
    "   Purpose: Academic research and empirical betting market data consistently show that prediction market favorites' actual win rates exceed their market-implied probabilities (Snowberg & Wolfers 2010, Ottaviani & Sørensen 2015). Retail participants prefer buying high-odds longshots (hoping for large payoffs), which depresses favorites' implied probabilities. Exploiting this systematic bias is the most reliable positive-EV strategy when no independent information is available.",
    "",
    "Output must match the EventGroupProbabilityEstimate schema:",
    "- outcomes: [{market_id, market_slug, label, probability, confidence, reasoning_summary, key_evidence, counter_evidence, uncertainty_factors, base_rate, base_rate_source, evidence_adjustment, deviation_justification}]",
    "- distribution_confidence: low | medium | high (confidence in the overall distribution)",
    "- distribution_reasoning: summary of the overall distribution reasoning",
    "- freshness_score: evidence freshness 0-1",
    "CRITICAL CONSTRAINT: The sum of all probability values in outcomes MUST equal exactly 1.0.",
    "",
    "Example output (3-candidate joint distribution, probabilities sum to 1.0):",
    JSON.stringify({
      outcomes: [
        { market_id: "m-001", market_slug: "candidate-a-wins", label: "Candidate A", probability: 0.45, confidence: "medium", reasoning_summary: "Largest parliamentary party with active coalition leverage", key_evidence: [], counter_evidence: [], uncertainty_factors: ["coalition_fluid"], base_rate: 0.40, base_rate_source: "Largest party succeeded in forming government in ~40% of similar crises", evidence_adjustment: 0.05, deviation_justification: "" },
        { market_id: "m-002", market_slug: "candidate-b-wins", label: "Candidate B", probability: 0.35, confidence: "medium", reasoning_summary: "Second-largest party, can form cross-bloc alliance for majority", key_evidence: [], counter_evidence: [], uncertainty_factors: ["coalition_fluid"], base_rate: 0.30, base_rate_source: "Historical rate of second-largest party securing PM in coalition governments", evidence_adjustment: 0.05, deviation_justification: "" },
        { market_id: "m-003", market_slug: "candidate-c-wins", label: "Candidate C", probability: 0.20, confidence: "low", reasoning_summary: "Technocratic candidate preferred by president but lacks party base", key_evidence: [], counter_evidence: [], uncertainty_factors: ["no_party_base", "president_discretion"], base_rate: 0.15, base_rate_source: "Base rate for non-partisan technocrats receiving PM appointment in parliamentary systems", evidence_adjustment: 0.05, deviation_justification: "" }
      ],
      distribution_confidence: "medium",
      distribution_reasoning: "Joint assessment based on parliamentary seat distribution, coalition signals, and presidential constitutional authority; probabilities sum to 1.0",
      freshness_score: 0.80
    }),
    "",
    "Output final JSON only."
  ].join("\n");
}

function hasGroupEstimateShape(value) {
  return Boolean(
    value
      && typeof value === "object"
      && Array.isArray(value.outcomes)
      && value.outcomes.length > 0
      && value.outcomes.every((o) => o.probability != null && (o.market_id != null || o.market_slug != null))
  );
}

function parseGroupEstimateValue(value) {
  if (hasGroupEstimateShape(value)) {
    return value;
  }
  if (value && typeof value === "object") {
    for (const key of SUPPORTED_WRAPPER_KEYS) {
      if (key in value && hasGroupEstimateShape(value[key])) {
        return value[key];
      }
    }
  }
  throw new Error("Provider output did not contain a valid EventGroupProbabilityEstimate object.");
}

function extractGroupJsonPayload(text) {
  const candidates = [
    String(text ?? "").trim(),
    stripCodeFences(text)
  ];
  for (const candidate of candidates) {
    try {
      return parseGroupEstimateValue(JSON.parse(candidate));
    } catch {
      // Try the next parse strategy.
    }
  }
  const value = String(text ?? "");
  const firstBrace = value.indexOf("{");
  const lastBrace = value.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return parseGroupEstimateValue(JSON.parse(value.slice(firstBrace, lastBrace + 1)));
  }
  throw new Error("Provider output did not contain a valid EventGroupProbabilityEstimate JSON payload.");
}

export const codexRuntimeInternals = {
  buildProbabilityEstimateSchema,
  buildPrompt,
  extractJsonPayload,
  normalizeSourceUrl,
  runCodex,
  buildEventGroupProbabilityEstimateSchema,
  buildEventGroupPrompt,
  extractGroupJsonPayload
};
