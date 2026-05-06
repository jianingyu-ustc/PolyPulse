import { maskAddress, summarizeEnvConfig, validateEnvConfig } from "../config/env.js";
import { LiveBroker } from "../brokers/live-broker.js";

const DATA_API_HOST = "https://data-api.polymarket.com";

function numberFrom(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function isoFromTimestamp(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return null;
  }
  const millis = number > 10_000_000_000 ? number : number * 1000;
  return new Date(millis).toISOString();
}

function withQuery(path, params) {
  const url = new URL(path, DATA_API_HOST);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function arrayPayload(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload && typeof payload === "object") {
    for (const key of ["data", "positions", "closedPositions", "closed_positions", "results"]) {
      if (Array.isArray(payload[key])) {
        return payload[key];
      }
    }
  }
  return [];
}

function round(value, digits = 6) {
  return Number(numberFrom(value).toFixed(digits));
}

function settlementStatus(row) {
  if (row.redeemable) {
    return "redeemable";
  }
  if (row.mergeable) {
    return "mergeable";
  }
  const endAt = Date.parse(row.endDate ?? "");
  if (Number.isFinite(endAt) && endAt <= Date.now()) {
    return "expired_or_pending_resolution";
  }
  return "open";
}

function normalizePosition(row) {
  return {
    market: row.slug ?? row.conditionId ?? row.asset ?? "",
    title: row.title ?? "",
    eventSlug: row.eventSlug ?? null,
    outcome: row.outcome ?? "",
    token: String(row.asset ?? ""),
    conditionId: row.conditionId ?? null,
    size: round(row.size),
    avgCost: round(row.avgPrice),
    currentPrice: round(row.curPrice ?? row.currPrice),
    currentValue: round(row.currentValue),
    unrealizedPnl: round(row.cashPnl),
    realizedPnl: round(row.realizedPnl),
    totalPnl: round(row.totalPnl ?? (numberFrom(row.cashPnl) + numberFrom(row.realizedPnl))),
    percentPnl: row.percentPnl == null ? null : round(row.percentPnl),
    totalBought: round(row.totalBought),
    redeemable: Boolean(row.redeemable),
    mergeable: Boolean(row.mergeable),
    negativeRisk: Boolean(row.negativeRisk),
    endDate: row.endDate ?? null,
    settlementStatus: settlementStatus(row),
    status: numberFrom(row.size) > 0.01 ? "open" : "closed"
  };
}

function normalizeClosedPosition(row) {
  return {
    market: row.slug ?? row.conditionId ?? row.asset ?? "",
    title: row.title ?? "",
    eventSlug: row.eventSlug ?? null,
    outcome: row.outcome ?? "",
    token: String(row.asset ?? ""),
    conditionId: row.conditionId ?? null,
    avgCost: round(row.avgPrice),
    currentPrice: round(row.curPrice),
    totalBought: round(row.totalBought),
    realizedPnl: round(row.realizedPnl),
    closedAt: isoFromTimestamp(row.timestamp),
    endDate: row.endDate ?? null
  };
}

function normalizeTrade(row) {
  const notionalUsd = round(numberFrom(row.size) * numberFrom(row.price));
  const feeRateBps = round(row.fee_rate_bps);
  return {
    id: row.id ?? null,
    market: row.market ?? "",
    token: String(row.asset_id ?? ""),
    side: row.side ?? "",
    traderSide: row.trader_side ?? null,
    outcome: row.outcome ?? "",
    size: round(row.size),
    price: round(row.price),
    notionalUsd,
    feeRateBps,
    estimatedFeeUsd: round(notionalUsd * feeRateBps / 10_000, 6),
    status: row.status ?? "",
    matchTime: row.match_time ?? null,
    lastUpdate: row.last_update ?? null,
    transactionHash: row.transaction_hash ?? null,
    makerOrders: Array.isArray(row.maker_orders)
      ? row.maker_orders.map((order) => ({
        id: order.order_id ?? null,
        side: order.side ?? null,
        outcome: order.outcome ?? null,
        matchedAmount: round(order.matched_amount),
        price: round(order.price),
        feeRateBps: round(order.fee_rate_bps)
      }))
      : []
  };
}

function normalizeOpenOrder(row) {
  return {
    id: row.id ?? null,
    status: row.status ?? "",
    market: row.market ?? "",
    token: String(row.asset_id ?? ""),
    side: row.side ?? "",
    outcome: row.outcome ?? "",
    price: round(row.price),
    originalSize: round(row.original_size),
    sizeMatched: round(row.size_matched),
    remainingSize: round(numberFrom(row.original_size) - numberFrom(row.size_matched)),
    createdAt: isoFromTimestamp(row.created_at),
    orderType: row.order_type ?? null
  };
}

function maxDrawdownFromClosedPositions(positions) {
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const position of positions) {
    cumulative += numberFrom(position.realizedPnl);
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
  }
  return round(maxDrawdown, 4);
}

function summarizeClosedPositions(positions) {
  const wins = positions.filter((position) => numberFrom(position.realizedPnl) > 0);
  const losses = positions.filter((position) => numberFrom(position.realizedPnl) < 0);
  const flat = positions.length - wins.length - losses.length;
  const totalRealizedPnl = round(positions.reduce((sum, position) => sum + numberFrom(position.realizedPnl), 0), 4);
  const totalBought = round(positions.reduce((sum, position) => sum + numberFrom(position.totalBought), 0), 4);
  return {
    closedPositions: positions.length,
    wins: wins.length,
    losses: losses.length,
    flat,
    winRate: wins.length + losses.length > 0 ? round(wins.length / (wins.length + losses.length), 4) : null,
    averageWin: wins.length > 0 ? round(wins.reduce((sum, position) => sum + numberFrom(position.realizedPnl), 0) / wins.length, 4) : 0,
    averageLoss: losses.length > 0 ? round(losses.reduce((sum, position) => sum + numberFrom(position.realizedPnl), 0) / losses.length, 4) : 0,
    totalRealizedPnl,
    totalBought,
    netReturn: totalBought > 0 ? round(totalRealizedPnl / totalBought, 6) : null,
    maxDrawdownUsd: maxDrawdownFromClosedPositions(
      [...positions].sort((a, b) => String(a.closedAt ?? "").localeCompare(String(b.closedAt ?? "")))
    )
  };
}

export class AccountService {
  constructor({ config, stateStore }) {
    this.config = config;
    this.stateStore = stateStore;
    this.liveBroker = new LiveBroker(config);
  }

  async getBalance({ mode = null } = {}) {
    const executionMode = mode ?? this.config.executionMode;
    if (executionMode !== "live") {
      throw new Error(`unsupported_execution_mode: ${executionMode}; only live is supported`);
    }

    const preflight = validateEnvConfig(this.config, { mode: "live" });
    if (!preflight.ok) {
      const missing = preflight.checks.filter((item) => item.blocking && !item.ok).map((item) => item.key);
      throw new Error(`live_preflight_failed: ${missing.join(", ")}`);
    }

    const balance = await this.liveBroker.getBalance();
    const address = this.config.funderAddress || this.config.simulatedWalletAddress;
    return {
      executionMode: "live",
      env: summarizeEnvConfig(this.config, { mode: "live" }),
      wallet: {
        walletMode: this.config.liveWalletMode ?? "real",
        funderAddress: maskAddress(address),
        proxyAddress: maskAddress(address)
      },
      collateral: {
        balanceUsd: balance.collateralBalance,
        allowanceUsd: balance.allowance,
        source: balance.source
      },
      raw: balance.raw,
      updatedAt: new Date().toISOString()
    };
  }

  async approveCollateral({ mode = null, confirmation = null } = {}) {
    const executionMode = mode ?? this.config.executionMode;
    if (executionMode !== "live") {
      throw new Error(`unsupported_execution_mode: ${executionMode}; only live is supported`);
    }
    if (confirmation !== "APPROVE") {
      throw new Error("account_approve_requires_confirm_approve");
    }
    const before = await this.getBalance({ mode: executionMode });
    const updated = await this.liveBroker.approveCollateralAllowance();
    const after = await this.getBalance({ mode: executionMode });
    return {
      executionMode: "live",
      env: summarizeEnvConfig(this.config, { mode: "live" }),
      wallet: before.wallet,
      before: before.collateral,
      update: {
        source: updated.source,
        balanceUsd: updated.collateralBalance,
        allowanceUsd: updated.allowance,
        raw: updated.raw
      },
      after: after.collateral,
      updatedAt: new Date().toISOString()
    };
  }

  async fetchDataApi(path, params) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.scan?.requestTimeoutMs ?? 10_000);
    try {
      const response = await fetch(withQuery(path, params), {
        signal: controller.signal,
        headers: { "user-agent": "PolyPulse/0.1 account-audit" }
      });
      if (!response.ok) {
        throw new Error(`data_api_failed:${path}:${response.status}`);
      }
      const payload = await response.json();
      return arrayPayload(payload);
    } finally {
      clearTimeout(timeout);
    }
  }

  async getLocalStateSummary() {
    const state = this.stateStore ? await this.stateStore.readState() : null;
    const portfolio = state?.portfolio ?? {};
    const orders = Array.isArray(state?.orders) ? state.orders : [];
    const rejectedOrBlocked = orders.filter((order) => ["blocked", "rejected"].includes(String(order.status ?? "").toLowerCase()));
    const cancelled = orders.filter((order) => ["cancelled", "canceled"].includes(String(order.status ?? "").toLowerCase()));
    const filled = orders.filter((order) => String(order.status ?? "").toLowerCase() === "filled");
    return {
      accountId: portfolio.accountId ?? null,
      cashUsd: numberFrom(portfolio.cashUsd),
      totalEquityUsd: numberFrom(portfolio.totalEquityUsd),
      positionCount: Array.isArray(portfolio.positions) ? portfolio.positions.length : 0,
      orderCount: orders.length,
      filledOrders: filled.length,
      rejectedOrBlockedOrders: rejectedOrBlocked.length,
      cancelledOrders: cancelled.length,
      recentOrders: orders.slice(-10).map((order) => ({
        orderId: order.orderId ?? null,
        status: order.status ?? null,
        requestedUsd: numberFrom(order.requestedUsd),
        filledUsd: numberFrom(order.filledUsd),
        avgPrice: order.avgPrice ?? null,
        reason: order.reason ?? null,
        recordedAt: order.recordedAt ?? null
      })),
      recentRejectedOrCancelled: [...rejectedOrBlocked, ...cancelled].slice(-10).map((order) => ({
        orderId: order.orderId ?? null,
        status: order.status ?? null,
        requestedUsd: numberFrom(order.requestedUsd),
        filledUsd: numberFrom(order.filledUsd),
        reason: order.reason ?? null,
        recordedAt: order.recordedAt ?? null
      }))
    };
  }

  async audit({ mode = null } = {}) {
    const executionMode = mode ?? this.config.executionMode;
    if (executionMode !== "live") {
      throw new Error(`unsupported_execution_mode: ${executionMode}; only live is supported`);
    }
    const balance = await this.getBalance({ mode: executionMode });
    const localState = await this.getLocalStateSummary();
    if (this.config.liveWalletMode !== "real") {
      return {
        ok: true,
        executionMode: "live",
        scope: "simulated-local",
        env: summarizeEnvConfig(this.config, { mode: "live" }),
        wallet: balance.wallet,
        collateral: balance.collateral,
        positions: [],
        positionSummary: {
          openPositions: 0,
          currentValueUsd: 0,
          unrealizedPnlUsd: 0,
          realizedPnlUsd: 0
        },
        closedPositions: [],
        performance: {
          closedPositions: 0,
          wins: 0,
          losses: 0,
          flat: 0,
          winRate: null,
          averageWin: 0,
          averageLoss: 0,
          totalRealizedPnl: 0,
          totalBought: 0,
          netReturn: null,
          maxDrawdownUsd: 0
        },
        trades: [],
        tradeSummary: {
          trades: 0,
          filledTrades: 0,
          notionalUsd: 0,
          estimatedFeesUsd: 0
        },
        openOrders: [],
        openOrderSummary: {
          openOrders: 0,
          remainingSize: 0
        },
        localState,
        warnings: ["simulated_wallet_mode_no_real_account_audit"],
        errors: [],
        blockingReasons: [],
        updatedAt: new Date().toISOString()
      };
    }
    const user = this.config.funderAddress;
    const errors = [];
    let positions = null;
    let closedPositions = null;
    let trades = null;
    let openOrders = null;

    try {
      positions = (await this.fetchDataApi("/positions", {
        user,
        sizeThreshold: 0,
        limit: 500,
        offset: 0,
        sortBy: "CURRENT",
        sortDirection: "DESC"
      })).map(normalizePosition);
    } catch (error) {
      errors.push(`positions:${error instanceof Error ? error.message : String(error)}`);
      positions = null;
    }

    try {
      closedPositions = (await this.fetchDataApi("/closed-positions", {
        user,
        limit: 500,
        offset: 0
      })).map(normalizeClosedPosition);
    } catch (error) {
      errors.push(`closed_positions:${error instanceof Error ? error.message : String(error)}`);
      closedPositions = null;
    }

    try {
      trades = (await this.liveBroker.getTrades({})).map(normalizeTrade);
    } catch (error) {
      errors.push(`trades:${error instanceof Error ? error.message : String(error)}`);
      trades = null;
    }

    try {
      openOrders = (await this.liveBroker.getOpenOrders({})).map(normalizeOpenOrder);
    } catch (error) {
      errors.push(`open_orders:${error instanceof Error ? error.message : String(error)}`);
      openOrders = null;
    }

    const positionSummary = positions ? {
      openPositions: positions.length,
      currentValueUsd: round(positions.reduce((sum, position) => sum + numberFrom(position.currentValue), 0), 4),
      unrealizedPnlUsd: round(positions.reduce((sum, position) => sum + numberFrom(position.unrealizedPnl), 0), 4),
      realizedPnlUsd: round(positions.reduce((sum, position) => sum + numberFrom(position.realizedPnl), 0), 4)
    } : null;
    const performance = closedPositions ? summarizeClosedPositions(closedPositions) : null;
    const totalEquityUsd = numberFrom(balance.collateral.balanceUsd) + numberFrom(positionSummary?.currentValueUsd);
    const blockingReasons = [];

    if (numberFrom(balance.collateral.balanceUsd) < this.config.risk.minTradeUsd) {
      blockingReasons.push("insufficient_live_collateral");
    }
    if (numberFrom(balance.collateral.allowanceUsd) < this.config.risk.minTradeUsd) {
      blockingReasons.push("insufficient_live_allowance");
    }
    if (!positions) {
      blockingReasons.push("positions_unavailable");
    }
    if (!closedPositions) {
      blockingReasons.push("closed_positions_unavailable");
    }
    if (!trades) {
      blockingReasons.push("trades_unavailable");
    }
    if (!openOrders) {
      blockingReasons.push("open_orders_unavailable");
    }
    if (positions && positions.length >= this.config.risk.maxPositionCount) {
      blockingReasons.push("position_count_at_or_above_limit");
    }
    if (positionSummary && totalEquityUsd > 0 && positionSummary.currentValueUsd > totalEquityUsd * this.config.risk.maxTotalExposurePct) {
      blockingReasons.push("position_exposure_above_total_limit");
    }
    if (!performance || performance.winRate == null) {
      blockingReasons.push("win_rate_unavailable");
    }

    return {
      ok: blockingReasons.length === 0,
      executionMode: "live",
      scope: "real-remote",
      env: summarizeEnvConfig(this.config, { mode: "live" }),
      wallet: balance.wallet,
      collateral: balance.collateral,
      positions: positions ?? [],
      positionSummary,
      closedPositions: closedPositions ?? [],
      performance,
      trades: trades ?? [],
      tradeSummary: trades ? {
        trades: trades.length,
        filledTrades: trades.filter((trade) => String(trade.status).toLowerCase() === "matched").length,
        notionalUsd: round(trades.reduce((sum, trade) => sum + numberFrom(trade.notionalUsd), 0), 4),
        estimatedFeesUsd: round(trades.reduce((sum, trade) => sum + numberFrom(trade.estimatedFeeUsd), 0), 6),
        recentRejectedOrCancelledOrders: localState.recentRejectedOrCancelled
      } : null,
      openOrders: openOrders ?? [],
      openOrderSummary: openOrders ? {
        openOrders: openOrders.length,
        remainingSize: round(openOrders.reduce((sum, order) => sum + numberFrom(order.remainingSize), 0), 4)
      } : null,
      localState,
      warnings: [],
      errors,
      blockingReasons: [...new Set(blockingReasons)],
      updatedAt: new Date().toISOString()
    };
  }
}
