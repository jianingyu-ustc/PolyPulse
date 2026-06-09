import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertSchema } from "../domain/schemas.js";

function nowIso() {
  return new Date().toISOString();
}

function todayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function roundUsd(value) {
  return Number((Number(value) || 0).toFixed(4));
}

function stateFilePath(config) {
  return path.join(config.stateDir, "live-state.json");
}

function emptyPortfolio(config, now = nowIso()) {
  return assertSchema("PortfolioSnapshot", {
    accountId: config.funderAddress || `live-${config.executionMode ?? "live"}`,
    cashUsd: 0,
    totalEquityUsd: 0,
    positions: [],
    updatedAt: now
  });
}

function emptyRiskState(portfolio, now = nowIso()) {
  return {
    status: "active",
    highWaterMarkUsd: portfolio.totalEquityUsd,
    haltedAt: null,
    haltReason: null,
    pausedAt: null,
    pauseReason: null,
    resumedAt: null,
    updatedAt: now
  };
}

function emptyMonitorState(now = nowIso()) {
  return {
    opensPaused: false,
    opensPausedAt: null,
    opensPauseReason: null,
    maintenancePaused: false,
    maintenancePausedAt: null,
    maintenancePauseReason: null,
    updatedAt: now,
    lastRunId: null,
    lastStartedAt: null,
    lastCompletedAt: null,
    inFlightRun: null,
    lastError: null,
    runHistory: [],
    dailyTradeUsd: { date: todayKey(), amountUsd: 0, trades: 0 },
    dailyClosedProceedsUsd: 0,
    tradedMarkets: {},
    watchlist: [],
    blocklist: []
  };
}

function defaultState(config) {
  const now = nowIso();
  const portfolio = emptyPortfolio(config, now);
  return {
    version: 1,
    mode: "live",
    portfolio,
    riskState: emptyRiskState(portfolio, now),
    monitorState: emptyMonitorState(now),
    orders: [],
    runs: [],
    updatedAt: now
  };
}

function normalizeDailyTradeUsd(value) {
  if (value?.date === todayKey()) {
    return {
      date: value.date,
      amountUsd: roundUsd(value.amountUsd),
      trades: Math.max(0, Math.floor(Number(value.trades) || 0))
    };
  }
  return { date: todayKey(), amountUsd: 0, trades: 0 };
}

function normalizeState(config, value) {
  const base = defaultState(config);
  const state = value && typeof value === "object" ? value : {};
  const portfolio = {
    ...base.portfolio,
    ...(state.portfolio ?? {})
  };
  portfolio.positions = Array.isArray(portfolio.positions) ? portfolio.positions : [];
  portfolio.cashUsd = roundUsd(portfolio.cashUsd);
  portfolio.totalEquityUsd = roundUsd(portfolio.totalEquityUsd);
  portfolio.updatedAt = portfolio.updatedAt ?? nowIso();

  const riskState = {
    ...base.riskState,
    ...(state.riskState ?? {})
  };
  riskState.highWaterMarkUsd = Math.max(
    roundUsd(riskState.highWaterMarkUsd),
    roundUsd(portfolio.totalEquityUsd)
  );

  const monitorState = {
    ...base.monitorState,
    ...(state.monitorState ?? {})
  };
  monitorState.runHistory = Array.isArray(monitorState.runHistory) ? monitorState.runHistory : [];
  monitorState.tradedMarkets = monitorState.tradedMarkets && typeof monitorState.tradedMarkets === "object"
    ? monitorState.tradedMarkets
    : {};
  monitorState.watchlist = Array.isArray(monitorState.watchlist) ? monitorState.watchlist : [];
  monitorState.blocklist = Array.isArray(monitorState.blocklist) ? monitorState.blocklist : [];
  monitorState.dailyTradeUsd = normalizeDailyTradeUsd(monitorState.dailyTradeUsd);

  return {
    ...base,
    ...state,
    mode: "live",
    portfolio,
    riskState,
    monitorState,
    orders: Array.isArray(state.orders) ? state.orders : [],
    runs: Array.isArray(state.runs) ? state.runs : []
  };
}

function positionPrice(position, markets) {
  for (const market of markets) {
    const outcome = (market.outcomes ?? []).find((item) => item.tokenId === position.tokenId);
    if (outcome) {
      return Number(outcome.lastPrice ?? outcome.bestBid ?? outcome.bestAsk ?? position.avgPrice ?? 0);
    }
  }
  return Number(position.avgPrice ?? 0);
}

function positionMarket(position, markets) {
  for (const market of markets) {
    const outcome = (market.outcomes ?? []).find((item) => item.tokenId === position.tokenId);
    if (outcome) return market;
  }
  return null;
}

function dedupeKeys(market) {
  if (market.negRisk) {
    return [
      market.marketId ? `market:${market.marketId}` : null,
      market.marketSlug ? `market:${market.marketSlug}` : null
    ].filter(Boolean);
  }
  return [
    market.marketId ? `market:${market.marketId}` : null,
    market.marketSlug ? `market:${market.marketSlug}` : null,
    market.eventId ? `event:${market.eventId}` : null,
    market.eventSlug ? `event:${market.eventSlug}` : null
  ].filter(Boolean);
}

export class FileStateStore {
  constructor(config) {
    this.config = config;
    this.path = stateFilePath(config);
  }

  async reset() {
    const { unlink } = await import("node:fs/promises");
    try { await unlink(this.path); } catch (e) { if (e?.code !== "ENOENT") throw e; }
  }

  async readState() {
    try {
      const raw = await readFile(this.path, "utf8");
      return normalizeState(this.config, JSON.parse(raw));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      const state = defaultState(this.config);
      await this.writeState(state);
      return state;
    }
  }

  async writeState(state) {
    const normalized = normalizeState(this.config, state);
    normalized.updatedAt = nowIso();
    await mkdir(path.dirname(this.path), { recursive: true });
    const tmpPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    await rename(tmpPath, this.path);
    return normalized;
  }

  async getPortfolio() {
    const state = await this.readState();
    return assertSchema("PortfolioSnapshot", state.portfolio);
  }

  async getRiskState() {
    return (await this.readState()).riskState;
  }

  async haltRisk(reason = "drawdown") {
    const state = await this.readState();
    const now = nowIso();
    state.riskState = {
      ...state.riskState,
      status: "halted",
      haltedAt: now,
      haltReason: reason,
      updatedAt: now
    };
    return (await this.writeState(state)).riskState;
  }


  updatePortfolioTotals(state) {
    const positionsValue = (state.portfolio.positions ?? [])
      .reduce((sum, position) => sum + Number(position.currentValueUsd ?? 0), 0);
    state.portfolio.totalEquityUsd = roundUsd(state.portfolio.cashUsd + positionsValue);
    state.portfolio.updatedAt = nowIso();
    state.riskState.highWaterMarkUsd = Math.max(
      roundUsd(state.riskState.highWaterMarkUsd),
      state.portfolio.totalEquityUsd
    );
    state.riskState.updatedAt = nowIso();
  }

  async markToMarket(markets = []) {
    const state = await this.readState();
    state.portfolio.positions = (state.portfolio.positions ?? []).map((position) => {
      const price = positionPrice(position, markets);
      const market = positionMarket(position, markets);
      const currentValueUsd = roundUsd(Number(position.size) * price);
      return {
        ...position,
        currentPrice: price,
        currentValueUsd,
        unrealizedPnlUsd: roundUsd(currentValueUsd - Number(position.costUsd ?? 0)),
        marketClosed: market ? Boolean(market.closed) : Boolean(position.marketClosed),
        updatedAt: nowIso()
      };
    });
    this.updatePortfolioTotals(state);
    await this.writeState(state);
    return state.portfolio;
  }

  async closePosition(positionId, { proceedsUsd = 0 } = {}) {
    const state = await this.readState();
    const idx = (state.portfolio.positions ?? []).findIndex((p) => p.positionId === positionId);
    if (idx < 0) return null;
    const [position] = state.portfolio.positions.splice(idx, 1);
    state.portfolio.cashUsd = roundUsd((state.portfolio.cashUsd ?? 0) + proceedsUsd);
    this.updatePortfolioTotals(state);
    await this.writeState(state);
    return {
      ...position,
      closedAt: nowIso(),
      proceedsUsd,
      realizedPnlUsd: roundUsd(proceedsUsd - Number(position.costUsd ?? 0))
    };
  }

  async recordOrder(orderResult) {
    const state = await this.readState();
    state.orders.push({ ...orderResult, recordedAt: nowIso() });
    await this.writeState(state);
  }

  async createRun({ runId, stage = "started", ...rest }) {
    const state = await this.readState();
    const run = { runId, stage, status: stage, startedAt: nowIso(), updatedAt: nowIso(), ...rest };
    state.runs.push(run);
    await this.writeState(state);
    return run;
  }

  async updateRunStage(runId, stage, patch = {}) {
    const state = await this.readState();
    const index = state.runs.findIndex((run) => run.runId === runId);
    const update = { stage, updatedAt: nowIso(), ...patch };
    if (index >= 0) {
      state.runs[index] = { ...state.runs[index], ...update };
    } else {
      state.runs.push({ runId, startedAt: nowIso(), ...update });
    }
    await this.writeState(state);
    return state.runs.find((run) => run.runId === runId);
  }

  async getMonitorState() {
    const state = await this.readState();
    const prev = state.monitorState.dailyTradeUsd;
    state.monitorState.dailyTradeUsd = normalizeDailyTradeUsd(prev);
    if (prev?.date !== todayKey()) {
      state.monitorState.dailyClosedProceedsUsd = 0;
    }
    await this.writeState(state);
    return state.monitorState;
  }

  async recoverMonitorRun() {
    const state = await this.readState();
    const run = state.monitorState.inFlightRun;
    if (!run) {
      return null;
    }
    const recovered = {
      ...run,
      status: "recovered_after_crash",
      recoveredAt: nowIso()
    };
    state.monitorState.runHistory.push(recovered);
    state.monitorState.inFlightRun = null;
    state.monitorState.lastError = "recovered_after_crash";
    state.monitorState.updatedAt = nowIso();
    await this.writeState(state);
    return recovered;
  }

  async startMonitorRun({ runId }) {
    const state = await this.readState();
    const now = nowIso();
    state.monitorState.lastRunId = runId;
    state.monitorState.lastStartedAt = now;
    state.monitorState.inFlightRun = { runId, startedAt: now };
    state.monitorState.updatedAt = now;
    await this.writeState(state);
    return state.monitorState.inFlightRun;
  }

  async completeMonitorRun(runId, result = {}) {
    const state = await this.readState();
    const now = nowIso();
    const entry = {
      runId,
      status: result.status ?? "completed",
      completedAt: now,
      ...result
    };
    state.monitorState.runHistory.push(entry);
    state.monitorState.lastRunId = runId;
    state.monitorState.lastCompletedAt = now;
    state.monitorState.inFlightRun = null;
    state.monitorState.lastError = result.error ?? null;
    state.monitorState.updatedAt = now;
    await this.writeState(state);
    return entry;
  }

  async recordMonitorTrade({ market, orderResult, runId }) {
    const state = await this.readState();
    const now = nowIso();
    state.monitorState.dailyTradeUsd = normalizeDailyTradeUsd(state.monitorState.dailyTradeUsd);
    state.monitorState.dailyTradeUsd.amountUsd = roundUsd(
      state.monitorState.dailyTradeUsd.amountUsd + Number(orderResult.filledUsd ?? 0)
    );
    state.monitorState.dailyTradeUsd.trades += 1;
    for (const key of dedupeKeys(market)) {
      state.monitorState.tradedMarkets[key] = {
        runId,
        orderId: orderResult.orderId,
        filledUsd: orderResult.filledUsd,
        tradedAt: now
      };
    }
    state.monitorState.updatedAt = now;
    await this.writeState(state);
    return state.monitorState;
  }

  async recordMonitorCloseProceeds(proceedsUsd) {
    const state = await this.readState();
    state.monitorState.dailyTradeUsd = normalizeDailyTradeUsd(state.monitorState.dailyTradeUsd);
    state.monitorState.dailyClosedProceedsUsd = roundUsd(
      (Number(state.monitorState.dailyClosedProceedsUsd) || 0) + Number(proceedsUsd ?? 0)
    );
    state.monitorState.updatedAt = nowIso();
    await this.writeState(state);
  }

  async pauseOpens(reason = "manual") {
    const state = await this.readState();
    const now = nowIso();
    state.monitorState.opensPaused = true;
    state.monitorState.opensPausedAt = now;
    state.monitorState.opensPauseReason = reason;
    state.monitorState.updatedAt = now;
    await this.writeState(state);
    return state.monitorState;
  }

  async resumeOpens() {
    const state = await this.readState();
    const now = nowIso();
    state.monitorState.opensPaused = false;
    state.monitorState.opensPausedAt = null;
    state.monitorState.opensPauseReason = null;
    state.monitorState.updatedAt = now;
    await this.writeState(state);
    return state.monitorState;
  }

  async pauseMaintenance(reason = "manual") {
    const state = await this.readState();
    const now = nowIso();
    state.monitorState.maintenancePaused = true;
    state.monitorState.maintenancePausedAt = now;
    state.monitorState.maintenancePauseReason = reason;
    state.monitorState.updatedAt = now;
    await this.writeState(state);
    return state.monitorState;
  }

  async resumeMaintenance() {
    const state = await this.readState();
    const now = nowIso();
    state.monitorState.maintenancePaused = false;
    state.monitorState.maintenancePausedAt = null;
    state.monitorState.maintenancePauseReason = null;
    state.monitorState.updatedAt = now;
    await this.writeState(state);
    return state.monitorState;
  }
}
