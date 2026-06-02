import { readFile } from "node:fs/promises";

function round(value, digits = 4) {
  return Number((Number(value) || 0).toFixed(digits));
}

const CATEGORY_SLUG_PATTERNS = [
  [/politic|trump|election|democrat|republican|nominee|senate|parliament|president|vote|regulat|legislat|governor/, "politics"],
  [/sport|nba|nfl|mlb|nhl|soccer|football|tennis|f1|ufc|boxing|rugby|cricket|total-\dpt5|spread-home|btts|-win-on-|epl-|mls-|lol-|cs2-|fifwc|atp|wta/, "sports"],
  [/crypto|bitcoin|ethereum|solana|xrp|defi|etf/, "crypto"],
  [/tech| ai |openai|apple|google|nvidia|microsoft|tesla|robotaxi|spacex|quantum|musk/, "tech"],
  [/finance|stock|spy|s&p|ipo|market.cap|silver|gold/, "finance"],
  [/econ|fed |inflation|gdp|cpi|interest.rate|tariff|employment|jobs|non.?farm/, "economics"],
  [/weather|climate|hurricane|temperature/, "weather"],
  [/culture|entertain|movie|music|oscar|survivor|eurovision|tweet/, "culture"],
  [/geopolitic|war|conflict|iran|russia|china|sanction|warship|hormuz|military/, "geopolitics"],
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
        const candidateInfo = new Map();
        const phaseInfo = new Map();
        for (const line of recentLines) {
          const match = line.match(/^\[([^\]]+)\]\s+([a-z._]+)\s*\|?\s*(.*)$/);
          if (!match) continue;
          const [, timestamp, eventType, kvString] = match;
          if (eventType === "topics.candidate") {
            const kv = parseKeyValuePairs(kvString);
            if (kv.market) {
              candidateInfo.set(kv.market, {
                question: kv.question || null,
                liquidityUsd: kv.liq ? Number(kv.liq) : null
              });
            }
          } else if (eventType === "candidate.prescreen") {
            const kv = parseKeyValuePairs(kvString);
            if (kv.market && kv.action === "SKIP") {
              phaseInfo.set(kv.market, { phase: "prescreen", reason: kv.reason || null });
            }
          } else if (eventType === "candidate.triage") {
            const kv = parseKeyValuePairs(kvString);
            if (kv.market && kv.action === "reject") {
              phaseInfo.set(kv.market, { phase: "triage", reason: kv.reason || null });
            }
          } else if (eventType === "candidate.ranked") {
            const kv = parseKeyValuePairs(kvString);
            if (kv.market && kv.action === "skip") {
              phaseInfo.set(kv.market, { phase: "ranking", reason: kv.reason || null });
            }
          } else if (eventType === "order.blocked") {
            const kv = parseKeyValuePairs(kvString);
            if (kv.market) {
              phaseInfo.set(kv.market, { phase: "risk", reason: kv.reason || null, timestamp });
            }
          } else if (eventType === "candidate") {
            const kv = parseKeyValuePairs(kvString);
            if (kv.selected === "false" && (kv.reasons || kv.reason) && kv.market) {
              if (!skippedMap.has(kv.market)) {
                const info = candidateInfo.get(kv.market) || {};
                const pInfo = phaseInfo.get(kv.market) || {};
                skippedMap.set(kv.market, {
                  marketId: kv.market,
                  question: info.question || null,
                  marketSlug: kv.market,
                  category: inferCategory({ marketSlug: kv.market, question: info.question }),
                  liquidityUsd: info.liquidityUsd ?? null,
                  phase: pInfo.phase || null,
                  reason: pInfo.reason || kv.reasons || kv.reason,
                  skippedAt: timestamp
                });
              }
            }
          }
        }
        // Also add markets blocked at risk/order phase that passed candidate selection
        for (const [market, pInfo] of phaseInfo) {
          if (pInfo.phase === "risk" && !skippedMap.has(market)) {
            const info = candidateInfo.get(market) || {};
            skippedMap.set(market, {
              marketId: market,
              question: info.question || null,
              marketSlug: market,
              category: inferCategory({ marketSlug: market, question: info.question }),
              liquidityUsd: info.liquidityUsd ?? null,
              phase: "risk",
              reason: pInfo.reason || null,
              skippedAt: pInfo.timestamp || null
            });
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
  const keyPositions = [];
  const keyRe = /(?:^|\s)(\w+)=/g;
  let km;
  while ((km = keyRe.exec(kvString)) !== null) {
    const keyStart = km[0].startsWith(" ") ? km.index + 1 : km.index;
    keyPositions.push({ key: km[1], valueStart: keyStart + km[1].length + 1 });
  }
  for (let i = 0; i < keyPositions.length; i++) {
    const { key, valueStart } = keyPositions[i];
    const valueEnd = i + 1 < keyPositions.length ? keyPositions[i + 1].valueStart - keyPositions[i + 1].key.length - 2 : kvString.length;
    const raw = kvString.slice(valueStart, valueEnd).trim();
    result[key] = decodeValue(raw);
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
