function round(value, digits = 4) {
  return Number((Number(value) || 0).toFixed(digits));
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
    category: pos.category ?? "",
    outcome: pos.outcome ?? "",
    side: pos.side ?? "",
    openedAt: pos.openedAt ?? null,
    endDate: pos.endDate ?? null,
    costUsd: pos.costUsd ?? 0,
    currentValueUsd: pos.currentValueUsd ?? 0,
    unrealizedPnlUsd: pos.unrealizedPnlUsd ?? 0,
    aiProbability: pos.lastDecision?.aiProbability ?? null,
    marketProbability: pos.lastDecision?.marketProbability ?? null,
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
    category: trade.category ?? "",
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
    edge: trade.lastDecision?.edge ?? trade.lastDecision?.grossEdge ?? null,
    netEdge: trade.lastDecision?.netEdge ?? null,
    feeImpact: trade.lastDecision?.edge != null && trade.lastDecision?.netEdge != null
      ? trade.lastDecision.edge - trade.lastDecision.netEdge : null,
    reasoningSummary: trade.lastDecision?.reasoningSummary ?? null,
    confidence: trade.lastDecision?.confidence ?? null,
    keyEvidence: trade.lastDecision?.keyEvidence ?? []
  };
}

export function createPaperDataProvider(scheduler) {
  return () => {
    const ledger = scheduler.simulatedLedger;
    if (!ledger) {
      return { error: "no_ledger", startedAt: null, executionMode: "paper", summary: {}, openPositions: [], closedPositions: [] };
    }
    const stats = ledger.statistics();
    const startedAt = scheduler._startedAt ?? new Date().toISOString();
    const returns = computeReturns(ledger.initialCashUsd, stats.totalEquityUsd, startedAt);

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
        closedTrades: stats.closedTrades,
        wins: stats.wins,
        losses: stats.losses,
        maxDrawdownUsd: stats.maxDrawdownUsd,
        ...returns
      },
      openPositions: ledger.positions.map(formatPosition),
      closedPositions: ledger.closedTrades.slice(-100).reverse().map(formatClosedTrade),
      skippedCandidates: (ledger.skippedCandidates ?? []).slice(-200).reverse()
    };
  };
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
