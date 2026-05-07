import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { EvidenceCrawler } from "../adapters/evidence-crawler.js";
import { ProbabilityEstimator } from "../core/probability-estimator.js";
import { DecisionEngine } from "../core/decision-engine.js";
import { RiskEngine } from "../core/risk-engine.js";
import { LiveBroker } from "../brokers/live-broker.js";
import { OrderExecutor } from "../execution/order-executor.js";
import { SimulatedMonitorLedger } from "../simulated/simulated-monitor-ledger.js";

function nowIso() {
  return new Date().toISOString();
}

function monitorRunId() {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

function asNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function blockedRisk(reason) {
  return {
    allow: false,
    allowed: false,
    reasons: [reason],
    blocked_reasons: [reason],
    blockedReasons: [reason],
    warnings: [],
    applied_limits: {},
    appliedLimits: {},
    adjusted_notional: 0,
    adjustedNotional: 0,
    approvedUsd: 0,
    order: null
  };
}

function blockedOrder({ mode, reason }) {
  return {
    orderId: "blocked-before-order",
    status: "blocked",
    mode,
    requestedUsd: 0,
    filledUsd: 0,
    avgPrice: null,
    reason
  };
}

function dedupeKeys(market) {
  return [
    market.marketId ? `market:${market.marketId}` : null,
    market.marketSlug ? `market:${market.marketSlug}` : null,
    market.eventId ? `event:${market.eventId}` : null,
    market.eventSlug ? `event:${market.eventSlug}` : null
  ].filter(Boolean);
}

function normalizeNeedle(value) {
  return String(value ?? "").trim().toLowerCase();
}

function marketMatches(market, rawNeedle) {
  const needle = normalizeNeedle(rawNeedle);
  if (!needle) {
    return false;
  }
  const exactFields = [
    market.marketId,
    market.marketSlug,
    market.eventId,
    market.eventSlug,
    market.category,
    ...(market.tags ?? [])
  ].map(normalizeNeedle);
  if (exactFields.includes(needle)) {
    return true;
  }
  return normalizeNeedle(market.question).includes(needle)
    || normalizeNeedle(market.title).includes(needle);
}

function tradedByMonitor(monitorState, market) {
  const tradedMarkets = monitorState.tradedMarkets ?? {};
  return dedupeKeys(market).some((key) => Boolean(tradedMarkets[key]));
}

function heldInPortfolio(portfolio, market) {
  return (portfolio.positions ?? []).some((position) =>
    position.marketId === market.marketId
      || position.marketSlug === market.marketSlug
      || position.eventId === market.eventId
      || position.eventSlug === market.eventSlug
  );
}

function candidateSummary(market, selected, reasons = []) {
  return {
    marketId: market.marketId,
    marketSlug: market.marketSlug,
    eventId: market.eventId,
    eventSlug: market.eventSlug,
    question: market.question,
    category: market.category ?? null,
    liquidityUsd: market.liquidityUsd,
    volume24hUsd: market.volume24hUsd,
    selected,
    skipped_reasons: reasons
  };
}

function buildCandidates({ markets, monitorState, portfolio, config }) {
  const watchlist = [...new Set([...(config.monitor.watchlist ?? []), ...(monitorState.watchlist ?? [])])];
  const blocklist = [...new Set([...(config.monitor.blocklist ?? []), ...(monitorState.blocklist ?? [])])];
  return markets.map((market) => {
    const reasons = [];
    if (watchlist.length > 0 && !watchlist.some((item) => marketMatches(market, item))) {
      reasons.push("watchlist_not_matched");
    }
    if (blocklist.some((item) => marketMatches(market, item))) {
      reasons.push("blocklisted");
    }
    if (tradedByMonitor(monitorState, market)) {
      reasons.push("already_traded_market_or_event");
    }
    if (heldInPortfolio(portfolio, market)) {
      reasons.push("existing_position_market_or_event");
    }
    return {
      market,
      summary: candidateSummary(market, reasons.length === 0, reasons)
    };
  });
}

async function mapLimit(items, limit, backoffMs, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index], index);
      if (backoffMs > 0) {
        await sleep(backoffMs);
      }
    }
  });
  await Promise.all(workers);
  return results;
}

async function withTimeout(promiseFactory, timeoutMs, label) {
  let timeout;
  try {
    return await Promise.race([
      promiseFactory(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label}_timeout_after_${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export class Scheduler {
  constructor({ config, marketSource, stateStore, artifactWriter }) {
    this.config = config;
    this.marketSource = marketSource;
    this.stateStore = stateStore;
    this.artifactWriter = artifactWriter;
    this.evidenceCrawler = new EvidenceCrawler(config);
    const probabilityConfig = config.liveWalletMode === "simulated"
      ? { ...config, suppressProviderRuntimeArtifacts: true }
      : config;
    this.probabilityEstimator = new ProbabilityEstimator(probabilityConfig);
    this.decisionEngine = new DecisionEngine(config);
    this.riskEngine = new RiskEngine(config, { stateStore });
    this.liveBroker = new LiveBroker(config);
    this.orderExecutor = new OrderExecutor({
      liveBroker: this.liveBroker
    });
    this.simulatedLedger = config.liveWalletMode === "simulated"
      ? new SimulatedMonitorLedger(config)
      : null;
  }

  async runOnce({ mode = "live", confirmation = null, marketId = null, side = "yes", amountUsd = 1 } = {}) {
    if (mode !== "live") {
      throw new Error(`unsupported_execution_mode: ${mode}; only live is supported`);
    }
    const runId = randomUUID();
    const run = await this.stateStore.createRun({ runId, stage: "started" });
    const market = marketId
      ? await this.marketSource.getMarket(marketId)
      : (await this.marketSource.scan({ limit: 1 })).markets[0];
    if (!market) {
      throw new Error(`Market not found: ${marketId ?? "first"}`);
    }

    const evidenceBundle = await this.evidenceCrawler.collect({ market });
    const portfolio = await this.stateStore.getPortfolio();
    const estimate = await this.probabilityEstimator.estimate({ market, evidence: evidenceBundle });
    const decision = this.decisionEngine.decide({ market, estimate, side, amountUsd, portfolio });
    const risk = await this.riskEngine.evaluate({ decision, market, portfolio, mode, confirmation, evidence: evidenceBundle, estimate });
    const orderResult = await this.orderExecutor.execute({ risk, market, mode, confirmation });

    const artifacts = [
      await this.artifactWriter.writeJson("evidence", runId, evidenceBundle),
      await this.artifactWriter.writeJson("prediction", runId, estimate),
      await this.artifactWriter.writeJson("decision", runId, decision),
      await this.artifactWriter.writeJson("risk", runId, risk)
    ];
    artifacts.push(await this.artifactWriter.writeJson("execution", runId, orderResult));
    await this.stateStore.updateRunStage(run.runId, "completed", { status: "completed" });
    return { ok: true, runId, mode, market, decision, risk, orderResult, artifacts };
  }

  async predictCandidate(candidate) {
    const market = candidate.market;
    const evidence = await this.evidenceCrawler.collect({ market });
    const estimate = await this.probabilityEstimator.estimate({ market, evidence });
    return { market, evidence, estimate };
  }

  async predictCandidateNoCache(candidate) {
    const market = candidate.market;
    const evidence = await this.evidenceCrawler.collect({ market, noCache: true });
    const estimate = await this.probabilityEstimator.estimate({ market, evidence });
    return { market, evidence, estimate };
  }

  async getLiveBalanceContext({ mode, confirmation }) {
    if (mode !== "live" || confirmation !== "LIVE") {
      return { liveBalance: null, liveBalanceError: null };
    }
    try {
      const balance = await this.liveBroker.getBalance();
      return { liveBalance: balance, liveBalanceError: null };
    } catch (error) {
      return {
        liveBalance: null,
        liveBalanceError: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async evaluateAndMaybeOrder({ prediction, mode, confirmation, maxAmountUsd, runId, orderCount, filledUsdThisRun, liveBalance, liveBalanceError }) {
    const portfolio = await this.stateStore.getPortfolio();
    const analysis = this.decisionEngine.analyze({
      market: prediction.market,
      estimate: prediction.estimate,
      portfolio,
      amountUsd: maxAmountUsd
    });
    const chosenSide = analysis.suggested_side ?? "yes";
    const decision = this.decisionEngine.decide({
      market: prediction.market,
      estimate: prediction.estimate,
      side: chosenSide,
      amountUsd: maxAmountUsd,
      portfolio
    });

    if (orderCount >= this.config.monitor.maxTradesPerRound) {
      const risk = blockedRisk("monitor_round_trade_limit_reached");
      return { decision, risk, order: blockedOrder({ mode, reason: "monitor_round_trade_limit_reached" }) };
    }

    const monitorState = await this.stateStore.getMonitorState();
    const maxDaily = this.config.monitor.maxDailyTradeUsd;
    const dailyUsed = asNumber(monitorState.dailyTradeUsd?.amountUsd);
    const remainingDaily = Math.max(0, maxDaily - dailyUsed - filledUsdThisRun);
    if (remainingDaily < this.config.risk.minTradeUsd) {
      const risk = blockedRisk("monitor_daily_trade_limit_reached");
      return { decision, risk, order: blockedOrder({ mode, reason: "monitor_daily_trade_limit_reached" }) };
    }

    const amountUsd = Math.min(maxAmountUsd, remainingDaily);
    const boundedDecision = this.decisionEngine.decide({
      market: prediction.market,
      estimate: prediction.estimate,
      side: chosenSide,
      amountUsd,
      portfolio
    });
    const risk = await this.riskEngine.evaluate({
      decision: boundedDecision,
      market: prediction.market,
      portfolio,
      mode,
      confirmation,
      evidence: prediction.evidence,
      estimate: prediction.estimate,
      liveBalance,
      liveBalanceError
    });
    const order = await this.orderExecutor.execute({ risk, market: prediction.market, mode, confirmation });
    if (order.status === "filled" && order.filledUsd > 0) {
      await this.stateStore.recordMonitorTrade({ market: prediction.market, orderResult: order, runId, mode });
    }
    return { decision: boundedDecision, risk, order };
  }

  async reviewSimulatedPositions({ runId, accumulator }) {
    const ledger = this.simulatedLedger;
    await ledger.markToMarket({ markets: accumulator.scan.markets ?? [], marketSource: this.marketSource });
    const signalClosed = await ledger.closeBySignals();
    for (const closed of signalClosed) {
      accumulator.orders.push({
        marketId: closed.marketId,
        marketSlug: closed.marketSlug,
        orderId: `sim-close-${closed.positionId}`,
        status: "filled",
        mode: "live",
        requestedUsd: 0,
        filledUsd: closed.proceedsUsd,
        avgPrice: closed.currentPrice,
        reason: closed.closeReason,
        paper: true,
        type: "close"
      });
    }

    for (const position of [...ledger.positions]) {
      const market = await this.marketSource.getMarket(position.marketId || position.marketSlug, { noCache: true });
      if (!market) {
        await ledger.log("position.review_skipped", { market: position.marketSlug, reason: "market_not_found" });
        continue;
      }
      const prediction = await this.predictCandidateNoCache({ market });
      const portfolio = ledger.portfolio();
      const analysis = this.decisionEngine.analyze({
        market: prediction.market,
        estimate: prediction.estimate,
        portfolio,
        amountUsd: this.config.risk.minTradeUsd
      });
      const chosenSide = analysis.suggested_side ?? position.side ?? "yes";
      const decision = this.decisionEngine.decide({
        market: prediction.market,
        estimate: prediction.estimate,
        side: chosenSide,
        amountUsd: this.config.risk.minTradeUsd,
        portfolio
      });
      prediction.decision = decision;
      prediction.phase = "position-review";
      accumulator.predictions.push(prediction);
      accumulator.decisions.push({
        marketId: prediction.market.marketId,
        marketSlug: prediction.market.marketSlug,
        question: prediction.market.question,
        phase: "position-review",
        ...decision
      });
      await ledger.logPrediction({ market: prediction.market, estimate: prediction.estimate, decision, phase: "position-review" });
      const closed = await ledger.closeOnDecision({ position, decision });
      if (closed) {
        accumulator.orders.push({
          marketId: closed.marketId,
          marketSlug: closed.marketSlug,
          orderId: `sim-close-${closed.positionId}`,
          status: "filled",
          mode: "live",
          requestedUsd: 0,
          filledUsd: closed.proceedsUsd,
          avgPrice: closed.currentPrice,
          reason: closed.closeReason,
          paper: true,
          type: "close"
        });
      }
    }
    await ledger.log("positions.reviewed", {
      run_id: runId,
      open_positions: ledger.positions.length,
      closed_positions: ledger.closedTrades.length
    });
  }

  async evaluateAndMaybeSimulatedOrder({ prediction, mode, confirmation, maxAmountUsd, runId, orderCount, filledUsdThisRun, side = null }) {
    const ledger = this.simulatedLedger;
    const portfolio = ledger.portfolio();
    const analysis = this.decisionEngine.analyze({
      market: prediction.market,
      estimate: prediction.estimate,
      portfolio,
      amountUsd: maxAmountUsd
    });
    const chosenSide = side ?? analysis.suggested_side ?? "yes";
    const decision = this.decisionEngine.decide({
      market: prediction.market,
      estimate: prediction.estimate,
      side: chosenSide,
      amountUsd: maxAmountUsd,
      portfolio
    });

    if (orderCount >= this.config.monitor.maxTradesPerRound) {
      const risk = blockedRisk("monitor_round_trade_limit_reached");
      await ledger.logPrediction({ market: prediction.market, estimate: prediction.estimate, decision, phase: "open-scan" });
      await ledger.logRisk({ market: prediction.market, risk });
      return { decision, risk, order: blockedOrder({ mode, reason: "monitor_round_trade_limit_reached" }) };
    }

    const maxDaily = this.config.monitor.maxDailyTradeUsd;
    const dailyUsed = asNumber(ledger.dailyTradeUsd?.amountUsd);
    const remainingDaily = Math.max(0, maxDaily - dailyUsed - filledUsdThisRun);
    if (remainingDaily < this.config.risk.minTradeUsd) {
      const risk = blockedRisk("monitor_daily_trade_limit_reached");
      await ledger.logPrediction({ market: prediction.market, estimate: prediction.estimate, decision, phase: "open-scan" });
      await ledger.logRisk({ market: prediction.market, risk });
      return { decision, risk, order: blockedOrder({ mode, reason: "monitor_daily_trade_limit_reached" }) };
    }

    const amountUsd = Math.min(maxAmountUsd, remainingDaily);
    const boundedDecision = this.decisionEngine.decide({
      market: prediction.market,
      estimate: prediction.estimate,
      side: chosenSide,
      amountUsd,
      portfolio
    });
    const risk = await new RiskEngine(this.config).evaluate({
      decision: boundedDecision,
      market: prediction.market,
      portfolio,
      mode,
      confirmation,
      evidence: prediction.evidence,
      estimate: prediction.estimate,
      systemState: ledger.riskState(),
      liveBalance: ledger.liveBalance(),
      liveBalanceError: null
    });
    await ledger.logPrediction({ market: prediction.market, estimate: prediction.estimate, decision: boundedDecision, phase: "open-scan" });
    await ledger.logRisk({ market: prediction.market, risk });
    const order = await ledger.openPosition({ market: prediction.market, decision: boundedDecision, risk });
    if (order.status !== "filled") {
      await ledger.log("order.blocked", {
        market: prediction.market.marketSlug,
        status: order.status,
        reason: order.reason ?? "none"
      });
    }
    return { decision: boundedDecision, risk, order };
  }

  async runSimulatedTradeOnce({ mode = "live", confirmation = null, marketId, side = null, maxAmountUsd = 1 } = {}) {
    if (mode !== "live") {
      throw new Error(`unsupported_execution_mode: ${mode}; only live is supported`);
    }
    if (!this.simulatedLedger) {
      throw new Error("simulated_ledger_unavailable");
    }
    const runId = monitorRunId();
    const startedAt = nowIso();
    const ledger = this.simulatedLedger;
    const accumulator = {
      runId,
      mode,
      startedAt,
      completedAt: null,
      scan: { source: this.config.marketSource, fetchedAt: startedAt, markets: [], errors: [] },
      candidates: [],
      predictions: [],
      decisions: [],
      risks: [],
      orders: [],
      errors: [],
      recoveredRun: null
    };

    await ledger.beginRound({ runId, limit: 1, maxAmountUsd });

    try {
      await withTimeout(async () => {
        const market = await this.marketSource.getMarket(marketId, { noCache: true });
        if (!market) {
          throw new Error(`Market not found: ${marketId}`);
        }
        accumulator.scan = {
          source: market.source ?? this.config.marketSource,
          fetchedAt: market.fetchedAt ?? nowIso(),
          totalFetched: 1,
          totalReturned: 1,
          riskFlags: market.riskFlags ?? [],
          markets: [market],
          errors: []
        };
        await ledger.logScan(accumulator.scan);
        await this.reviewSimulatedPositions({ runId, accumulator });
        accumulator.candidates = [candidateSummary(market, true, [])];
        await ledger.log("candidate", {
          market: market.marketSlug,
          selected: true,
          reasons: "none"
        });

        const prediction = await this.predictCandidateNoCache({ market });
        accumulator.predictions.push(prediction);
        const result = await this.evaluateAndMaybeSimulatedOrder({
          prediction,
          mode,
          confirmation,
          maxAmountUsd: maxAmountUsd ?? this.config.risk.minTradeUsd,
          runId,
          orderCount: 0,
          filledUsdThisRun: 0,
          side
        });
        prediction.decision = result.decision;
        prediction.risk = result.risk;
        prediction.order = result.order;
        accumulator.decisions.push({
          marketId: prediction.market.marketId,
          marketSlug: prediction.market.marketSlug,
          question: prediction.market.question,
          phase: "open-scan",
          ...result.decision
        });
        accumulator.risks.push({
          marketId: prediction.market.marketId,
          marketSlug: prediction.market.marketSlug,
          ...result.risk
        });
        accumulator.orders.push({
          marketId: prediction.market.marketId,
          marketSlug: prediction.market.marketSlug,
          ...result.order
        });
        await ledger.markToMarket({ markets: accumulator.scan.markets ?? [], marketSource: this.marketSource });
      }, this.config.monitor.runTimeoutMs, "trade_once");
      accumulator.completedAt = nowIso();
      await ledger.endRound({ runId, status: "completed", errors: accumulator.errors });
      const prediction = accumulator.predictions[0];
      const decision = accumulator.decisions[0] ?? null;
      const risk = accumulator.risks[0] ?? null;
      const order = accumulator.orders[0] ?? null;
      const action = order?.status === "filled" ? "simulated-orders" : "no-trade";
      return {
        ok: true,
        status: "completed",
        mode,
        runId,
        provider: prediction?.estimate?.diagnostics?.provider,
        effectiveProvider: prediction?.estimate?.diagnostics?.effectiveProvider,
        market_question: prediction?.market?.question,
        ai_probability: prediction?.estimate?.ai_probability,
        market_probability: decision?.market_implied_probability ?? decision?.marketProbability ?? null,
        edge: decision?.edge ?? decision?.grossEdge ?? null,
        net_edge: decision?.netEdge ?? null,
        entry_fee_pct: decision?.entryFeePct ?? null,
        quarter_kelly_pct: decision?.quarterKellyPct ?? null,
        monthly_return: decision?.monthlyReturn ?? null,
        action,
        artifact: ledger.logPath,
        log: ledger.logPath,
        market: prediction?.market,
        evidence: prediction?.evidence,
        estimate: prediction?.estimate,
        decision,
        risk,
        orderResult: order,
        artifacts: [],
        performance: ledger.statistics()
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      accumulator.errors.push(message);
      accumulator.completedAt = nowIso();
      await ledger.endRound({ runId, status: "failed", errors: accumulator.errors });
      return {
        ok: false,
        status: "failed",
        mode,
        runId,
        error: message,
        action: "no-trade",
        artifact: ledger.logPath,
        log: ledger.logPath,
        artifacts: [],
        performance: ledger.statistics()
      };
    }
  }

  async runSimulatedMonitorRound({ mode = "live", confirmation = null, limit = null, maxAmountUsd = null } = {}) {
    if (mode !== "live") {
      throw new Error(`unsupported_execution_mode: ${mode}; only live is supported`);
    }
    const runId = monitorRunId();
    const startedAt = nowIso();
    const ledger = this.simulatedLedger;
    const accumulator = {
      runId,
      mode,
      startedAt,
      completedAt: null,
      scan: { source: this.config.marketSource, fetchedAt: startedAt, markets: [], errors: [] },
      candidates: [],
      predictions: [],
      decisions: [],
      risks: [],
      orders: [],
      errors: [],
      recoveredRun: null
    };

    await ledger.beginRound({ runId, limit, maxAmountUsd });

    try {
      await withTimeout(async () => {
        accumulator.scan = await this.marketSource.scan({
          limit: limit ?? this.config.scan.marketScanLimit,
          noCache: true
        });
        await ledger.logScan(accumulator.scan);
        await this.reviewSimulatedPositions({ runId, accumulator });
        const candidateEntries = buildCandidates({
          markets: accumulator.scan.markets ?? [],
          monitorState: ledger.monitorState(),
          portfolio: ledger.portfolio(),
          config: this.config
        });
        accumulator.candidates = candidateEntries.map((item) => item.summary);
        for (const candidate of accumulator.candidates) {
          await ledger.log("candidate", {
            market: candidate.marketSlug,
            selected: candidate.selected,
            reasons: (candidate.skipped_reasons ?? []).join(",") || "none"
          });
        }
        const selected = candidateEntries.filter((item) => item.summary.selected);
        const predictions = await mapLimit(
          selected,
          this.config.monitor.concurrency,
          this.config.monitor.backoffMs,
          async (candidate) => {
            try {
              return await this.predictCandidateNoCache(candidate);
            } catch (error) {
              accumulator.errors.push(`prediction_failed:${candidate.market.marketId}:${error instanceof Error ? error.message : String(error)}`);
              return null;
            }
          }
        );
        accumulator.predictions.push(...predictions.filter(Boolean));
        let orderCount = 0;
        let filledUsdThisRun = 0;
        for (const prediction of predictions.filter(Boolean)) {
          const result = await this.evaluateAndMaybeSimulatedOrder({
            prediction,
            mode,
            confirmation,
            maxAmountUsd: maxAmountUsd ?? this.config.risk.minTradeUsd,
            runId,
            orderCount,
            filledUsdThisRun
          });
          prediction.decision = result.decision;
          prediction.risk = result.risk;
          prediction.order = result.order;
          accumulator.decisions.push({
            marketId: prediction.market.marketId,
            marketSlug: prediction.market.marketSlug,
            question: prediction.market.question,
            phase: "open-scan",
            ...result.decision
          });
          accumulator.risks.push({
            marketId: prediction.market.marketId,
            marketSlug: prediction.market.marketSlug,
            ...result.risk
          });
          accumulator.orders.push({
            marketId: prediction.market.marketId,
            marketSlug: prediction.market.marketSlug,
            ...result.order
          });
          if (result.order.status === "filled" && result.order.filledUsd > 0) {
            orderCount += 1;
            filledUsdThisRun += result.order.filledUsd;
          }
        }
        await ledger.markToMarket({ markets: accumulator.scan.markets ?? [], marketSource: this.marketSource });
      }, this.config.monitor.runTimeoutMs, "monitor_round");
      accumulator.completedAt = nowIso();
      await ledger.endRound({ runId, status: "completed", errors: accumulator.errors });
      return {
        ok: true,
        status: "completed",
        mode,
        runId,
        markets: accumulator.scan.markets?.length ?? 0,
        candidates: accumulator.candidates.filter((item) => item.selected).length,
        predictions: accumulator.predictions.length,
        orders: accumulator.orders.filter((order) => order.status === "filled").length,
        action: accumulator.orders.some((order) => order.status === "filled") ? "simulated-orders" : "no-trade",
        artifact: ledger.logPath,
        log: ledger.logPath,
        performance: ledger.statistics()
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      accumulator.errors.push(message);
      accumulator.completedAt = nowIso();
      await ledger.endRound({ runId, status: "failed", errors: accumulator.errors });
      return {
        ok: false,
        status: "failed",
        mode,
        runId,
        error: message,
        artifact: ledger.logPath,
        log: ledger.logPath,
        performance: ledger.statistics()
      };
    }
  }

  async runMonitorRound({ mode = "live", confirmation = null, limit = null, maxAmountUsd = null } = {}) {
    if (mode !== "live") {
      throw new Error(`unsupported_execution_mode: ${mode}; only live is supported`);
    }
    if (this.simulatedLedger) {
      return await this.runSimulatedMonitorRound({ mode, confirmation, limit, maxAmountUsd });
    }
    const runId = monitorRunId();
    const startedAt = nowIso();
    const recoveredRun = await this.stateStore.recoverMonitorRun();
    const monitorState = await this.stateStore.getMonitorState();
    if (monitorState.status === "stopped") {
      return {
        ok: true,
        status: "stopped",
        mode,
        reason: monitorState.stopReason ?? "monitor_stopped",
        artifact: null
      };
    }

    await this.stateStore.startMonitorRun({ runId, mode });
    const accumulator = {
      runId,
      mode,
      startedAt,
      completedAt: null,
      scan: { source: this.config.marketSource, fetchedAt: startedAt, markets: [], errors: [] },
      candidates: [],
      predictions: [],
      decisions: [],
      risks: [],
      orders: [],
      errors: [],
      recoveredRun
    };

    const finish = async (status = "completed", error = null) => {
      accumulator.completedAt = nowIso();
      const artifacts = await this.artifactWriter.writeMonitorRun(accumulator);
      await this.stateStore.completeMonitorRun(runId, {
        status,
        error,
        artifact: artifacts.summary.path,
        markets: accumulator.scan.markets?.length ?? 0,
        candidates: accumulator.candidates.filter((item) => item.selected).length,
        predictions: accumulator.predictions.length,
        orders: accumulator.orders.filter((order) => order.status === "filled").length
      });
      return artifacts;
    };

    try {
      await withTimeout(async () => {
        accumulator.scan = await this.marketSource.scan({ limit: limit ?? this.config.scan.marketScanLimit });
        const candidateEntries = buildCandidates({
          markets: accumulator.scan.markets ?? [],
          monitorState: await this.stateStore.getMonitorState(),
          portfolio: await this.stateStore.getPortfolio(),
          config: this.config
        });
        accumulator.candidates = candidateEntries.map((item) => item.summary);
        const selected = candidateEntries.filter((item) => item.summary.selected);
        const predictions = await mapLimit(
          selected,
          this.config.monitor.concurrency,
          this.config.monitor.backoffMs,
          async (candidate) => {
            try {
              return await this.predictCandidate(candidate);
            } catch (error) {
              accumulator.errors.push(`prediction_failed:${candidate.market.marketId}:${error instanceof Error ? error.message : String(error)}`);
              return null;
            }
          }
        );
        accumulator.predictions = predictions.filter(Boolean);
        const { liveBalance, liveBalanceError } = await this.getLiveBalanceContext({ mode, confirmation });
        let orderCount = 0;
        let filledUsdThisRun = 0;
        for (const prediction of accumulator.predictions) {
          const result = await this.evaluateAndMaybeOrder({
            prediction,
            mode,
            confirmation,
            maxAmountUsd: maxAmountUsd ?? this.config.risk.minTradeUsd,
            runId,
            orderCount,
            filledUsdThisRun,
            liveBalance,
            liveBalanceError
          });
          prediction.decision = result.decision;
          prediction.risk = result.risk;
          prediction.order = result.order;
          accumulator.decisions.push({
            marketId: prediction.market.marketId,
            marketSlug: prediction.market.marketSlug,
            question: prediction.market.question,
            ...result.decision
          });
          accumulator.risks.push({
            marketId: prediction.market.marketId,
            marketSlug: prediction.market.marketSlug,
            ...result.risk
          });
          accumulator.orders.push({
            marketId: prediction.market.marketId,
            marketSlug: prediction.market.marketSlug,
            ...result.order
          });
          if (result.order.status === "filled" && result.order.filledUsd > 0) {
            orderCount += 1;
            filledUsdThisRun += result.order.filledUsd;
          }
        }
      }, this.config.monitor.runTimeoutMs, "monitor_round");
      const artifacts = await finish("completed");
      return {
        ok: true,
        status: "completed",
        mode,
        runId,
        markets: accumulator.scan.markets?.length ?? 0,
        candidates: accumulator.candidates.filter((item) => item.selected).length,
        predictions: accumulator.predictions.length,
        orders: accumulator.orders.filter((order) => order.status === "filled").length,
        action: accumulator.orders.some((order) => order.status === "filled") ? "live-orders" : "no-trade",
        artifact: artifacts.summary.path
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      accumulator.errors.push(message);
      const artifacts = await finish("failed", message);
      return {
        ok: false,
        status: "failed",
        mode,
        runId,
        error: message,
        artifact: artifacts.summary.path
      };
    }
  }

  async monitorRun(options = {}) {
    return await this.runMonitorRound(options);
  }

  async monitorLoop({ mode = "live", confirmation = null, rounds = 1, limit = null, maxAmountUsd = null, onRound = null } = {}) {
    if (mode !== "live") {
      throw new Error(`unsupported_execution_mode: ${mode}; only live is supported`);
    }
    const results = [];
    let completed = 0;
    while (rounds == null || completed < rounds) {
      const state = this.simulatedLedger ? { status: "active" } : await this.stateStore.getMonitorState();
      if (!this.simulatedLedger && state.status === "stopped") {
        const result = { ok: true, status: "stopped", mode, reason: state.stopReason ?? "monitor_stopped", artifact: null };
        results.push(result);
        if (onRound) await onRound(result);
        break;
      }
      const result = await this.monitorRun({ mode, confirmation, limit, maxAmountUsd });
      results.push(result);
      if (onRound) await onRound(result);
      completed += 1;
      if (rounds != null && completed >= rounds) {
        break;
      }
      await sleep(result.ok ? this.config.monitor.intervalSeconds * 1000 : this.config.monitor.backoffMs);
    }
    return {
      ok: results.every((item) => item.ok),
      status: results.at(-1)?.status ?? "completed",
      mode,
      rounds: results.length,
      last: results.at(-1) ?? null
    };
  }
}
