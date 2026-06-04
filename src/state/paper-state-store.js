import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

function nowIso() {
  return new Date().toISOString();
}

function roundUsd(value) {
  return Number((Number(value) || 0).toFixed(4));
}

function paperStateFilePath(config) {
  return path.join(config.stateDir, "paper-state.json");
}

function emptyMonitorState(now = nowIso()) {
  return {
    opensPaused: false,
    opensPauseReason: null,
    maintenancePaused: false,
    maintenancePauseReason: null,
    lastRunId: null,
    lastStartedAt: null,
    lastCompletedAt: null,
    dailyTradeUsd: { date: now.slice(0, 10), amountUsd: 0, trades: 0 },
    tradedMarkets: {},
    inFlightRun: null,
    lastError: null,
    updatedAt: now
  };
}

function emptyPaperState(now = nowIso()) {
  return {
    version: 1,
    mode: "paper",
    initialCashUsd: 0,
    cashUsd: 0,
    totalEquityUsd: 0,
    highWaterMarkUsd: 0,
    maxDrawdownUsd: 0,
    positions: [],
    closedTrades: [],
    monitorState: emptyMonitorState(now),
    updatedAt: now
  };
}

function normalizePaperState(value) {
  const base = emptyPaperState();
  const state = value && typeof value === "object" ? value : {};
  const monitorRaw = state.monitorState && typeof state.monitorState === "object" ? state.monitorState : {};
  const monitorBase = emptyMonitorState();
  return {
    ...base,
    ...state,
    version: state.version ?? 1,
    mode: "paper",
    initialCashUsd: roundUsd(state.initialCashUsd ?? base.initialCashUsd),
    cashUsd: roundUsd(state.cashUsd ?? base.cashUsd),
    totalEquityUsd: roundUsd(state.totalEquityUsd ?? base.totalEquityUsd),
    highWaterMarkUsd: roundUsd(state.highWaterMarkUsd ?? base.highWaterMarkUsd),
    maxDrawdownUsd: roundUsd(state.maxDrawdownUsd ?? base.maxDrawdownUsd),
    positions: Array.isArray(state.positions) ? state.positions : [],
    closedTrades: Array.isArray(state.closedTrades) ? state.closedTrades : [],
    monitorState: { ...monitorBase, ...monitorRaw },
    updatedAt: state.updatedAt ?? nowIso()
  };
}

export class PaperStateStore {
  constructor(config) {
    this.config = config;
    this.path = paperStateFilePath(config);
  }

  async readState() {
    try {
      const raw = await readFile(this.path, "utf8");
      return normalizePaperState(JSON.parse(raw));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      const state = emptyPaperState();
      await this.writeState(state);
      return state;
    }
  }

  async writeState(state) {
    const normalized = normalizePaperState(state);
    normalized.updatedAt = nowIso();
    await mkdir(path.dirname(this.path), { recursive: true });
    const tmpPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    await rename(tmpPath, this.path);
    return normalized;
  }

  async getInitialState() {
    return await this.readState();
  }

  async savePosition(position) {
    const state = await this.readState();
    const existingIndex = state.positions.findIndex((p) => p.positionId === position.positionId);
    if (existingIndex >= 0) {
      state.positions[existingIndex] = position;
    } else {
      state.positions.push(position);
    }
    state.cashUsd = roundUsd(state.initialCashUsd - state.positions.reduce((sum, p) => sum + (p.costUsd || 0), 0));
    const positionsValue = state.positions.reduce((sum, p) => sum + (p.currentValueUsd || 0), 0);
    state.totalEquityUsd = roundUsd(state.cashUsd + positionsValue);
    state.highWaterMarkUsd = Math.max(roundUsd(state.highWaterMarkUsd), roundUsd(state.totalEquityUsd));
    state.maxDrawdownUsd = Math.max(roundUsd(state.maxDrawdownUsd), roundUsd(state.highWaterMarkUsd - state.totalEquityUsd));
    await this.writeState(state);
    return state;
  }

  async closePosition(positionId, { proceedsUsd = 0, reason = "" } = {}) {
    const state = await this.readState();
    const idx = state.positions.findIndex((p) => p.positionId === positionId);
    if (idx < 0) return null;
    const [position] = state.positions.splice(idx, 1);
    const closedTrade = {
      ...position,
      closedAt: nowIso(),
      closeReason: reason,
      exitPrice: position.currentPrice,
      proceedsUsd,
      realizedPnlUsd: roundUsd(proceedsUsd - (position.costUsd || 0)),
      returnPct: position.costUsd > 0 ? roundUsd((proceedsUsd - position.costUsd) / position.costUsd) : 0
    };
    state.closedTrades.push(closedTrade);
    state.cashUsd = roundUsd(state.cashUsd + proceedsUsd);
    const positionsValue = state.positions.reduce((sum, p) => sum + (p.currentValueUsd || 0), 0);
    state.totalEquityUsd = roundUsd(state.cashUsd + positionsValue);
    await this.writeState(state);
    return closedTrade;
  }

  async updatePositions(markets = []) {
    const state = await this.readState();
    const marketMap = new Map(markets.map((m) => [m.marketId || m.marketSlug, m]));
    state.positions = state.positions.map((position) => {
      const market = marketMap.get(position.marketId || position.marketSlug);
      if (market) {
        const outcome = (market.outcomes ?? []).find((o) => o.tokenId === position.tokenId);
        const price = outcome ? Number(outcome.lastPrice ?? outcome.bestBid ?? outcome.bestAsk ?? position.currentPrice) : position.currentPrice;
        const currentValueUsd = roundUsd(position.size * price);
        return {
          ...position,
          currentPrice: price,
          currentValueUsd,
          unrealizedPnlUsd: roundUsd(currentValueUsd - (position.costUsd || 0)),
          marketClosed: Boolean(market.closed),
          updatedAt: nowIso()
        };
      }
      return position;
    });
    const positionsValue = state.positions.reduce((sum, p) => sum + (p.currentValueUsd || 0), 0);
    state.totalEquityUsd = roundUsd(state.cashUsd + positionsValue);
    state.highWaterMarkUsd = Math.max(roundUsd(state.highWaterMarkUsd), roundUsd(state.totalEquityUsd));
    state.maxDrawdownUsd = Math.max(roundUsd(state.maxDrawdownUsd), roundUsd(state.highWaterMarkUsd - state.totalEquityUsd));
    await this.writeState(state);
    return state.positions;
  }

  async getClosedTrades() {
    const state = await this.readState();
    return state.closedTrades;
  }

  async getPositions() {
    const state = await this.readState();
    return state.positions;
  }

  async persistPositions(positions) {
    const state = await this.readState();
    state.positions = positions;
    const positionsValue = positions.reduce((sum, p) => sum + (p.currentValueUsd || 0), 0);
    state.totalEquityUsd = roundUsd(state.cashUsd + positionsValue);
    state.highWaterMarkUsd = Math.max(roundUsd(state.highWaterMarkUsd), roundUsd(state.totalEquityUsd));
    state.maxDrawdownUsd = Math.max(roundUsd(state.maxDrawdownUsd), roundUsd(state.highWaterMarkUsd - state.totalEquityUsd));
    await this.writeState(state);
  }

  async getMonitorState() {
    const state = await this.readState();
    return state.monitorState;
  }

  async getRiskState() {
    return { status: "active", opensPaused: false, highWaterMarkUsd: 0 };
  }

  async pauseOpens(reason = "manual") {
    const state = await this.readState();
    state.monitorState.opensPaused = true;
    state.monitorState.opensPauseReason = reason;
    state.monitorState.updatedAt = nowIso();
    await this.writeState(state);
    return state.monitorState;
  }

  async resumeOpens() {
    const state = await this.readState();
    state.monitorState.opensPaused = false;
    state.monitorState.opensPauseReason = null;
    state.monitorState.updatedAt = nowIso();
    await this.writeState(state);
    return state.monitorState;
  }

  async pauseMaintenance(reason = "manual") {
    const state = await this.readState();
    state.monitorState.maintenancePaused = true;
    state.monitorState.maintenancePauseReason = reason;
    state.monitorState.updatedAt = nowIso();
    await this.writeState(state);
    return state.monitorState;
  }

  async resumeMaintenance() {
    const state = await this.readState();
    state.monitorState.maintenancePaused = false;
    state.monitorState.maintenancePauseReason = null;
    state.monitorState.updatedAt = nowIso();
    await this.writeState(state);
    return state.monitorState;
  }

  async syncFromLedger(ledger) {
    const state = await this.readState();
    state.initialCashUsd = roundUsd(ledger.initialCashUsd);
    state.positions = ledger.positions;
    state.closedTrades = ledger.closedTrades;
    state.cashUsd = roundUsd(ledger.cashUsd);
    const positionsValue = ledger.positions.reduce((sum, p) => sum + (p.currentValueUsd || 0), 0);
    state.totalEquityUsd = roundUsd(state.cashUsd + positionsValue);
    state.highWaterMarkUsd = roundUsd(ledger.highWaterMarkUsd);
    state.maxDrawdownUsd = roundUsd(ledger.maxDrawdownUsd);
    await this.writeState(state);
  }
}
