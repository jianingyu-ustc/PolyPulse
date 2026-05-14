const MS_PER_DAY = 86_400_000;
const FALLBACK_DAYS = 180;
const DEFAULT_MAX_PLANS = 4;
const DEFAULT_BATCH_CAP_PCT = 0.2;

export const PULSE_FETCH_DIMENSIONS = ["volume24hr", "liquidity", "startDate", "competitive"];

const CATEGORY_FEE_PARAMS = {
  geopolitics: { feeRate: 0, exponent: 0 },
  sports: { feeRate: 0.03, exponent: 1 },
  tech: { feeRate: 0.04, exponent: 1 },
  politics: { feeRate: 0.04, exponent: 1 },
  finance: { feeRate: 0.04, exponent: 1 },
  economics: { feeRate: 0.03, exponent: 0.5 },
  crypto: { feeRate: 0.072, exponent: 1 },
  culture: { feeRate: 0.05, exponent: 1 },
  weather: { feeRate: 0.025, exponent: 0.5 },
  other: { feeRate: 0.2, exponent: 2 },
  mentions: { feeRate: 0.25, exponent: 2 }
};

const DEFAULT_FEE_PARAMS = CATEGORY_FEE_PARAMS.other;
const NEG_RISK_FEE_PARAMS = { feeRate: 0, exponent: 0 };

const CATEGORY_ALIASES = [
  { pattern: "politic", canonical: "politics" },
  { pattern: "trump", canonical: "politics" },
  { pattern: "election", canonical: "politics" },
  { pattern: "sport", canonical: "sports" },
  { pattern: "nba", canonical: "sports" },
  { pattern: "nfl", canonical: "sports" },
  { pattern: "mlb", canonical: "sports" },
  { pattern: "soccer", canonical: "sports" },
  { pattern: "football", canonical: "sports" },
  { pattern: "crypto", canonical: "crypto" },
  { pattern: "bitcoin", canonical: "crypto" },
  { pattern: "ethereum", canonical: "crypto" },
  { pattern: "defi", canonical: "crypto" },
  { pattern: "tech", canonical: "tech" },
  { pattern: "ai", canonical: "tech" },
  { pattern: "finance", canonical: "finance" },
  { pattern: "stock", canonical: "finance" },
  { pattern: "econ", canonical: "economics" },
  { pattern: "fed", canonical: "economics" },
  { pattern: "inflation", canonical: "economics" },
  { pattern: "gdp", canonical: "economics" },
  { pattern: "weather", canonical: "weather" },
  { pattern: "climate", canonical: "weather" },
  { pattern: "hurricane", canonical: "weather" },
  { pattern: "culture", canonical: "culture" },
  { pattern: "entertain", canonical: "culture" },
  { pattern: "movie", canonical: "culture" },
  { pattern: "music", canonical: "culture" },
  { pattern: "oscar", canonical: "culture" },
  { pattern: "mention", canonical: "mentions" },
  { pattern: "geopolitic", canonical: "geopolitics" },
  { pattern: "war", canonical: "geopolitics" },
  { pattern: "conflict", canonical: "geopolitics" }
];

const PRICE_MARKET_CATEGORY_HINTS = [
  "crypto",
  "bitcoin",
  "ethereum",
  "stock",
  "finance",
  "commodit"
];

const PRICE_MARKET_TEXT_PATTERNS = [
  /\babove\s+\$?\d/i,
  /\bbelow\s+\$?\d/i,
  /\bprice\b.*\b(above|below|higher|lower)\b/i,
  /\b(to|at)\s+\$?\d[\d,]*(\.\d+)?\b/i,
  /\b\d[\d,]*(\.\d+)?\s*(k|m|b)?\s+on\s+[a-z]+\s+\d{1,2}\b/i
];

function round(value, digits = 6) {
  return Number(Number(value).toFixed(digits));
}

function roundCurrency(value) {
  return Number(Number(value).toFixed(2));
}

function daysUntil(endDate, nowMs = Date.now()) {
  const endMs = new Date(endDate ?? "").getTime();
  if (!Number.isFinite(endMs) || endMs <= 0) {
    return FALLBACK_DAYS;
  }
  return Math.max((endMs - nowMs) / MS_PER_DAY, 1);
}

function categoryText(market) {
  return [
    market?.category,
    market?.marketSlug,
    market?.eventSlug,
    market?.question,
    ...(market?.tags ?? [])
  ].filter(Boolean).join(" ").toLowerCase();
}

function hasClobTokenIds(market) {
  return (market?.outcomes ?? []).some((outcome) => Boolean(outcome.tokenId));
}

function seededHash(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function isPulseDirectStrategy(config = {}) {
  return (config.pulse?.strategy ?? "pulse-direct") === "pulse-direct";
}

export function isShortTermPriceMarket(market, nowMs = Date.now()) {
  if (daysUntil(market?.endDate, nowMs) >= 7) {
    return false;
  }
  const text = categoryText(market);
  const hasPriceCategory = PRICE_MARKET_CATEGORY_HINTS.some((hint) => text.includes(hint));
  const hasPriceLanguage = PRICE_MARKET_TEXT_PATTERNS.some((pattern) => pattern.test(text));
  return hasPriceCategory && hasPriceLanguage;
}

export function applyPulseMarketSelection(markets, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const maxCandidates = Math.max(1, Math.floor(Number(options.maxCandidates ?? 20)));
  const minLiquidityUsd = Number(options.minLiquidityUsd ?? 0);
  const removed = {
    missingClobTokenIds: 0,
    shortTermPrice: 0,
    lowLiquidity: 0
  };
  let candidates = [...markets];

  const withClob = candidates.filter((market) => {
    const keep = hasClobTokenIds(market);
    if (!keep) removed.missingClobTokenIds += 1;
    return keep;
  });
  candidates = withClob.filter((market) => {
    const keep = Number(market.liquidityUsd ?? 0) >= minLiquidityUsd;
    if (!keep) removed.lowLiquidity += 1;
    return keep;
  });
  candidates = candidates.filter((market) => {
    const keep = !isShortTermPriceMarket(market, nowMs);
    if (!keep) removed.shortTermPrice += 1;
    return keep;
  });

  const shuffled = candidates
    .map((market) => ({ market, score: seededHash(`${market.marketId}:${market.marketSlug}`) }))
    .sort((a, b) => a.score - b.score)
    .map((item) => item.market);

  return {
    markets: shuffled.slice(0, maxCandidates),
    preFilterCount: markets.length,
    postFilterCount: candidates.length,
    removed,
    dimensions: PULSE_FETCH_DIMENSIONS
  };
}

export function lookupCategoryFeeParams(categorySlug, options = {}) {
  if (options.negRisk) {
    if (options.feesEnabled && options.feeSchedule) {
      return options.feeSchedule;
    }
    return NEG_RISK_FEE_PARAMS;
  }
  const lower = String(categorySlug ?? "").trim().toLowerCase();
  if (!lower) {
    return DEFAULT_FEE_PARAMS;
  }
  if (CATEGORY_FEE_PARAMS[lower]) {
    return CATEGORY_FEE_PARAMS[lower];
  }
  for (const alias of CATEGORY_ALIASES) {
    if (lower.includes(alias.pattern)) {
      return CATEGORY_FEE_PARAMS[alias.canonical];
    }
  }
  return DEFAULT_FEE_PARAMS;
}

export function inferCategorySlug(market) {
  const text = categoryText(market);
  if (!text) {
    return null;
  }
  for (const alias of CATEGORY_ALIASES) {
    if (text.includes(alias.pattern)) {
      return alias.canonical;
    }
  }
  return market?.category ?? null;
}

export function calculateFeePct(price, params) {
  if (params.feeRate === 0) {
    return 0;
  }
  const variance = price * (1 - price);
  return params.feeRate * Math.pow(variance, params.exponent);
}

export function calculateRoundTripFeePct(entryPrice, exitPrice, params) {
  return calculateFeePct(entryPrice, params) + calculateFeePct(exitPrice, params);
}

export function calculateNetEdge(grossEdge, entryPrice, params, holdToSettlement = true) {
  const entryFeePct = calculateFeePct(entryPrice, params);
  if (holdToSettlement) {
    return grossEdge - entryFeePct;
  }
  return grossEdge - entryFeePct - calculateFeePct(entryPrice, params);
}

export function calculateQuarterKelly({ aiProb, marketProb, bankrollUsd }) {
  if (marketProb <= 0 || marketProb >= 1 || aiProb <= marketProb) {
    return {
      fullKellyPct: 0,
      quarterKellyPct: 0,
      quarterKellyUsd: 0
    };
  }
  const fullKellyPct = Math.max(0, (aiProb - marketProb) / (1 - marketProb));
  const quarterKellyPct = fullKellyPct / 4;
  return {
    fullKellyPct,
    quarterKellyPct,
    quarterKellyUsd: bankrollUsd * quarterKellyPct
  };
}

export function calculateMonthlyReturn({ edge, endDate, nowMs = Date.now() }) {
  const daysToResolution = daysUntil(endDate, nowMs);
  const monthsToResolution = daysToResolution / 30;
  return {
    monthlyReturn: edge / monthsToResolution,
    daysToResolution: round(daysToResolution, 4),
    resolutionSource: endDate ? "market" : "estimated"
  };
}

export function buildPulseTradePlan({ market, side, aiProb, marketProb, bankrollUsd, nowMs = Date.now(), dynamicFeeParams = null, minNetEdge = 0, confidence = null, lowConfidenceMinEdge = 0 }) {
  const categorySlug = inferCategorySlug(market);
  const staticFeeParams = lookupCategoryFeeParams(categorySlug, {
    negRisk: Boolean(market?.negRisk),
    feesEnabled: market?.feesEnabled,
    feeSchedule: market?.feeSchedule
  });
  const feeParams = dynamicFeeParams ?? staticFeeParams;
  const feeSource = dynamicFeeParams ? "dynamic" : "static";
  const grossEdge = round(aiProb - marketProb);
  const entryFeePct = round(calculateFeePct(marketProb, feeParams));
  const roundTripFeePct = round(calculateRoundTripFeePct(marketProb, marketProb, feeParams));
  const netEdge = round(calculateNetEdge(grossEdge, marketProb, feeParams));
  const kelly = calculateQuarterKelly({ aiProb, marketProb, bankrollUsd });
  const monthly = calculateMonthlyReturn({ edge: netEdge, endDate: market?.endDate, nowMs });
  const baseMinEdge = minNetEdge || 0;
  const effectiveMinEdge = String(confidence).toLowerCase() === "low"
    ? Math.max(baseMinEdge, lowConfidenceMinEdge)
    : baseMinEdge;
  const action = kelly.quarterKellyUsd > 0 && netEdge > 0 && netEdge >= effectiveMinEdge ? "open" : "skip";
  return {
    side,
    categorySlug,
    feeParams,
    feeSource,
    grossEdge,
    netEdge,
    entryFeePct,
    roundTripFeePct,
    ...kelly,
    suggestedNotionalUsd: roundCurrency(kelly.quarterKellyUsd),
    monthlyReturn: round(monthly.monthlyReturn),
    daysToResolution: monthly.daysToResolution,
    resolutionSource: monthly.resolutionSource,
    action,
    skipReason: action === "skip"
      ? (netEdge > 0 && netEdge < effectiveMinEdge ? "below_min_net_edge" : "quarter_kelly_not_positive")
      : null
  };
}

export function rankPulsePlans(plans, maxPlans = DEFAULT_MAX_PLANS) {
  return [...plans]
    .sort((a, b) => b.monthlyReturn - a.monthlyReturn)
    .slice(0, maxPlans);
}

export function applyPulseBatchCap(plans, bankrollUsd, batchCapPct = DEFAULT_BATCH_CAP_PCT) {
  const cap = bankrollUsd * batchCapPct;
  const totalNotional = plans.reduce((sum, plan) => sum + Number(plan.suggestedNotionalUsd ?? 0), 0);
  if (totalNotional <= cap || totalNotional <= 0) {
    return plans;
  }
  const scaleFactor = cap / totalNotional;
  return plans.map((plan) => ({
    ...plan,
    suggestedNotionalUsd: roundCurrency(Number(plan.suggestedNotionalUsd ?? 0) * scaleFactor),
    batchCapScaleFactor: round(scaleFactor)
  }));
}
