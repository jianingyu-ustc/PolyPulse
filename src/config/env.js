import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * PolyPulse 环境变量注册表
 *
 * 所有环境变量必须在 `.env` 文件中显式定义，不设默认值。
 * 启动时 loadEnvConfig() 校验 .env 是否覆盖了此表中的全部 key，
 * 缺失任何 key 则报错退出。
 */
export const DEFAULTS = {
  // ─── 执行模式 ──────────────────────────────────────────────────────────────
  // "simulated" 使用内存模拟账本（不连接真实钱包）；
  // "real" 连接真实钱包并通过 Polymarket CLOB 提交订单。
  POLYPULSE_LIVE_WALLET_MODE: null,

  // ─── 模拟钱包 ──────────────────────────────────────────────────────────────
  // 当 POLYPULSE_LIVE_WALLET_MODE=simulated 时使用。
  // 仍然读取真实市场数据，但不连接真实钱包、不提交真实订单。

  // 可选，模拟钱包的 0x 地址标识。可留空。
  SIMULATED_WALLET_ADDRESS: null,
  // 内存模拟账本的初始资金（美元）。
  SIMULATED_WALLET_BALANCE_USD: null,
  // 人类可读模拟 monitor 日志的追加路径。
  SIMULATED_MONITOR_LOG_PATH: null,

  // ─── 真实钱包凭证 ──────────────────────────────────────────────────────────
  // 仅当 POLYPULSE_LIVE_WALLET_MODE=real 时需要。

  // Polygon 钱包私钥，用于签署 CLOB 订单。仅限服务器本地保存。
  PRIVATE_KEY: null,
  // 0x 开头的 20 字节 hex 地址，提供 CLOB 保证金的钱包。
  FUNDER_ADDRESS: null,
  // Polymarket CLOB 签名类型（如 EOA、POLY_GNOSIS_SAFE）。
  SIGNATURE_TYPE: null,
  // 必须为 137（Polygon 主网）。
  CHAIN_ID: null,
  // Polymarket CLOB API 端点，用于提交订单。
  POLYMARKET_HOST: null,

  // ─── 市场数据 ──────────────────────────────────────────────────────────────
  // 市场数据来源。仅支持 "polymarket"。
  POLYPULSE_MARKET_SOURCE: null,
  // Polymarket Gamma API，获取市场元数据（话题、结果等）。
  POLYMARKET_GAMMA_HOST: null,

  // ─── 服务器本地持久化 ──────────────────────────────────────────────────────
  // 持久化状态文件目录（monitor 停/恢复、校准历史等）。
  STATE_DIR: null,
  // 运行时产物根目录（预测结果、运行记录、monitor 等）。
  ARTIFACT_DIR: null,

  // ─── 风控参数 ──────────────────────────────────────────────────────────────
  // 单笔交易最大占总资金比例 (0-1]。
  MAX_TRADE_PCT: null,
  // 所有持仓总敞口最大占总资金比例 (0-1]。
  MAX_TOTAL_EXPOSURE_PCT: null,
  // 单事件最大敞口占总资金比例 (0-1]。
  MAX_EVENT_EXPOSURE_PCT: null,
  // 同时持有的最大仓位数。
  MAX_POSITION_COUNT: null,
  // 单仓位止损阈值，占入场成本比例 (0-1]。
  MAX_POSITION_LOSS_PCT: null,
  // 组合回撤超过此比例时暂停所有交易 (0-1]。
  DRAWDOWN_HALT_PCT: null,
  // 单笔交易最大占市场流动性比例 (0-1]，防止市场冲击。
  LIQUIDITY_TRADE_CAP_PCT: null,
  // 市场数据最大允许年龄（秒），超过视为过时。
  MARKET_MAX_AGE_SECONDS: null,
  // AI 最低置信度要求：low、medium 或 high。
  MIN_AI_CONFIDENCE: null,
  // 最小交易金额（美元），低于此值的交易被跳过。
  MIN_TRADE_USD: null,

  // ─── 市场扫描设置 ──────────────────────────────────────────────────────────
  // 每轮从 Gamma API 扫描的市场总数。
  MARKET_SCAN_LIMIT: null,
  // 每页 API 请求的市场数量（最大 500）。
  MARKET_PAGE_SIZE: null,
  // 每次扫描从 Gamma API 获取的最大页数。
  MARKET_MAX_PAGES: null,
  // 市场数据缓存 TTL。0 = 不缓存（始终获取最新）。
  MARKET_CACHE_TTL_SECONDS: null,
  // Gamma API 请求超时（毫秒）。
  MARKET_REQUEST_TIMEOUT_MS: null,
  // Gamma API 请求失败重试次数。
  MARKET_REQUEST_RETRIES: null,
  // 连续 Gamma API 请求之间的最小延迟（毫秒）。
  MARKET_RATE_LIMIT_MS: null,
  // 扫描有效所需的最低市场获取数量。
  MARKET_MIN_FETCHED: null,

  // ─── Pulse 策略设置 ────────────────────────────────────────────────────────
  // 策略模式。仅支持 "pulse-direct"（兼容 Predict-Raven）。
  PULSE_STRATEGY: null,
  // 候选市场最低流动性（美元）。
  PULSE_MIN_LIQUIDITY_USD: null,
  // 规则预筛后每轮最大候选数。
  PULSE_MAX_CANDIDATES: null,
  // 最终报告/执行中包含的 top 候选数。
  PULSE_REPORT_CANDIDATES: null,
  // 单轮最大部署占总资金比例 (0-1]。
  PULSE_BATCH_CAP_PCT: null,
  // 启用 AI 语义聚类和候选 triage（true/false）。
  PULSE_AI_CANDIDATE_TRIAGE: null,
  // 允许 AI triage 拒绝候选（true/false）。
  PULSE_AI_TRIAGE_CAN_REJECT: null,
  // 启用轻量 AI pre-screen 判断信息优势（TRADE/SKIP）。
  // 在 candidate triage 之前运行；失败时保留全部候选为 TRADE。
  PULSE_AI_PRESCREEN: null,
  // AI pre-screen 步骤超时（毫秒）。
  PULSE_PRESCREEN_TIMEOUT_MS: null,
  // 启用 AI 引导的证据研究（在适配器收集后）。
  // AI 评估证据充分性、识别信息缺口、指导定向搜索。
  // 对齐 Predict-Raven 的 AI 驱动研究流水线。失败时回退到传统 gap-fill。
  PULSE_AI_EVIDENCE_RESEARCH: null,
  // AI 证据研究步骤超时（毫秒）。
  PULSE_EVIDENCE_RESEARCH_TIMEOUT_MS: null,
  // AI 每个市场最大定向搜索数。
  PULSE_EVIDENCE_RESEARCH_MAX_SEARCHES: null,
  // 启用 AI 驱动的外部话题发现（每轮开始时）。
  // Provider 从新闻/体育/宏观/加密信号中发现新话题，输出搜索词。
  PULSE_AI_TOPIC_DISCOVERY: null,
  // AI 话题发现步骤超时（毫秒）。
  PULSE_TOPIC_DISCOVERY_TIMEOUT_MS: null,
  // 启用概率校准层（向 0.5 先验收缩）。在 AI 概率估算后、决策引擎前应用。
  PULSE_CALIBRATION_ENABLED: null,
  // 启用语义发现运行时，将发现的话题与 Polymarket 市场列表
  // 通过 token 相似度和聚类进行匹配。
  PULSE_SEMANTIC_DISCOVERY: null,
  // 每轮语义发现最大匹配市场数。
  PULSE_SEMANTIC_DISCOVERY_MAX_MATCHED: null,
  // 聚类最小 token 相似度 (0-1)。
  PULSE_SEMANTIC_DISCOVERY_SIMILARITY_THRESHOLD: null,
  // 启用动态校准（基于历史预测结果）。
  // 利用 Brier 分数反馈构建校准曲线。需要足够的历史数据。
  PULSE_DYNAMIC_CALIBRATION: null,
  // 启用下行风险评分和跨轮资金分配。
  // 考虑最大损失、流动性风险、时间风险、类别集中度。
  PULSE_DOWNSIDE_RISK_RANKING: null,
  // 每 N 轮输出预测绩效评估报告。
  // 报告含命中率、Brier 分数、校准、按类别/置信度的 edge 准确度。
  PULSE_PERFORMANCE_REPORT_INTERVAL: null,
  // 从 Gamma API 获取的维度（逗号分隔）。
  PULSE_FETCH_DIMENSIONS: null,
  // 证据不足时硬阻止交易（true/false）。
  // false = 仅警告，与 Predict-Raven pulse-direct 服务层分离一致。
  PULSE_REQUIRE_EVIDENCE_GUARD: null,
  // 启用动态手续费估算。
  PULSE_DYNAMIC_FEE_ENABLED: null,
  // 动态手续费缓存 TTL（毫秒）。
  PULSE_DYNAMIC_FEE_TTL_MS: null,
  // 启用手续费验证（下单前校验估算与实际差异）。
  PULSE_FEE_VERIFY_ENABLED: null,
  // 手续费验证差异阈值。超过则警告。
  PULSE_FEE_VERIFY_THRESHOLD: null,
  // 单笔交易最大价格冲击比例 (0-1]。
  RISK_MAX_PRICE_IMPACT_PCT: null,
  // 启用交易所最小下单金额检查（true/false）。
  RISK_EXCHANGE_MIN_ORDER_CHECK: null,

  // ─── 证据收集设置 ──────────────────────────────────────────────────────────
  // 证据缓存 TTL（秒）。1800 = 30 分钟。
  EVIDENCE_CACHE_TTL_SECONDS: null,
  // 证据适配器默认 HTTP 超时（毫秒）。
  EVIDENCE_REQUEST_TIMEOUT_MS: null,
  // 证据适配器请求失败重试次数。
  EVIDENCE_REQUEST_RETRIES: null,

  // --- 页面抓取（Polymarket 事件页 / Gamma API）---
  // 抓取 Polymarket 事件页获取结算规则、注解、评论。
  // 对齐 Predict-Raven scrape-market.ts 深度研究步骤。
  EVIDENCE_PAGE_SCRAPE: null,
  // 页面抓取提取的最大社区评论数。
  EVIDENCE_PAGE_COMMENT_LIMIT: null,
  // 页面抓取 HTTP 请求超时（毫秒）。
  EVIDENCE_PAGE_TIMEOUT_MS: null,

  // --- 订单簿深度（Polymarket CLOB）---
  // 从 CLOB 获取订单簿深度作为市场微观结构证据。
  // 提供最优买/卖价、价差、2% 深度、前 N 档。对齐 Predict-Raven orderbook.ts。
  EVIDENCE_ORDERBOOK_DEPTH: null,
  // 订单簿 API 请求超时（毫秒）。
  EVIDENCE_ORDERBOOK_TIMEOUT_MS: null,
  // 每侧获取的订单簿档位数。
  EVIDENCE_ORDERBOOK_DEPTH_LEVELS: null,

  // --- 结算来源实时验证 ---
  // 实时获取并验证结算来源 URL。防止 AI 使用过时事实。
  // 对齐 Predict-Raven SKILL.md A0 模块。
  EVIDENCE_RESOLUTION_SOURCE_LIVE: null,
  // 结算来源 HTTP 获取超时（毫秒）。
  EVIDENCE_RESOLUTION_SOURCE_TIMEOUT_MS: null,
  // 从结算来源页面提取的最大字符数。
  EVIDENCE_RESOLUTION_SOURCE_MAX_CONTENT: null,

  // --- 领域专用研究适配器 ---
  // 启用 5 个领域适配器（体育、宏观、天气、链上、金融）。
  // 按市场类别/问题自动激活。使用 DuckDuckGo HTML 搜索。
  EVIDENCE_DOMAIN_ADAPTERS: null,
  // 每个领域适配器搜索请求超时（毫秒）。
  EVIDENCE_DOMAIN_ADAPTER_TIMEOUT_MS: null,

  // --- 证据缺口自动补全 ---
  // 自动补全 AI triage 识别的证据缺口。
  // 按缺口类别（新闻、社交、专家、官方等）搜索外部公开信息。
  EVIDENCE_GAP_AUTO_FILL: null,
  // 单个缺口搜索请求超时（毫秒）。
  EVIDENCE_GAP_FETCH_TIMEOUT_MS: null,
  // 每个市场所有缺口补全的总时间预算（毫秒）。
  EVIDENCE_GAP_TOTAL_BUDGET_MS: null,
  // 每个市场最大补全证据缺口数。
  EVIDENCE_GAP_MAX_PER_MARKET: null,
  // 概率估算前所需的最少证据条目。
  // 低于此阈值会发出警告（如 PULSE_REQUIRE_EVIDENCE_GUARD=true 则阻止）。
  MIN_EVIDENCE_ITEMS: null,

  // ─── Monitor 设置 ──────────────────────────────────────────────────────────
  // 运行 --loop 时各轮之间的间隔（秒）。
  MONITOR_INTERVAL_SECONDS: null,
  // 每轮允许的最大交易（开仓）数。
  MONITOR_MAX_TRADES_PER_ROUND: null,
  // 每日所有交易的最大部署金额（美元）。
  MONITOR_MAX_DAILY_TRADE_USD: null,
  // 每轮并发处理的候选数。
  MONITOR_CONCURRENCY: null,
  // 单轮 monitor 最大运行时间（毫秒）。
  MONITOR_RUN_TIMEOUT_MS: null,
  // 出错后重试前的退避延迟（毫秒）。
  MONITOR_BACKOFF_MS: null,
  // 关闭所有主动平仓逻辑，仓位仅在市场结算时退出。
  POSITION_HOLD_UNTIL_SETTLEMENT: null,
  // 单笔交易最大开仓金额（美元）。留空或 0 = 使用 MIN_TRADE_USD。
  MONITOR_MAX_AMOUNT_USD: null,
  // 逗号分隔的市场 slug。设置后只关注这些市场。
  MONITOR_WATCHLIST: null,
  // 逗号分隔的市场 slug，始终排除。
  MONITOR_BLOCKLIST: null,

  // ─── 产物保留 ──────────────────────────────────────────────────────────────
  // 运行时产物保留天数，超过后清理。
  ARTIFACT_RETENTION_DAYS: null,
  // 最大保留运行产物数（超出从最旧开始清除）。
  ARTIFACT_MAX_RUNS: null,

  // ─── AI Provider ──────────────────────────────────────────────────────────
  // 概率估算的主 AI 提供方。"codex" 或 "claude-code"。
  AI_PROVIDER: null,
  // 覆盖 AI 提供方模型。留空 = 使用提供方默认模型。
  AI_MODEL: null,

  // ─── Predict-Raven 兼容 Codex Provider 设置 ────────────────────────────────
  // Provider 子进程超时。0 = 无独立超时（使用 monitor 超时）。
  PROVIDER_TIMEOUT_SECONDS: null,
  // 覆盖 Codex CLI 模型。留空 = 使用 Codex CLI 默认。
  CODEX_MODEL: null,
  // Codex 读取的 skill 文件根目录。
  CODEX_SKILL_ROOT_DIR: null,
  // Skill 模板和提示词的语言："zh"（中文）或 "en"（英文）。
  CODEX_SKILL_LOCALE: null,
  // 逗号分隔的 skill ID。
  CODEX_SKILLS: null,
  // Codex 默认 reasoning effort：low、medium、high 或 xhigh。
  CODEX_REASONING_EFFORT: null,

  // ─── Claude Code Provider 设置 ────────────────────────────────────────────
  // 与上面 Codex 块对称，但通过 `claude --print` 路由 ProbabilityEstimate。

  // 覆盖 Claude Code 模型。留空 = 使用 Claude Code 默认。
  CLAUDE_CODE_MODEL: null,
  // Claude Code 读取的 skill 文件根目录。
  CLAUDE_CODE_SKILL_ROOT_DIR: null,
  // Skill 模板和提示词的语言："zh" 或 "en"。
  CLAUDE_CODE_SKILL_LOCALE: null,
  // 逗号分隔的 skill ID。
  CLAUDE_CODE_SKILLS: null,
  // Claude Code 权限模式（如 bypassPermissions 用于非交互式）。
  CLAUDE_CODE_PERMISSION_MODE: null,
  // Claude Code 允许的工具（逗号分隔，如 Read,Glob,Grep）。
  CLAUDE_CODE_ALLOWED_TOOLS: null,
  // 传给 claude 命令的额外 CLI 参数。
  CLAUDE_CODE_EXTRA_ARGS: null,
  // 单次 Claude Code 调用的最大预算（美元）。留空 = 无限制。
  CLAUDE_CODE_MAX_BUDGET_USD: null
};

const SECRET_KEYS = new Set([
  "PRIVATE_KEY",
  "API_KEY",
  "SECRET",
  "TOKEN",
  "COOKIE",
  "SESSION"
]);

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }
  const index = trimmed.indexOf("=");
  if (index < 0) {
    return null;
  }
  const key = trimmed.slice(0, index).trim();
  let value = trimmed.slice(index + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return key ? [key, value] : null;
}

export function parseEnvContent(content) {
  const values = {};
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (parsed) {
      values[parsed[0]] = parsed[1];
    }
  }
  return values;
}

function readNumber(values, key, fallback) {
  const raw = values[key];
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function normalizeWalletMode(value) {
  return value === "simulated" ? "simulated" : "real";
}

function normalizeMarketSource(value) {
  return String(value ?? "polymarket").trim().toLowerCase() || "polymarket";
}

function trimTrailingSlash(value) {
  return String(value ?? "").replace(/\/+$/, "");
}

function parseList(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export async function loadEnvConfig(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const explicitEnvFile = options.envFile ? path.resolve(options.envFile) : null;
  const defaultEnvFile = existsSync(path.resolve(".env")) ? path.resolve(".env") : null;
  const envFilePath = explicitEnvFile ?? defaultEnvFile;
  const fileValues = envFilePath && existsSync(envFilePath)
    ? parseEnvContent(await readFile(envFilePath, "utf8"))
    : {};

  if (!options.skipValidation) {
    const allSources = { ...fileValues, ...process.env, ...(options.overrides ?? {}) };
    const missing = Object.keys(DEFAULTS).filter(key => !Object.hasOwn(allSources, key));
    if (missing.length > 0) {
      const envPath = envFilePath ?? ".env";
      console.error(`\n[PolyPulse] 启动失败：以下环境变量未在 ${envPath} 中定义：\n`);
      for (const key of missing) {
        console.error(`  - ${key}`);
      }
      console.error(`\n共 ${missing.length} 项缺失。请补全后重试。`);
      console.error(`所有必需变量见 src/config/env.js 的 DEFAULTS 对象。\n`);
      process.exit(1);
    }
  }

  const values = {
    ...fileValues,
    ...process.env,
    ...(options.overrides ?? {})
  };

  return {
    repoRoot,
    envFilePath,
    liveWalletMode: normalizeWalletMode(values.POLYPULSE_LIVE_WALLET_MODE),
    simulatedWalletAddress: values.SIMULATED_WALLET_ADDRESS ?? "",
    simulatedWalletBalanceUsd: readNumber(values, "SIMULATED_WALLET_BALANCE_USD", 100),
    simulatedMonitorLogPath: path.resolve(values.SIMULATED_MONITOR_LOG_PATH || "logs/monitor.log"),
    privateKey: values.PRIVATE_KEY ?? "",
    funderAddress: values.FUNDER_ADDRESS ?? "",
    signatureType: values.SIGNATURE_TYPE ?? "",
    chainId: readNumber(values, "CHAIN_ID", 137),
    polymarketHost: values.POLYMARKET_HOST ?? "",
    marketSource: normalizeMarketSource(values.POLYPULSE_MARKET_SOURCE),
    polymarketGammaHost: trimTrailingSlash(values.POLYMARKET_GAMMA_HOST),
    stateDir: path.resolve(values.STATE_DIR || "runtime-artifacts/state"),
    artifactDir: path.resolve(values.ARTIFACT_DIR || "runtime-artifacts"),
    risk: {
      maxTradePct: readNumber(values, "MAX_TRADE_PCT", 0.05),
      maxTotalExposurePct: readNumber(values, "MAX_TOTAL_EXPOSURE_PCT", 0.5),
      maxEventExposurePct: readNumber(values, "MAX_EVENT_EXPOSURE_PCT", 0.2),
      maxPositionCount: Math.max(1, Math.floor(readNumber(values, "MAX_POSITION_COUNT", 20))),
      maxPositionLossPct: readNumber(values, "MAX_POSITION_LOSS_PCT", 0.5),
      drawdownHaltPct: readNumber(values, "DRAWDOWN_HALT_PCT", 0.2),
      liquidityTradeCapPct: readNumber(values, "LIQUIDITY_TRADE_CAP_PCT", 0.01),
      marketMaxAgeSeconds: Math.max(1, Math.floor(readNumber(values, "MARKET_MAX_AGE_SECONDS", 600))),
      minAiConfidence: String(values.MIN_AI_CONFIDENCE || "medium").toLowerCase(),
      minTradeUsd: readNumber(values, "MIN_TRADE_USD", 1),
      maxPriceImpactPct: readNumber(values, "RISK_MAX_PRICE_IMPACT_PCT", 0.04),
      exchangeMinOrderCheck: String(values.RISK_EXCHANGE_MIN_ORDER_CHECK ?? "true").toLowerCase() !== "false"
    },
    scan: {
      marketScanLimit: Math.max(1, Math.floor(readNumber(values, "MARKET_SCAN_LIMIT", 5000))),
      pageSize: Math.max(1, Math.min(500, Math.floor(readNumber(values, "MARKET_PAGE_SIZE", 100)))),
      maxPages: Math.max(1, Math.floor(readNumber(values, "MARKET_MAX_PAGES", 20))),
      cacheTtlSeconds: Math.max(0, Math.floor(readNumber(values, "MARKET_CACHE_TTL_SECONDS", 0))),
      requestTimeoutMs: Math.max(1000, Math.floor(readNumber(values, "MARKET_REQUEST_TIMEOUT_MS", 10000))),
      requestRetries: Math.max(0, Math.floor(readNumber(values, "MARKET_REQUEST_RETRIES", 2))),
      rateLimitMs: Math.max(0, Math.floor(readNumber(values, "MARKET_RATE_LIMIT_MS", 250))),
      minFetchedMarkets: Math.max(0, Math.floor(readNumber(values, "MARKET_MIN_FETCHED", 20)))
    },
    pulse: {
      strategy: values.PULSE_STRATEGY === "pulse-direct" ? "pulse-direct" : String(values.PULSE_STRATEGY ?? "pulse-direct").trim(),
      minLiquidityUsd: readNumber(values, "PULSE_MIN_LIQUIDITY_USD", 5000),
      maxCandidates: Math.max(1, Math.floor(readNumber(values, "PULSE_MAX_CANDIDATES", 20))),
      reportCandidates: Math.max(1, Math.floor(readNumber(values, "PULSE_REPORT_CANDIDATES", 4))),
      batchCapPct: readNumber(values, "PULSE_BATCH_CAP_PCT", 0.2),
      aiCandidateTriage: String(values.PULSE_AI_CANDIDATE_TRIAGE ?? "true").toLowerCase() === "true",
      aiTriageCanReject: String(values.PULSE_AI_TRIAGE_CAN_REJECT ?? "true").toLowerCase() === "true",
      aiPrescreen: String(values.PULSE_AI_PRESCREEN ?? "true").toLowerCase() !== "false",
      prescreenTimeoutMs: Math.max(1000, Math.floor(readNumber(values, "PULSE_PRESCREEN_TIMEOUT_MS", 60000))),
      aiEvidenceResearch: String(values.PULSE_AI_EVIDENCE_RESEARCH ?? "true").toLowerCase() !== "false",
      evidenceResearchTimeoutMs: Math.max(1000, Math.floor(readNumber(values, "PULSE_EVIDENCE_RESEARCH_TIMEOUT_MS", 60000))),
      evidenceResearchMaxSearches: Math.max(1, Math.floor(readNumber(values, "PULSE_EVIDENCE_RESEARCH_MAX_SEARCHES", 5))),
      aiTopicDiscovery: String(values.PULSE_AI_TOPIC_DISCOVERY ?? "true").toLowerCase() !== "false",
      topicDiscoveryTimeoutMs: Math.max(1000, Math.floor(readNumber(values, "PULSE_TOPIC_DISCOVERY_TIMEOUT_MS", 60000))),
      semanticDiscovery: String(values.PULSE_SEMANTIC_DISCOVERY ?? "true").toLowerCase() !== "false",
      semanticDiscoveryMaxMatched: Math.max(1, Math.floor(readNumber(values, "PULSE_SEMANTIC_DISCOVERY_MAX_MATCHED", 10))),
      semanticDiscoverySimilarityThreshold: Math.max(0, Math.min(1, readNumber(values, "PULSE_SEMANTIC_DISCOVERY_SIMILARITY_THRESHOLD", 0.3))),
      downsideRiskRanking: String(values.PULSE_DOWNSIDE_RISK_RANKING ?? "true").toLowerCase() !== "false",
      performanceReportInterval: Math.max(1, Math.floor(readNumber(values, "PULSE_PERFORMANCE_REPORT_INTERVAL", 5))),
      fetchDimensions: parseList(values.PULSE_FETCH_DIMENSIONS),
      requireEvidenceGuard: String(values.PULSE_REQUIRE_EVIDENCE_GUARD ?? "false").toLowerCase() === "true"
    },
    monitor: {
      intervalSeconds: Math.max(1, Math.floor(readNumber(values, "MONITOR_INTERVAL_SECONDS", 300))),
      maxTradesPerRound: Math.max(0, Math.floor(readNumber(values, "MONITOR_MAX_TRADES_PER_ROUND", 3))),
      maxDailyTradeUsd: Math.max(0, readNumber(values, "MONITOR_MAX_DAILY_TRADE_USD", 25)),
      concurrency: Math.max(1, Math.floor(readNumber(values, "MONITOR_CONCURRENCY", 3))),
      runTimeoutMs: Math.max(1000, Math.floor(readNumber(values, "MONITOR_RUN_TIMEOUT_MS", 120000))),
      backoffMs: Math.max(0, Math.floor(readNumber(values, "MONITOR_BACKOFF_MS", 1000))),
      maxAmountUsd: readNumber(values, "MONITOR_MAX_AMOUNT_USD", 0),
      holdUntilSettlement: String(values.POSITION_HOLD_UNTIL_SETTLEMENT ?? "false").toLowerCase() === "true",
      watchlist: parseList(values.MONITOR_WATCHLIST),
      blocklist: parseList(values.MONITOR_BLOCKLIST)
    },
    artifacts: {
      retentionDays: Math.max(0, Math.floor(readNumber(values, "ARTIFACT_RETENTION_DAYS", 14))),
      maxRuns: Math.max(0, Math.floor(readNumber(values, "ARTIFACT_MAX_RUNS", 500)))
    },
    evidence: {
      cacheTtlSeconds: Math.max(0, Math.floor(readNumber(values, "EVIDENCE_CACHE_TTL_SECONDS", 1800))),
      requestTimeoutMs: Math.max(1000, Math.floor(readNumber(values, "EVIDENCE_REQUEST_TIMEOUT_MS", 10000))),
      requestRetries: Math.max(0, Math.floor(readNumber(values, "EVIDENCE_REQUEST_RETRIES", 1))),
      pageScrape: String(values.EVIDENCE_PAGE_SCRAPE ?? "true").toLowerCase() !== "false",
      pageCommentLimit: Math.max(1, Math.floor(readNumber(values, "EVIDENCE_PAGE_COMMENT_LIMIT", 10))),
      pageTimeoutMs: Math.max(1000, Math.floor(readNumber(values, "EVIDENCE_PAGE_TIMEOUT_MS", 15000))),
      orderbookDepth: String(values.EVIDENCE_ORDERBOOK_DEPTH ?? "true").toLowerCase() !== "false",
      orderbookTimeoutMs: Math.max(1000, Math.floor(readNumber(values, "EVIDENCE_ORDERBOOK_TIMEOUT_MS", 10000))),
      orderbookDepthLevels: Math.max(1, Math.floor(readNumber(values, "EVIDENCE_ORDERBOOK_DEPTH_LEVELS", 5))),
      resolutionSourceLive: String(values.EVIDENCE_RESOLUTION_SOURCE_LIVE ?? "true").toLowerCase() !== "false",
      resolutionSourceTimeoutMs: Math.max(1000, Math.floor(readNumber(values, "EVIDENCE_RESOLUTION_SOURCE_TIMEOUT_MS", 15000))),
      resolutionSourceMaxContent: Math.max(1000, Math.floor(readNumber(values, "EVIDENCE_RESOLUTION_SOURCE_MAX_CONTENT", 8000))),
      domainAdapters: String(values.EVIDENCE_DOMAIN_ADAPTERS ?? "true").toLowerCase() !== "false",
      domainAdapterTimeoutMs: Math.max(1000, Math.floor(readNumber(values, "EVIDENCE_DOMAIN_ADAPTER_TIMEOUT_MS", 10000))),
      gapAutoFill: String(values.EVIDENCE_GAP_AUTO_FILL ?? "true").toLowerCase() !== "false",
      gapFetchTimeoutMs: Math.max(1000, Math.floor(readNumber(values, "EVIDENCE_GAP_FETCH_TIMEOUT_MS", 10000))),
      gapTotalBudgetMs: Math.max(1000, Math.floor(readNumber(values, "EVIDENCE_GAP_TOTAL_BUDGET_MS", 30000))),
      gapMaxPerMarket: Math.max(1, Math.floor(readNumber(values, "EVIDENCE_GAP_MAX_PER_MARKET", 3))),
      minEvidenceItems: Math.max(0, Math.floor(readNumber(values, "MIN_EVIDENCE_ITEMS", 2)))
    },
    calibration: {
      enabled: String(values.PULSE_CALIBRATION_ENABLED ?? "true").toLowerCase() !== "false",
      dynamicEnabled: String(values.PULSE_DYNAMIC_CALIBRATION ?? "true").toLowerCase() !== "false"
    },
    dynamicFee: {
      enabled: String(values.PULSE_DYNAMIC_FEE_ENABLED ?? "true").toLowerCase() !== "false",
      ttlMs: Math.max(0, Math.floor(readNumber(values, "PULSE_DYNAMIC_FEE_TTL_MS", 3600000))),
      verifyEnabled: String(values.PULSE_FEE_VERIFY_ENABLED ?? "true").toLowerCase() !== "false",
      verifyThreshold: Math.max(0, readNumber(values, "PULSE_FEE_VERIFY_THRESHOLD", 0))
    },
    ai: {
      provider: values.AI_PROVIDER ?? "codex",
      model: values.AI_MODEL ?? ""
    },
    providerTimeoutSeconds: Math.max(0, Math.floor(readNumber(values, "PROVIDER_TIMEOUT_SECONDS", 0))),
    providers: {
      codex: {
        model: values.CODEX_MODEL || values.AI_MODEL || "",
        skillRootDir: path.resolve(repoRoot, values.CODEX_SKILL_ROOT_DIR || "skills"),
        skillLocale: ["en", "zh"].includes(values.CODEX_SKILL_LOCALE) ? values.CODEX_SKILL_LOCALE : "zh",
        skills: values.CODEX_SKILLS,
        reasoningEffort: ["low", "medium", "high", "xhigh"].includes(String(values.CODEX_REASONING_EFFORT).toLowerCase())
          ? String(values.CODEX_REASONING_EFFORT).toLowerCase()
          : ""
      },
      claudeCode: {
        model: values.CLAUDE_CODE_MODEL || values.AI_MODEL || "",
        skillRootDir: path.resolve(repoRoot, values.CLAUDE_CODE_SKILL_ROOT_DIR || "skills"),
        skillLocale: ["en", "zh"].includes(values.CLAUDE_CODE_SKILL_LOCALE) ? values.CLAUDE_CODE_SKILL_LOCALE : "zh",
        skills: values.CLAUDE_CODE_SKILLS,
        permissionMode: values.CLAUDE_CODE_PERMISSION_MODE,
        allowedTools: values.CLAUDE_CODE_ALLOWED_TOOLS ?? "",
        extraArgs: values.CLAUDE_CODE_EXTRA_ARGS ?? "",
        maxBudgetUsd: values.CLAUDE_CODE_MAX_BUDGET_USD ?? ""
      }
    }
  };
}

function check(key, ok, summary, blocking = true) {
  return { key, ok, blocking, summary };
}

export function validateEnvConfig(config) {
  const walletMode = normalizeWalletMode(config.liveWalletMode);
  const pulse = {
    strategy: config.pulse?.strategy ?? "pulse-direct",
    minLiquidityUsd: config.pulse?.minLiquidityUsd ?? 0,
    maxCandidates: config.pulse?.maxCandidates ?? 1,
    reportCandidates: config.pulse?.reportCandidates ?? 1,
    batchCapPct: config.pulse?.batchCapPct ?? 0.2
  };
  const provider = String(config.ai?.provider ?? "").trim();
  const checks = [
    check("market-source", config.marketSource === "polymarket", `marketSource=${config.marketSource}; only polymarket is supported.`),
    check("AI_PROVIDER", ["codex", "claude-code"].includes(provider), `AI_PROVIDER=${config.ai?.provider}; only codex or claude-code is supported.`),
    check("polymarket-gamma-host", Boolean(config.polymarketGammaHost), `POLYMARKET_GAMMA_HOST=${config.polymarketGammaHost}`),
    check("state-dir", Boolean(config.stateDir), `stateDir=${config.stateDir}`),
    check("artifact-dir", Boolean(config.artifactDir), `artifactDir=${config.artifactDir}`),
    check("risk.maxTradePct", config.risk.maxTradePct > 0 && config.risk.maxTradePct <= 1, "MAX_TRADE_PCT must be in (0, 1]."),
    check("risk.maxTotalExposurePct", config.risk.maxTotalExposurePct > 0 && config.risk.maxTotalExposurePct <= 1, "MAX_TOTAL_EXPOSURE_PCT must be in (0, 1]."),
    check("risk.maxEventExposurePct", config.risk.maxEventExposurePct > 0 && config.risk.maxEventExposurePct <= 1, "MAX_EVENT_EXPOSURE_PCT must be in (0, 1]."),
    check("risk.maxPositionCount", config.risk.maxPositionCount > 0, "MAX_POSITION_COUNT must be > 0."),
    check("risk.maxPositionLossPct", config.risk.maxPositionLossPct > 0 && config.risk.maxPositionLossPct <= 1, "MAX_POSITION_LOSS_PCT must be in (0, 1]."),
    check("risk.drawdownHaltPct", config.risk.drawdownHaltPct > 0 && config.risk.drawdownHaltPct <= 1, "DRAWDOWN_HALT_PCT must be in (0, 1]."),
    check("risk.liquidityTradeCapPct", config.risk.liquidityTradeCapPct > 0 && config.risk.liquidityTradeCapPct <= 1, "LIQUIDITY_TRADE_CAP_PCT must be in (0, 1]."),
    check("risk.marketMaxAgeSeconds", config.risk.marketMaxAgeSeconds > 0, "MARKET_MAX_AGE_SECONDS must be > 0."),
    check("risk.minAiConfidence", ["low", "medium", "high"].includes(config.risk.minAiConfidence), "MIN_AI_CONFIDENCE must be low, medium, or high."),
    check("risk.minTradeUsd", config.risk.minTradeUsd >= 0, "MIN_TRADE_USD must be >= 0."),
    check("scan.pageSize", config.scan.pageSize > 0 && config.scan.pageSize <= 500, "MARKET_PAGE_SIZE must be in [1, 500]."),
    check("scan.maxPages", config.scan.maxPages > 0, "MARKET_MAX_PAGES must be > 0."),
    check("scan.requestTimeoutMs", config.scan.requestTimeoutMs >= 1000, "MARKET_REQUEST_TIMEOUT_MS must be >= 1000."),
    check("pulse.strategy", pulse.strategy === "pulse-direct", "PULSE_STRATEGY must be pulse-direct."),
    check("pulse.minLiquidityUsd", pulse.minLiquidityUsd >= 0, "PULSE_MIN_LIQUIDITY_USD must be >= 0."),
    check("pulse.maxCandidates", pulse.maxCandidates > 0, "PULSE_MAX_CANDIDATES must be > 0."),
    check("pulse.reportCandidates", pulse.reportCandidates > 0, "PULSE_REPORT_CANDIDATES must be > 0."),
    check("pulse.batchCapPct", pulse.batchCapPct > 0 && pulse.batchCapPct <= 1, "PULSE_BATCH_CAP_PCT must be in (0, 1]."),
    check("pulse.aiCandidateTriage", typeof config.pulse.aiCandidateTriage === "boolean", "PULSE_AI_CANDIDATE_TRIAGE must be true or false."),
    check("pulse.aiTriageCanReject", typeof config.pulse.aiTriageCanReject === "boolean", "PULSE_AI_TRIAGE_CAN_REJECT must be true or false."),
    check("evidence.requestTimeoutMs", config.evidence.requestTimeoutMs >= 1000, "EVIDENCE_REQUEST_TIMEOUT_MS must be >= 1000."),
    check("monitor.maxTradesPerRound", (config.monitor?.maxTradesPerRound ?? 0) >= 0, "MONITOR_MAX_TRADES_PER_ROUND must be >= 0."),
    check("monitor.maxDailyTradeUsd", (config.monitor?.maxDailyTradeUsd ?? 0) >= 0, "MONITOR_MAX_DAILY_TRADE_USD must be >= 0."),
    check("monitor.concurrency", (config.monitor?.concurrency ?? 1) > 0, "MONITOR_CONCURRENCY must be > 0."),
    check("monitor.runTimeoutMs", (config.monitor?.runTimeoutMs ?? 1000) >= 1000, "MONITOR_RUN_TIMEOUT_MS must be >= 1000."),
    check("artifacts.retentionDays", (config.artifacts?.retentionDays ?? 0) >= 0, "ARTIFACT_RETENTION_DAYS must be >= 0."),
    check("artifacts.maxRuns", (config.artifacts?.maxRuns ?? 0) >= 0, "ARTIFACT_MAX_RUNS must be >= 0.")
  ];

  checks.push(
    check("env-file", Boolean(config.envFilePath), "requires an explicit env file or .env."),
    check("POLYPULSE_LIVE_WALLET_MODE", ["real", "simulated"].includes(walletMode), "POLYPULSE_LIVE_WALLET_MODE must be real or simulated."),
    check("CHAIN_ID", config.chainId === 137, "CHAIN_ID must be 137 for Polygon mainnet.")
  );
  if (walletMode === "real") {
    checks.push(
      check("PRIVATE_KEY", Boolean(config.privateKey), "PRIVATE_KEY is required with a real wallet."),
      check("FUNDER_ADDRESS", Boolean(config.funderAddress), "FUNDER_ADDRESS is required with a real wallet."),
      check("FUNDER_ADDRESS_FORMAT", /^0x[a-fA-F0-9]{40}$/.test(config.funderAddress), "FUNDER_ADDRESS must be a 20-byte hex address."),
      check("SIGNATURE_TYPE", Boolean(config.signatureType), "SIGNATURE_TYPE is required with a real wallet."),
      check("POLYMARKET_HOST", Boolean(config.polymarketHost), "POLYMARKET_HOST is required with a real wallet.")
    );
  } else {
    checks.push(
      check("SIMULATED_WALLET_BALANCE_USD", Number(config.simulatedWalletBalanceUsd) >= 0, "SIMULATED_WALLET_BALANCE_USD must be >= 0."),
      check("SIMULATED_WALLET_ADDRESS_FORMAT", !config.simulatedWalletAddress || /^0x[a-fA-F0-9]{40}$/.test(config.simulatedWalletAddress), "SIMULATED_WALLET_ADDRESS must be blank or a 20-byte hex address.")
    );
  }

  return {
    ok: checks.every((item) => item.ok || !item.blocking),
    envFilePath: config.envFilePath,
    chainId: config.chainId,
    liveWalletMode: walletMode,
    funderAddress: maskAddress(config.funderAddress || config.simulatedWalletAddress),
    polymarketHost: config.polymarketHost || "-",
    checks
  };
}

export function summarizeEnvConfig(config) {
  return {
    envFilePath: config.envFilePath,
    chainId: config.chainId,
    liveWalletMode: normalizeWalletMode(config.liveWalletMode),
    funderAddress: maskAddress(config.funderAddress || config.simulatedWalletAddress),
    polymarketHost: config.polymarketHost || "-",
    marketSource: config.marketSource,
    pulseStrategy: config.pulse?.strategy ?? "pulse-direct"
  };
}

export function assertLivePreflight(config) {
  const report = validateEnvConfig(config);
  if (!report.ok) {
    const missing = report.checks.filter((item) => item.blocking && !item.ok).map((item) => item.key).join(", ");
    throw new Error(`live_preflight_failed: ${missing}`);
  }
  return report;
}

export function maskAddress(value) {
  if (!value) {
    return "-";
  }
  return value.length <= 10 ? `${value.slice(0, 3)}***` : `${value.slice(0, 6)}***${value.slice(-4)}`;
}

export function redactSecrets(value) {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        const upper = key.toUpperCase();
        const isSecret = [...SECRET_KEYS].some((needle) => upper.includes(needle));
        return [key, isSecret ? "[REDACTED]" : redactSecrets(entry)];
      })
    );
  }
  if (typeof value === "string" && /(?:PRIVATE_KEY|API_KEY|SECRET|TOKEN|COOKIE|SESSION)\s*[:=]/i.test(value)) {
    return "[REDACTED]";
  }
  return value;
}
