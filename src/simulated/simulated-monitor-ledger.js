import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

function nowIso() {
  return new Date().toISOString();
}

function round(value, digits = 4) {
  return Number((Number(value) || 0).toFixed(digits));
}

function normalizeSide(value) {
  return String(value ?? "yes").toLowerCase() === "no" ? "no" : "yes";
}

function priceForToken(market, tokenId, fallback = 0) {
  const outcome = (market?.outcomes ?? []).find((item) => item.tokenId === tokenId);
  const price = Number(
    outcome?.bestBid
      ?? outcome?.bestAsk
      ?? outcome?.impliedProbability
      ?? outcome?.lastPrice
      ?? fallback
  );
  return Number.isFinite(price) ? Math.max(0, Math.min(1, price)) : Number(fallback) || 0;
}

function outcomeForToken(market, tokenId) {
  return (market?.outcomes ?? []).find((item) => item.tokenId === tokenId) ?? null;
}

function dedupeKeys(market) {
  return [
    market?.marketId ? `market:${market.marketId}` : null,
    market?.marketSlug ? `market:${market.marketSlug}` : null,
    market?.eventId ? `event:${market.eventId}` : null,
    market?.eventSlug ? `event:${market.eventSlug}` : null
  ].filter(Boolean);
}

function performanceFromClosed(closed) {
  const wins = closed.filter((trade) => trade.realizedPnlUsd > 0);
  const losses = closed.filter((trade) => trade.realizedPnlUsd < 0);
  const totalRealized = round(closed.reduce((sum, trade) => sum + trade.realizedPnlUsd, 0));
  const totalCost = round(closed.reduce((sum, trade) => sum + trade.costUsd, 0));
  return {
    closedTrades: closed.length,
    wins: wins.length,
    losses: losses.length,
    flat: closed.length - wins.length - losses.length,
    winRate: wins.length + losses.length > 0 ? round(wins.length / (wins.length + losses.length), 4) : null,
    averageWinUsd: wins.length > 0 ? round(wins.reduce((sum, trade) => sum + trade.realizedPnlUsd, 0) / wins.length) : 0,
    averageLossUsd: losses.length > 0 ? round(losses.reduce((sum, trade) => sum + trade.realizedPnlUsd, 0) / losses.length) : 0,
    realizedPnlUsd: totalRealized,
    netReturnPct: totalCost > 0 ? round(totalRealized / totalCost, 6) : null
  };
}

export class SimulatedMonitorLedger {
  constructor(config) {
    this.config = config;
    this.initialCashUsd = round(config.simulatedWalletBalanceUsd ?? 100);
    this.cashUsd = this.initialCashUsd;
    this.positions = [];
    this.closedTrades = [];
    this.openTrades = [];
    this.dailyTradeUsd = { date: nowIso().slice(0, 10), amountUsd: 0, trades: 0 };
    this.highWaterMarkUsd = this.initialCashUsd;
    this.maxDrawdownUsd = 0;
    this.logPath = path.resolve(config.simulatedMonitorLogPath ?? "logs/polypulse-simulated-monitor.log");
    this.logReady = false;
  }

  async ensureLog() {
    if (this.logReady) return;
    await mkdir(path.dirname(this.logPath), { recursive: true });
    await appendFile(this.logPath, [
      "",
      "================================================================================",
      `[${nowIso()}] simulated live monitor session started`,
      `initial_cash_usd=${this.initialCashUsd}`,
      `wallet_mode=${this.config.liveWalletMode}`,
      `market_source=${this.config.marketSource}`,
      `gamma=${this.config.polymarketGammaHost}`,
      "================================================================================",
      ""
    ].join("\n"), "utf8");
    this.logReady = true;
  }

  async log(message, fields = {}) {
    await this.ensureLog();
    const suffix = Object.keys(fields).length > 0
      ? ` | ${Object.entries(fields).map(([key, value]) => `${key}=${value}`).join(" ")}`
      : "";
    await appendFile(this.logPath, `[${nowIso()}] ${message}${suffix}\n`, "utf8");
  }

  monitorState() {
    return {
      status: "active",
      dailyTradeUsd: this.dailyTradeUsd,
      tradedMarkets: {},
      watchlist: [],
      blocklist: []
    };
  }

  riskState() {
    return {
      status: "active",
      highWaterMarkUsd: this.highWaterMarkUsd
    };
  }

  liveBalance() {
    return {
      collateralBalance: this.cashUsd,
      allowance: this.cashUsd,
      source: "simulated-monitor-ledger"
    };
  }

  portfolio() {
    const openValue = round(this.positions.reduce((sum, position) => sum + position.currentValueUsd, 0));
    const totalEquityUsd = round(this.cashUsd + openValue);
    this.highWaterMarkUsd = Math.max(this.highWaterMarkUsd, totalEquityUsd);
    this.maxDrawdownUsd = Math.max(this.maxDrawdownUsd, round(this.highWaterMarkUsd - totalEquityUsd));
    return {
      accountId: this.config.simulatedWalletAddress || "live-simulated-monitor",
      cashUsd: this.cashUsd,
      totalEquityUsd,
      positions: this.positions.map((position) => ({ ...position })),
      updatedAt: nowIso()
    };
  }

  statistics() {
    const portfolio = this.portfolio();
    const unrealizedPnlUsd = round(this.positions.reduce((sum, position) => sum + position.unrealizedPnlUsd, 0));
    return {
      cashUsd: portfolio.cashUsd,
      totalEquityUsd: portfolio.totalEquityUsd,
      openPositions: this.positions.length,
      unrealizedPnlUsd,
      maxDrawdownUsd: this.maxDrawdownUsd,
      dailyTradeUsd: this.dailyTradeUsd,
      ...performanceFromClosed(this.closedTrades)
    };
  }

  async beginRound({ runId, limit, maxAmountUsd }) {
    await this.log("round.start", {
      run_id: runId,
      limit: limit ?? "default",
      max_amount_usd: maxAmountUsd ?? this.config.risk.minTradeUsd,
      cash_usd: this.cashUsd,
      open_positions: this.positions.length
    });
  }

  async logScan(scan) {
    await this.log("topics.fetched", {
      source: scan.source,
      markets: scan.markets?.length ?? 0,
      total_fetched: scan.totalFetched ?? 0,
      risk_flags: (scan.riskFlags ?? []).join(",") || "none"
    });
    for (const [index, market] of (scan.markets ?? []).slice(0, 5).entries()) {
      await this.log("topics.candidate", {
        rank: index + 1,
        market: market.marketSlug,
        liq: market.liquidityUsd,
        vol24h: market.volume24hUsd,
        question: JSON.stringify(market.question)
      });
    }
  }

  async logPrediction({ market, estimate, decision, phase = "open-scan" }) {
    await this.log("prediction", {
      phase,
      market: market.marketSlug,
      ai_probability: estimate.ai_probability,
      confidence: estimate.confidence,
      side: decision.suggested_side ?? "none",
      market_probability: decision.market_implied_probability ?? decision.marketProbability ?? "n/a",
      edge: decision.edge ?? decision.grossEdge ?? "n/a",
      net_edge: decision.netEdge ?? "n/a",
      quarter_kelly_pct: decision.quarterKellyPct ?? "n/a",
      monthly_return: decision.monthlyReturn ?? "n/a",
      action: decision.action
    });
  }

  async logRisk({ market, risk }) {
    await this.log("risk", {
      market: market.marketSlug,
      allowed: risk.allowed,
      approved_usd: risk.approvedUsd,
      adjusted_notional: risk.adjustedNotional,
      blocks: (risk.blockedReasons ?? []).join(",") || "none",
      warnings: (risk.warnings ?? []).join(",") || "none"
    });
  }

  async openPosition({ market, decision, risk }) {
    if (!risk.allowed || !risk.order || risk.approvedUsd <= 0) {
      return {
        orderId: "blocked-before-order",
        status: "blocked",
        mode: "live",
        requestedUsd: risk.order?.amountUsd ?? 0,
        filledUsd: 0,
        avgPrice: null,
        reason: (risk.blockedReasons ?? risk.reasons ?? ["risk_not_allowed"]).join(",")
      };
    }

    const outcome = outcomeForToken(market, decision.tokenId);
    const price = priceForToken(market, decision.tokenId, decision.marketProbability ?? decision.market_implied_probability ?? 0);
    if (price <= 0) {
      return {
        orderId: "blocked-before-order",
        status: "blocked",
        mode: "live",
        requestedUsd: risk.order.amountUsd,
        filledUsd: 0,
        avgPrice: null,
        reason: "simulated_fill_price_unavailable"
      };
    }

    const filledUsd = Math.min(this.cashUsd, risk.order.amountUsd);
    if (filledUsd <= 0) {
      return {
        orderId: "blocked-before-order",
        status: "blocked",
        mode: "live",
        requestedUsd: risk.order.amountUsd,
        filledUsd: 0,
        avgPrice: null,
        reason: "simulated_cash_unavailable"
      };
    }

    const size = round(filledUsd / price, 6);
    const position = {
      positionId: `sim-pos-${randomUUID()}`,
      marketId: market.marketId,
      marketSlug: market.marketSlug,
      eventId: market.eventId,
      eventSlug: market.eventSlug,
      question: market.question,
      tokenId: decision.tokenId,
      outcome: outcome?.label ?? decision.suggested_side ?? "unknown",
      side: normalizeSide(decision.suggested_side),
      size,
      avgPrice: round(price, 6),
      currentPrice: round(price, 6),
      costUsd: round(filledUsd),
      currentValueUsd: round(filledUsd),
      unrealizedPnlUsd: 0,
      openedAt: nowIso(),
      endDate: market.endDate ?? null,
      lastDecision: {
        aiProbability: decision.aiProbability,
        marketProbability: decision.marketProbability,
        netEdge: decision.netEdge,
        monthlyReturn: decision.monthlyReturn
      }
    };
    this.cashUsd = round(this.cashUsd - filledUsd);
    this.positions.push(position);
    this.openTrades.push(position);
    this.dailyTradeUsd.amountUsd = round(this.dailyTradeUsd.amountUsd + filledUsd);
    this.dailyTradeUsd.trades += 1;

    const order = {
      orderId: `sim-log-${randomUUID()}`,
      status: "filled",
      mode: "live",
      requestedUsd: risk.order.amountUsd,
      filledUsd,
      avgPrice: price,
      reason: null,
      walletMode: "simulated",
      paper: true
    };
    await this.log("open.filled", {
      market: market.marketSlug,
      outcome: position.outcome,
      price: position.avgPrice,
      size: position.size,
      cost_usd: position.costUsd,
      cash_usd: this.cashUsd,
      order_id: order.orderId
    });
    return order;
  }

  async markToMarket({ markets = [], marketSource = null }) {
    const marketByKey = new Map();
    for (const market of markets) {
      for (const key of dedupeKeys(market)) {
        marketByKey.set(key, market);
      }
    }

    for (const position of this.positions) {
      let market = marketByKey.get(`market:${position.marketId}`)
        ?? marketByKey.get(`market:${position.marketSlug}`)
        ?? null;
      if (!market && marketSource) {
        market = await marketSource.getMarket(position.marketId || position.marketSlug, { noCache: true });
      }
      if (!market) continue;
      const price = priceForToken(market, position.tokenId, position.currentPrice);
      position.currentPrice = round(price, 6);
      position.currentValueUsd = round(position.size * price);
      position.unrealizedPnlUsd = round(position.currentValueUsd - position.costUsd);
      position.marketClosed = Boolean(market.closed);
      position.marketActive = Boolean(market.active);
      position.lastMarkedAt = nowIso();
    }
    await this.log("mark_to_market", {
      open_positions: this.positions.length,
      unrealized_pnl_usd: this.statistics().unrealizedPnlUsd,
      total_equity_usd: this.statistics().totalEquityUsd
    });
  }

  closeSignal(position) {
    if (position.marketClosed) return "market_closed";
    if (position.currentPrice >= 0.99) return "near_full_value";
    if (position.currentPrice <= 0.01) return "near_zero_value";
    const lossPct = position.costUsd > 0
      ? (position.costUsd - position.currentValueUsd) / position.costUsd
      : 0;
    if (lossPct >= this.config.risk.maxPositionLossPct) {
      return "stop_loss";
    }
    return null;
  }

  async closePosition(positionId, reason) {
    const index = this.positions.findIndex((position) => position.positionId === positionId);
    if (index < 0) return null;
    const [position] = this.positions.splice(index, 1);
    const proceedsUsd = round(position.currentValueUsd);
    const realizedPnlUsd = round(proceedsUsd - position.costUsd);
    this.cashUsd = round(this.cashUsd + proceedsUsd);
    const closed = {
      ...position,
      closedAt: nowIso(),
      closeReason: reason,
      proceedsUsd,
      realizedPnlUsd,
      returnPct: position.costUsd > 0 ? round(realizedPnlUsd / position.costUsd, 6) : null
    };
    this.closedTrades.push(closed);
    await this.log("close.filled", {
      market: closed.marketSlug,
      outcome: closed.outcome,
      reason,
      exit_price: closed.currentPrice,
      proceeds_usd: proceedsUsd,
      realized_pnl_usd: realizedPnlUsd,
      cash_usd: this.cashUsd,
      win_rate: this.statistics().winRate ?? "n/a"
    });
    return closed;
  }

  async closeBySignals() {
    const closed = [];
    for (const position of [...this.positions]) {
      const reason = this.closeSignal(position);
      if (reason) {
        closed.push(await this.closePosition(position.positionId, reason));
      }
    }
    return closed.filter(Boolean);
  }

  async closeOnDecision({ position, decision }) {
    const decisionToken = decision.tokenId;
    const shouldClose = decision.action !== "open"
      || decisionToken !== position.tokenId
      || Number(decision.netEdge ?? 0) <= 0;
    if (!shouldClose) {
      await this.log("hold", {
        market: position.marketSlug,
        outcome: position.outcome,
        current_price: position.currentPrice,
        unrealized_pnl_usd: position.unrealizedPnlUsd,
        reason: "edge_still_supports_position"
      });
      return null;
    }
    return await this.closePosition(position.positionId, "edge_reversal_or_no_trade");
  }

  async endRound({ runId, status = "completed", errors = [] }) {
    const stats = this.statistics();
    await this.log("round.end", {
      run_id: runId,
      status,
      cash_usd: stats.cashUsd,
      equity_usd: stats.totalEquityUsd,
      open_positions: stats.openPositions,
      realized_pnl_usd: stats.realizedPnlUsd,
      unrealized_pnl_usd: stats.unrealizedPnlUsd,
      wins: stats.wins,
      losses: stats.losses,
      win_rate: stats.winRate ?? "n/a",
      max_drawdown_usd: stats.maxDrawdownUsd,
      errors: errors.length ? errors.join(";") : "none"
    });
  }
}
