import { readFile } from "node:fs/promises";

function round(value, digits = 4) {
  return Number((Number(value) || 0).toFixed(digits));
}

const CATEGORY_SLUG_PATTERNS = [
  [/politic|trump|election|democrat|republican|nominee|senate|parliament|president|vote|regulat|legislat/, "politics"],
  [/sport|nba|nfl|mlb|nhl|soccer|football|tennis|f1|ufc|boxing|rugby|cricket|total-\dpt5|spread-home|btts|-win-on-|epl-|mls-|lol-|cs2-/, "sports"],
  [/crypto|bitcoin|ethereum|solana|xrp|defi|etf/, "crypto"],
  [/tech| ai |openai|apple|google|nvidia|microsoft/, "tech"],
  [/finance|stock|spy|s&p/, "finance"],
  [/econ|fed |inflation|gdp|cpi|interest.rate|tariff/, "economics"],
  [/weather|climate|hurricane|temperature/, "weather"],
  [/culture|entertain|movie|music|oscar|survivor|eurovision/, "culture"],
  [/geopolitic|war|conflict|iran|russia|china|sanction/, "geopolitics"],
  [/mention/, "mentions"]
];

function inferCategory(pos) {
  if (pos.category) return pos.category;
  const text = [pos.marketSlug, pos.question, pos.eventSlug].filter(Boolean).join(" ").toLowerCase();
  if (!text) return "";
  for (const [re, cat] of CATEGORY_SLUG_PATTERNS) {
    if (re.test(text)) return cat;
  }
  return "";
}

function computeReturns(initialCashUsd, totalEquityUsd, startedAt) {
  const elapsedMs = Date.now() - new Date(startedAt).getTime();
  const elapsedDays = Math.max(1, elapsedMs / 86_400_000);
  const totalReturnPct = initialCashUsd > 0
    ? (totalEquityUsd - initialCashUsd) / initialCashUsd
    : 0;
  const dailyReturn = totalReturnPct / elapsedDays;
  return {
    monthlyReturnPct: round(dailyReturn * 30, 4),
    annualReturnPct: round(dailyReturn * 365, 4),
    totalReturnPct: round(totalReturnPct, 4),
    elapsedDays: round(elapsedDays, 1)
  };
}

function formatPosition(pos) {
  return {
    positionId: pos.positionId ?? pos.marketId,
    marketId: pos.marketId,
    marketUrl: pos.marketUrl ?? null,
    question: pos.question ?? pos.marketSlug ?? "",
    category: inferCategory(pos),
    outcome: pos.outcome ?? "",
    side: pos.side ?? "",
    openedAt: pos.openedAt ?? null,
    endDate: pos.endDate ?? null,
    costUsd: pos.costUsd ?? 0,
    currentValueUsd: pos.currentValueUsd ?? 0,
    unrealizedPnlUsd: pos.unrealizedPnlUsd ?? 0,
    aiProbability: pos.lastDecision?.aiProbability ?? null,
    marketProbability: pos.lastDecision?.marketProbability ?? null,
    currentMarketProb: pos.currentPrice ?? null,
    edge: pos.lastDecision?.edge ?? pos.lastDecision?.grossEdge ?? null,
    netEdge: pos.lastDecision?.netEdge ?? null,
    feeImpact: pos.lastDecision?.edge != null && pos.lastDecision?.netEdge != null
      ? pos.lastDecision.edge - pos.lastDecision.netEdge : null,
    reasoningSummary: pos.lastDecision?.reasoningSummary ?? null,
    confidence: pos.lastDecision?.confidence ?? null,
    keyEvidence: pos.lastDecision?.keyEvidence ?? []
  };
}

function formatClosedTrade(trade) {
  return {
    positionId: trade.positionId ?? trade.marketId,
    marketId: trade.marketId,
    marketUrl: trade.marketUrl ?? null,
    question: trade.question ?? trade.marketSlug ?? "",
    category: inferCategory(trade),
    outcome: trade.outcome ?? "",
    side: trade.side ?? "",
    openedAt: trade.openedAt ?? null,
    closedAt: trade.closedAt ?? null,
    costUsd: trade.costUsd ?? 0,
    realizedPnlUsd: trade.realizedPnlUsd ?? 0,
    returnPct: trade.returnPct ?? null,
    closeReason: trade.closeReason ?? "",
    aiProbability: trade.lastDecision?.aiProbability ?? null,
    marketProbability: trade.lastDecision?.marketProbability ?? null,
    exitMarketProb: trade.currentPrice ?? null,
    edge: trade.lastDecision?.edge ?? trade.lastDecision?.grossEdge ?? null,
    netEdge: trade.lastDecision?.netEdge ?? null,
    feeImpact: trade.lastDecision?.edge != null && trade.lastDecision?.netEdge != null
      ? trade.lastDecision.edge - trade.lastDecision.netEdge : null,
    reasoningSummary: trade.lastDecision?.reasoningSummary ?? null,
    confidence: trade.lastDecision?.confidence ?? null,
    keyEvidence: trade.lastDecision?.keyEvidence ?? []
  };
}

export function createPaperDataProvider(scheduler, { stateStore, logPath } = {}) {
  return async () => {
    const ledger = scheduler.simulatedLedger;
    if (!ledger) {
      return { error: "no_ledger", startedAt: null, executionMode: "paper", summary: {}, openPositions: [], closedPositions: [], skippedCandidates: [] };
    }
    const stats = ledger.statistics();
    const startedAt = scheduler._startedAt ?? new Date().toISOString();
    const returns = computeReturns(ledger.initialCashUsd, stats.totalEquityUsd, startedAt);

    let allClosedTrades = [];
    let logSkipped = [];

    if (stateStore && logPath) {
      try {
        const paperState = await stateStore.readState();
        allClosedTrades = paperState.closedTrades || [];
      } catch {}

      try {
        const logContent = await readFile(logPath, "utf8");
        const lines = logContent.split("\n");
        const recentLines = lines.slice(-5000);
        const skippedMap = new Map();
        for (const line of recentLines) {
          const match = line.match(/^\[([^\]]+)\]\s+([a-z._]+)\s*\|?\s*(.*)$/);
          if (!match) continue;
          const [, timestamp, eventType, kvString] = match;
          if (eventType === "candidate") {
            const kv = parseKeyValuePairs(kvString);
            if (kv.selected === "false" && (kv.reasons || kv.reason) && kv.market) {
              if (!skippedMap.has(kv.market)) {
                skippedMap.set(kv.market, {
                  market: kv.market,
                  category: kv.category || null,
                  liquidity: kv.liq ? Number(kv.liq) : null,
                  stage: null,
                  reason: kv.reasons || kv.reason,
                  timestamp
                });
              }
            }
          }
        }
        logSkipped = Array.from(skippedMap.values()).slice(-100).reverse();
      } catch {}
    }

    const ledgerClosedTrades = ledger.closedTrades.map(formatClosedTrade);
    const stateClosedTrades = allClosedTrades.map(formatClosedTrade);
    const allClosed = mergeClosedTrades(stateClosedTrades, ledgerClosedTrades);

    return {
      startedAt,
      executionMode: "paper",
      summary: {
        initialCashUsd: ledger.initialCashUsd,
        cashUsd: stats.cashUsd,
        totalEquityUsd: stats.totalEquityUsd,
        unrealizedPnlUsd: stats.unrealizedPnlUsd,
        realizedPnlUsd: stats.realizedPnlUsd,
        winRate: stats.winRate,
        closedTrades: allClosed.length,
        wins: stats.wins,
        losses: stats.losses,
        maxDrawdownUsd: stats.maxDrawdownUsd,
        ...returns
      },
      openPositions: ledger.positions.map(formatPosition),
      closedPositions: allClosed,
      skippedCandidates: logSkipped
    };
  };
}

function parseKeyValuePairs(kvString) {
  const result = {};
  if (!kvString) return result;
  const re = /(\w+)=((?:"[^"]*"|[^\s])+)/g;
  let m;
  while ((m = re.exec(kvString)) !== null) {
    result[m[1]] = decodeValue(m[2]);
  }
  return result;
}

function decodeValue(value) {
  if (!value) return value;
  if (value === "none" || value === "n/a") return null;
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  if (value.startsWith("{") || value.startsWith("[")) {
    try { return JSON.parse(value); } catch { return value; }
  }
  return value;
}

function mergeClosedTrades(stateTrades, ledgerTrades) {
  const seen = new Set(stateTrades.map(t => t.marketId || t.positionId));
  const uniqueLedger = ledgerTrades.filter(t => !seen.has(t.marketId || t.positionId));
  return [...stateTrades, ...uniqueLedger].slice(-200).reverse();
}

export function createLiveDataProvider(stateStore, scheduler) {
  return async () => {
    const state = await stateStore.readState();
    const portfolio = state?.portfolio ?? {};
    const positions = portfolio.positions ?? [];
    const startedAt = scheduler?._startedAt ?? state?.monitorState?.lastStartedAt ?? new Date().toISOString();
    const initialCashUsd = positions.reduce((sum, p) => sum + (p.costUsd ?? 0), 0) + (portfolio.cashUsd ?? 0);
    const totalEquityUsd = portfolio.totalEquityUsd ?? initialCashUsd;
    const returns = computeReturns(initialCashUsd, totalEquityUsd, startedAt);

    return {
      startedAt,
      executionMode: "live",
      summary: {
        initialCashUsd,
        cashUsd: portfolio.cashUsd ?? 0,
        totalEquityUsd,
        unrealizedPnlUsd: 0,
        realizedPnlUsd: 0,
        winRate: null,
        closedTrades: 0,
        wins: 0,
        losses: 0,
        maxDrawdownUsd: state?.riskState?.maxDrawdownUsd ?? 0,
        ...returns
      },
      openPositions: positions.map(formatPosition),
      closedPositions: [],
      skippedCandidates: []
    };
  };
}
