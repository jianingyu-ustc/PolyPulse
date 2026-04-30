import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

const DEFAULTS = {
  POLYPULSE_EXECUTION_MODE: "paper",
  PRIVATE_KEY: "",
  FUNDER_ADDRESS: "",
  SIGNATURE_TYPE: "",
  CHAIN_ID: "137",
  POLYMARKET_HOST: "",
  POLYPULSE_MARKET_SOURCE: "polymarket",
  POLYMARKET_GAMMA_HOST: "https://gamma-api.polymarket.com",
  STATE_DIR: "runtime-artifacts/state",
  ARTIFACT_DIR: "runtime-artifacts",
  MAX_TRADE_PCT: "0.05",
  MAX_TOTAL_EXPOSURE_PCT: "0.5",
  MAX_EVENT_EXPOSURE_PCT: "0.2",
  MAX_POSITION_COUNT: "20",
  MAX_POSITION_LOSS_PCT: "0.5",
  DRAWDOWN_HALT_PCT: "0.2",
  LIQUIDITY_TRADE_CAP_PCT: "0.01",
  MARKET_MAX_AGE_SECONDS: "600",
  MIN_AI_CONFIDENCE: "medium",
  MIN_TRADE_USD: "1",
  MARKET_SCAN_LIMIT: "1000",
  MARKET_PAGE_SIZE: "100",
  MARKET_MAX_PAGES: "20",
  MARKET_CACHE_TTL_SECONDS: "300",
  MARKET_REQUEST_TIMEOUT_MS: "10000",
  MARKET_REQUEST_RETRIES: "2",
  MARKET_RATE_LIMIT_MS: "250",
  MARKET_MIN_FETCHED: "20",
  EVIDENCE_CACHE_TTL_SECONDS: "1800",
  EVIDENCE_REQUEST_TIMEOUT_MS: "10000",
  EVIDENCE_REQUEST_RETRIES: "1",
  MIN_EVIDENCE_ITEMS: "2",
  MONITOR_INTERVAL_SECONDS: "300",
  MONITOR_MAX_TRADES_PER_ROUND: "3",
  MONITOR_MAX_DAILY_TRADE_USD: "25",
  MONITOR_CONCURRENCY: "3",
  MONITOR_RUN_TIMEOUT_MS: "120000",
  MONITOR_BACKOFF_MS: "1000",
  MONITOR_WATCHLIST: "",
  MONITOR_BLOCKLIST: "",
  ARTIFACT_RETENTION_DAYS: "14",
  ARTIFACT_MAX_RUNS: "500",
  AI_PROVIDER: "local",
  AI_MODEL: "",
  AI_COMMAND: ""
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

function normalizeMode(value) {
  return value === "live" ? "live" : "paper";
}

function normalizeMarketSource(value) {
  return value === "mock" ? "mock" : "polymarket";
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
  const explicitEnvFile = options.envFile ? path.resolve(options.envFile) : null;
  const defaultEnvFile = existsSync(path.resolve(".env")) ? path.resolve(".env") : null;
  const envFilePath = explicitEnvFile ?? defaultEnvFile;
  const fileValues = envFilePath && existsSync(envFilePath)
    ? parseEnvContent(await readFile(envFilePath, "utf8"))
    : {};
  const values = {
    ...DEFAULTS,
    ...fileValues,
    ...process.env,
    ...(options.overrides ?? {})
  };

  return {
    envFilePath,
    executionMode: normalizeMode(values.POLYPULSE_EXECUTION_MODE),
    privateKey: values.PRIVATE_KEY ?? "",
    funderAddress: values.FUNDER_ADDRESS ?? "",
    signatureType: values.SIGNATURE_TYPE ?? "",
    chainId: readNumber(values, "CHAIN_ID", 137),
    polymarketHost: values.POLYMARKET_HOST ?? "",
    marketSource: normalizeMarketSource(values.POLYPULSE_MARKET_SOURCE),
    polymarketGammaHost: trimTrailingSlash(values.POLYMARKET_GAMMA_HOST || DEFAULTS.POLYMARKET_GAMMA_HOST),
    stateDir: path.resolve(values.STATE_DIR || DEFAULTS.STATE_DIR),
    artifactDir: path.resolve(values.ARTIFACT_DIR || DEFAULTS.ARTIFACT_DIR),
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
      minTradeUsd: readNumber(values, "MIN_TRADE_USD", 1)
    },
    scan: {
      marketScanLimit: Math.max(1, Math.floor(readNumber(values, "MARKET_SCAN_LIMIT", 1000))),
      pageSize: Math.max(1, Math.min(500, Math.floor(readNumber(values, "MARKET_PAGE_SIZE", 100)))),
      maxPages: Math.max(1, Math.floor(readNumber(values, "MARKET_MAX_PAGES", 20))),
      cacheTtlSeconds: Math.max(0, Math.floor(readNumber(values, "MARKET_CACHE_TTL_SECONDS", 300))),
      requestTimeoutMs: Math.max(1000, Math.floor(readNumber(values, "MARKET_REQUEST_TIMEOUT_MS", 10000))),
      requestRetries: Math.max(0, Math.floor(readNumber(values, "MARKET_REQUEST_RETRIES", 2))),
      rateLimitMs: Math.max(0, Math.floor(readNumber(values, "MARKET_RATE_LIMIT_MS", 250))),
      minFetchedMarkets: Math.max(0, Math.floor(readNumber(values, "MARKET_MIN_FETCHED", 20)))
    },
    monitor: {
      intervalSeconds: Math.max(1, Math.floor(readNumber(values, "MONITOR_INTERVAL_SECONDS", 300))),
      maxTradesPerRound: Math.max(0, Math.floor(readNumber(values, "MONITOR_MAX_TRADES_PER_ROUND", 3))),
      maxDailyTradeUsd: Math.max(0, readNumber(values, "MONITOR_MAX_DAILY_TRADE_USD", 25)),
      concurrency: Math.max(1, Math.floor(readNumber(values, "MONITOR_CONCURRENCY", 3))),
      runTimeoutMs: Math.max(1000, Math.floor(readNumber(values, "MONITOR_RUN_TIMEOUT_MS", 120000))),
      backoffMs: Math.max(0, Math.floor(readNumber(values, "MONITOR_BACKOFF_MS", 1000))),
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
      minEvidenceItems: Math.max(0, Math.floor(readNumber(values, "MIN_EVIDENCE_ITEMS", 2)))
    },
    ai: {
      provider: values.AI_PROVIDER ?? "local",
      model: values.AI_MODEL ?? "",
      command: values.AI_COMMAND ?? ""
    }
  };
}

function check(key, ok, summary, blocking = true) {
  return { key, ok, blocking, summary };
}

export function validateEnvConfig(config, options = {}) {
  const mode = normalizeMode(options.mode ?? config.executionMode);
  const checks = [
    check("execution-mode", ["paper", "live"].includes(mode), `mode=${mode}`),
    check("market-source", ["mock", "polymarket"].includes(config.marketSource), `marketSource=${config.marketSource}`),
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
    check("evidence.requestTimeoutMs", config.evidence.requestTimeoutMs >= 1000, "EVIDENCE_REQUEST_TIMEOUT_MS must be >= 1000."),
    check("monitor.maxTradesPerRound", (config.monitor?.maxTradesPerRound ?? 0) >= 0, "MONITOR_MAX_TRADES_PER_ROUND must be >= 0."),
    check("monitor.maxDailyTradeUsd", (config.monitor?.maxDailyTradeUsd ?? 0) >= 0, "MONITOR_MAX_DAILY_TRADE_USD must be >= 0."),
    check("monitor.concurrency", (config.monitor?.concurrency ?? 1) > 0, "MONITOR_CONCURRENCY must be > 0."),
    check("monitor.runTimeoutMs", (config.monitor?.runTimeoutMs ?? 1000) >= 1000, "MONITOR_RUN_TIMEOUT_MS must be >= 1000."),
    check("artifacts.retentionDays", (config.artifacts?.retentionDays ?? 0) >= 0, "ARTIFACT_RETENTION_DAYS must be >= 0."),
    check("artifacts.maxRuns", (config.artifacts?.maxRuns ?? 0) >= 0, "ARTIFACT_MAX_RUNS must be >= 0.")
  ];

  if (mode === "live") {
    checks.push(
      check("env-file", Boolean(config.envFilePath), "live mode requires an explicit env file or .env."),
      check("PRIVATE_KEY", Boolean(config.privateKey), "PRIVATE_KEY is required for live mode."),
      check("FUNDER_ADDRESS", Boolean(config.funderAddress), "FUNDER_ADDRESS is required for live mode."),
      check("FUNDER_ADDRESS_FORMAT", /^0x[a-fA-F0-9]{40}$/.test(config.funderAddress), "FUNDER_ADDRESS must be a 20-byte hex address."),
      check("SIGNATURE_TYPE", Boolean(config.signatureType), "SIGNATURE_TYPE is required for live mode."),
      check("CHAIN_ID", config.chainId === 137, "CHAIN_ID must be 137 for Polygon mainnet."),
      check("POLYMARKET_HOST", Boolean(config.polymarketHost), "POLYMARKET_HOST is required for live mode.")
    );
  }

  return {
    ok: checks.every((item) => item.ok || !item.blocking),
    mode,
    envFilePath: config.envFilePath,
    chainId: config.chainId,
    funderAddress: maskAddress(config.funderAddress),
    polymarketHost: config.polymarketHost || "-",
    checks
  };
}

export function summarizeEnvConfig(config, options = {}) {
  const mode = normalizeMode(options.mode ?? config.executionMode);
  return {
    executionMode: mode,
    envFilePath: config.envFilePath,
    chainId: config.chainId,
    funderAddress: maskAddress(config.funderAddress),
    polymarketHost: config.polymarketHost || "-",
    marketSource: config.marketSource
  };
}

export function assertLivePreflight(config) {
  const report = validateEnvConfig(config, { mode: "live" });
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
