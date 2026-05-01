import { randomUUID } from "node:crypto";
import { assertSchema } from "../domain/schemas.js";
import { validateEnvConfig } from "../config/env.js";
import { isPulseDirectStrategy } from "./pulse-strategy.js";

const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 };

function roundUsd(value) {
  return Number(Math.max(0, Number(value) || 0).toFixed(4));
}

function orderForDecision({ decision, mode, approvedUsd }) {
  return assertSchema("OrderRequest", {
    orderId: randomUUID(),
    mode,
    marketId: decision.marketId,
    tokenId: decision.tokenId,
    side: decision.side,
    amountUsd: roundUsd(approvedUsd)
  });
}

function addLimit(appliedLimits, key, value) {
  appliedLimits[key] = value;
}

function confidenceBelow(actual, minimum) {
  return (CONFIDENCE_RANK[String(actual ?? "low").toLowerCase()] ?? 0)
    < (CONFIDENCE_RANK[String(minimum ?? "medium").toLowerCase()] ?? 1);
}

function marketAgeSeconds(market) {
  const fetchedAt = Date.parse(market.fetchedAt);
  if (!Number.isFinite(fetchedAt)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, (Date.now() - fetchedAt) / 1000);
}

function positionLossWarnings(portfolio, maxLossPct) {
  return (portfolio.positions ?? []).flatMap((position) => {
    const costBasis = Number(position.size) * Number(position.avgPrice);
    if (!Number.isFinite(costBasis) || costBasis <= 0) {
      return [];
    }
    const lossPct = (costBasis - Number(position.currentValueUsd ?? 0)) / costBasis;
    if (lossPct >= maxLossPct) {
      return [`position_loss_limit_triggered:${position.tokenId}:suggest_reduce_or_close`];
    }
    return [];
  });
}

function evidenceInsufficient({ evidence = [], estimate = null, minEvidenceItems = 2 }) {
  const uncertainty = estimate?.uncertainty_factors ?? estimate?.uncertaintyFactors ?? [];
  if (uncertainty.includes("insufficient_evidence")) {
    return true;
  }
  const usable = evidence.filter((item) => item.status !== "failed" && Number(item.relevanceScore ?? item.relevance_score ?? 0) > 0);
  if (usable.length < minEvidenceItems) {
    return true;
  }
  return false;
}

function availableLiveCollateral(liveBalance) {
  if (!liveBalance) {
    return null;
  }
  return Number(
    liveBalance.collateralBalance
      ?? liveBalance.collateral?.balanceUsd
      ?? liveBalance.balanceUsd
      ?? liveBalance.availableUsd
      ?? 0
  );
}

export class RiskEngine {
  constructor(config, options = {}) {
    this.config = config;
    this.stateStore = options.stateStore ?? null;
  }

  async evaluate({
    decision,
    market,
    portfolio,
    mode,
    confirmation = null,
    evidence = [],
    estimate = null,
    systemState = null,
    liveBalance = null,
    liveBalanceError = null
  }) {
    const blockedReasons = [];
    const warnings = [];
    const appliedLimits = {};
    const requestedUsdRaw = Number(decision.requestedUsd);
    const suggestedUsd = Number(decision.suggested_notional_before_risk ?? decision.suggestedNotionalUsd);
    const pulseDirect = isPulseDirectStrategy(this.config);
    const requireEvidenceGuard = !pulseDirect || this.config.pulse?.requireEvidenceGuard;
    const liveCollateral = availableLiveCollateral(liveBalance);
    const portfolioEquityUsd = mode === "live" && liveCollateral != null
      ? liveCollateral
      : Number(portfolio.totalEquityUsd ?? 0);
    let adjusted = Number.isFinite(suggestedUsd)
      ? Math.min(requestedUsdRaw, suggestedUsd)
      : requestedUsdRaw;
    const tokenIds = new Set((market.outcomes ?? []).map((outcome) => outcome.tokenId).filter(Boolean));

    const riskState = systemState ?? (this.stateStore ? await this.stateStore.getRiskState() : { status: "active", highWaterMarkUsd: portfolioEquityUsd });
    warnings.push(...positionLossWarnings(portfolio, this.config.risk.maxPositionLossPct));

    if (mode !== "live") {
      blockedReasons.push(`unsupported_execution_mode:${mode}`);
    }
    if (riskState.status === "paused") {
      blockedReasons.push("system_paused");
    }
    if (riskState.status === "halted") {
      blockedReasons.push("system_halted_requires_explicit_resume");
    }
    const highWaterMark = Number(riskState.highWaterMarkUsd ?? portfolioEquityUsd);
    if (highWaterMark > 0) {
      const drawdownPct = (highWaterMark - portfolioEquityUsd) / highWaterMark;
      addLimit(appliedLimits, "drawdownPct", Number(Math.max(0, drawdownPct).toFixed(6)));
      if (drawdownPct >= this.config.risk.drawdownHaltPct) {
        blockedReasons.push("drawdown_halt_threshold_exceeded");
        if (this.stateStore && riskState.status !== "halted") {
          await this.stateStore.haltRisk("drawdown_halt_threshold_exceeded");
        }
      }
    }

    if (decision.action !== "open") {
      blockedReasons.push(`decision_action_${decision.action}_not_executable`);
    }
    if (!Number.isFinite(requestedUsdRaw) || requestedUsdRaw <= 0) {
      blockedReasons.push("amount_must_be_positive");
      adjusted = 0;
    }
    if (!decision.tokenId || !tokenIds.has(decision.tokenId)) {
      blockedReasons.push("token_not_in_market_snapshot");
    }
    if (market.closed) {
      blockedReasons.push("market_closed");
    }
    if (!market.active) {
      blockedReasons.push("market_inactive");
    }
    if (!market.tradable) {
      blockedReasons.push("market_not_tradable");
    }
    if (marketAgeSeconds(market) > this.config.risk.marketMaxAgeSeconds) {
      if (pulseDirect) {
        warnings.push("market_data_stale");
      } else {
        blockedReasons.push("market_data_stale");
      }
    }
    if (evidenceInsufficient({ evidence, estimate, minEvidenceItems: this.config.evidence.minEvidenceItems })) {
      if (requireEvidenceGuard) {
        blockedReasons.push("insufficient_evidence");
      } else {
        warnings.push("insufficient_evidence");
      }
    }
    const aiConfidence = estimate?.confidence ?? decision.confidence;
    if (confidenceBelow(aiConfidence, this.config.risk.minAiConfidence)) {
      if (requireEvidenceGuard) {
        blockedReasons.push("ai_confidence_below_minimum");
      } else {
        warnings.push("ai_confidence_below_minimum");
      }
    }

    const existingPosition = (portfolio.positions ?? []).find((position) => position.tokenId === decision.tokenId);
    if (!existingPosition && (portfolio.positions ?? []).length >= this.config.risk.maxPositionCount) {
      blockedReasons.push("above_max_position_count");
    }

    const maxTradeUsd = roundUsd(portfolioEquityUsd * this.config.risk.maxTradePct);
    if (adjusted > maxTradeUsd) {
      adjusted = maxTradeUsd;
      addLimit(appliedLimits, "maxTradeUsd", maxTradeUsd);
    }

    const currentExposure = (portfolio.positions ?? []).reduce((sum, position) => sum + Number(position.currentValueUsd ?? 0), 0);
    const maxTotalExposureUsd = roundUsd(portfolioEquityUsd * this.config.risk.maxTotalExposurePct);
    const totalExposureRoom = roundUsd(maxTotalExposureUsd - currentExposure);
    if (adjusted > totalExposureRoom) {
      adjusted = totalExposureRoom;
      addLimit(appliedLimits, "maxTotalExposureUsd", maxTotalExposureUsd);
    }

    const eventExposure = (portfolio.positions ?? [])
      .filter((position) => position.marketId === market.marketId || position.eventId === market.eventId)
      .reduce((sum, position) => sum + Number(position.currentValueUsd ?? 0), 0);
    const maxEventExposureUsd = roundUsd(portfolioEquityUsd * this.config.risk.maxEventExposurePct);
    const eventExposureRoom = roundUsd(maxEventExposureUsd - eventExposure);
    if (adjusted > eventExposureRoom) {
      adjusted = eventExposureRoom;
      addLimit(appliedLimits, "maxEventExposureUsd", maxEventExposureUsd);
    }

    const liquidityCapUsd = roundUsd((market.liquidityUsd ?? 0) * this.config.risk.liquidityTradeCapPct);
    if (liquidityCapUsd > 0 && adjusted > liquidityCapUsd) {
      adjusted = liquidityCapUsd;
      addLimit(appliedLimits, "liquidityCapUsd", liquidityCapUsd);
    }
    if (liquidityCapUsd <= 0) {
      blockedReasons.push("liquidity_unavailable");
    }

    adjusted = roundUsd(adjusted);
    if (requestedUsdRaw < this.config.risk.minTradeUsd) {
      blockedReasons.push("below_min_trade_usd");
    }
    if (requestedUsdRaw > 0 && adjusted <= 0) {
      blockedReasons.push("no_risk_budget_available");
    }
    if (adjusted > 0 && adjusted < this.config.risk.minTradeUsd) {
      blockedReasons.push("adjusted_notional_below_min_trade_usd");
    }

    if (confirmation !== "LIVE") {
      blockedReasons.push("live_requires_confirm_live");
    }
    const preflight = validateEnvConfig(this.config, { mode: "live" });
    if (!preflight.ok) {
      blockedReasons.push("live_preflight_failed");
    }
    if (liveBalanceError) {
      blockedReasons.push("live_balance_check_failed");
      warnings.push(`live_balance_error:${liveBalanceError}`);
    } else if (liveCollateral == null) {
      blockedReasons.push("live_balance_check_missing");
    } else if (decision.side === "BUY" && liveCollateral < adjusted) {
      blockedReasons.push("insufficient_live_collateral");
    }

    const uniqueReasons = [...new Set(blockedReasons)];
    const uniqueWarnings = [...new Set(warnings)];
    const allow = uniqueReasons.length === 0 && adjusted >= this.config.risk.minTradeUsd;
    const approvedUsd = allow ? adjusted : 0;
    const result = {
      allow,
      allowed: allow,
      reasons: uniqueReasons,
      blocked_reasons: uniqueReasons,
      blockedReasons: uniqueReasons,
      warnings: uniqueWarnings,
      applied_limits: appliedLimits,
      appliedLimits,
      adjusted_notional: adjusted,
      adjustedNotional: adjusted,
      approvedUsd,
      order: allow ? orderForDecision({ decision, mode, approvedUsd }) : null
    };
    return assertSchema("RiskDecision", result);
  }
}
