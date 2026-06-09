import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULTS, redactSecrets } from "../config/env.js";

function nowIso() {
  return new Date().toISOString();
}

export class MonitorLogger {
  constructor(config) {
    this.config = config;
    this.logPath = path.resolve(config.monitorLogPath ?? "logs/polypulse-monitor.log");
    this.logReady = false;
  }

  async ensureLog() {
    if (this.logReady) return;
    await mkdir(path.dirname(this.logPath), { recursive: true });
    const envLines = Object.keys(DEFAULTS).map((key) => {
      const value = this.config._loadedEnvValues?.[key] ?? "(unset)";
      const redacted = redactSecrets({ [key]: value });
      return `  ${key}=${redacted[key]}`;
    });
    await appendFile(this.logPath, [
      "",
      "================================================================================",
      `[${nowIso()}] monitor session started`,
      `execution_mode=${this.config.executionMode}`,
      `initial_cash_usd=${this.config._initialCashUsd ?? "unknown"}`,
      `market_source=${this.config.marketSource}`,
      `gamma=${this.config.polymarketGammaHost}`,
      "--- loaded env ---",
      ...envLines,
      "--- end env ---",
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

  async logRoundStart({ runId, limit, maxAmountUsd, cashUsd, openPositions }) {
    await this.log("round.start", {
      run_id: runId,
      limit: limit ?? "default",
      max_amount_usd: maxAmountUsd ?? "default",
      cash_usd: cashUsd ?? 0,
      open_positions: openPositions ?? 0
    });
  }

  async logRoundEnd({ runId, status = "completed", stats = {}, errors = [] }) {
    await this.log("round.end", {
      run_id: runId,
      status,
      cash_usd: stats.cashUsd ?? 0,
      equity_usd: stats.totalEquityUsd ?? 0,
      open_positions: stats.openPositions ?? 0,
      realized_pnl_usd: stats.realizedPnlUsd ?? 0,
      unrealized_pnl_usd: stats.unrealizedPnlUsd ?? 0,
      wins: stats.wins ?? 0,
      losses: stats.losses ?? 0,
      win_rate: stats.winRate ?? "n/a",
      max_drawdown_usd: stats.maxDrawdownUsd ?? 0,
      errors: errors.length ? errors.join(";") : "none"
    });
  }

  async logScan(scan) {
    await this.log("topics.fetched", {
      source: scan.source,
      markets: scan.markets?.length ?? 0,
      total_fetched: scan.totalFetched ?? 0,
      risk_flags: (scan.riskFlags ?? []).join(",") || "none"
    });
    for (const [index, market] of (scan.markets ?? []).entries()) {
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

  async logOrder(event, { market, order }) {
    await this.log(event, {
      market: market.marketSlug ?? market.marketId,
      order_id: order.orderId,
      status: order.status,
      filled_usd: order.filledUsd ?? 0,
      avg_price: order.avgPrice ?? "n/a",
      reason: order.reason ?? "none"
    });
  }

  async logCandidate({ market, selected, reasons }) {
    await this.log("candidate", {
      market: market.marketSlug ?? market.marketId,
      selected,
      reasons: (reasons ?? []).join(",") || "none"
    });
  }

  async logMarkToMarket({ openPositions, unrealizedPnlUsd, totalEquityUsd }) {
    await this.log("mark_to_market", {
      open_positions: openPositions,
      unrealized_pnl_usd: unrealizedPnlUsd,
      total_equity_usd: totalEquityUsd
    });
  }

  async logClose({ market, outcome, reason, exitPrice, proceedsUsd, realizedPnlUsd, cashUsd, winRate }) {
    await this.log("close.filled", {
      market,
      outcome,
      reason,
      exit_price: exitPrice,
      proceeds_usd: proceedsUsd,
      realized_pnl_usd: realizedPnlUsd,
      cash_usd: cashUsd,
      win_rate: winRate ?? "n/a"
    });
  }

  async logHold({ market, outcome, currentPrice, unrealizedPnlUsd, reason }) {
    await this.log("hold", {
      market,
      outcome,
      current_price: currentPrice,
      unrealized_pnl_usd: unrealizedPnlUsd,
      reason
    });
  }
}
