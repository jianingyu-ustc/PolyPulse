import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { EvidenceCrawler } from "../adapters/evidence-crawler.js";
import { ProbabilityEstimator } from "../core/probability-estimator.js";
import { ProbabilityCalibrationLayer } from "../core/probability-calibration.js";
import { DynamicCalibrationStore } from "../core/dynamic-calibration-store.js";
import { ReturnAttributionEngine } from "../core/return-attribution.js";
import { DecisionEngine } from "../core/decision-engine.js";
import { RiskEngine } from "../core/risk-engine.js";
import { CandidateTriageProvider } from "../runtime/candidate-triage-runtime.js";
import { PreScreenProvider } from "../runtime/prescreen-runtime.js";
import { EvidenceGapRuntime } from "../runtime/evidence-gap-runtime.js";
import { EvidenceResearchProvider } from "../runtime/evidence-research-runtime.js";
import { TopicDiscoveryProvider } from "../runtime/topic-discovery-runtime.js";
import { SemanticDiscoveryRuntime } from "../runtime/semantic-discovery-runtime.js";
import { DownsideRiskRanker } from "../core/downside-risk-ranker.js";
import { PredictionPerformanceTracker } from "../core/prediction-tracker.js";
import { DynamicFeeService } from "../core/dynamic-fee-service.js";
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

function finiteOr(value, fallback = -Infinity) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function confidenceRank(value) {
  switch (String(value ?? "").toLowerCase()) {
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
    default:
      return 0;
  }
}

function compareOpportunityAnalysis(left, right) {
  const leftOpen = left?.action === "open" ? 1 : 0;
  const rightOpen = right?.action === "open" ? 1 : 0;
  if (leftOpen !== rightOpen) return rightOpen - leftOpen;

  const leftConfidence = confidenceRank(left?.confidence);
  const rightConfidence = confidenceRank(right?.confidence);
  if (leftConfidence !== rightConfidence) return rightConfidence - leftConfidence;

  const metrics = [
    ["monthlyReturn"],
    ["netEdge"],
    ["quarterKellyPct"],
    ["expectedValue", "expected_value"],
    ["aiProbability", "ai_probability"],
    ["marketProbability", "market_implied_probability"]
  ];
  for (const keys of metrics) {
    const leftValue = keys.map((key) => finiteOr(left?.[key], null)).find((value) => value != null) ?? -Infinity;
    const rightValue = keys.map((key) => finiteOr(right?.[key], null)).find((value) => value != null) ?? -Infinity;
    if (leftValue !== rightValue) return rightValue - leftValue;
  }
  return 0;
}

export function rankPredictionsForExecution({ predictions, portfolio, amountUsd, decisionEngine, dynamicFeeParamsMap = null }) {
  return predictions
    .map((prediction, index) => ({
      prediction,
      index,
      analysis: decisionEngine.analyze({
        market: prediction.market,
        estimate: prediction.estimate,
        portfolio,
        amountUsd,
        dynamicFeeParams: dynamicFeeParamsMap?.get(prediction.market.marketId) ?? null
      })
    }))
    .sort((left, right) => compareOpportunityAnalysis(left.analysis, right.analysis) || left.index - right.index);
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

function blockedOrder({ reason }) {
  return {
    orderId: "blocked-before-order",
    status: "blocked",
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

function triageKeyValues(market) {
  return [
    market.marketId,
    market.marketSlug
  ].filter(Boolean).map((value) => String(value).trim().toLowerCase());
}

function triageMap(triage) {
  const lookup = new Map();
  for (const assessment of triage?.candidate_assessments ?? []) {
    for (const key of [assessment.marketId, assessment.marketSlug].filter(Boolean)) {
      lookup.set(String(key).trim().toLowerCase(), assessment);
    }
  }
  return lookup;
}

function findTriageAssessment(lookup, market) {
  for (const key of triageKeyValues(market)) {
    if (lookup.has(key)) {
      return lookup.get(key);
    }
  }
  return null;
}

function triageShouldReject(assessment, config) {
  return Boolean(config.pulse?.aiTriageCanReject) && assessment?.recommended_action === "reject";
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
    const probabilityConfig = config.executionMode === "paper"
      ? { ...config, suppressProviderRuntimeArtifacts: true }
      : config;
    this.probabilityEstimator = new ProbabilityEstimator(probabilityConfig);
    this.calibrationLayer = new ProbabilityCalibrationLayer(config);
    this.candidateTriageProvider = config.pulse?.aiCandidateTriage
      ? new CandidateTriageProvider(probabilityConfig)
      : null;
    this.preScreenProvider = config.pulse?.aiPrescreen !== false
      ? new PreScreenProvider(probabilityConfig)
      : null;
    this.evidenceGapRuntime = new EvidenceGapRuntime(config);
    this.evidenceResearchProvider = config.pulse?.aiEvidenceResearch !== false
      ? new EvidenceResearchProvider(probabilityConfig)
      : null;
    this.topicDiscoveryProvider = config.pulse?.aiTopicDiscovery !== false
      ? new TopicDiscoveryProvider(probabilityConfig)
      : null;
    this.semanticDiscovery = new SemanticDiscoveryRuntime(config);
    this.dynamicCalibration = new DynamicCalibrationStore(config);
    this.returnAttribution = new ReturnAttributionEngine(config);
    this.downsideRiskRanker = new DownsideRiskRanker(config);
    this.predictionTracker = new PredictionPerformanceTracker(config);
    this.decisionEngine = new DecisionEngine(config);
    this.riskEngine = new RiskEngine(config, { stateStore });
    this.dynamicFeeService = new DynamicFeeService(config);
    this.liveBroker = new LiveBroker({ ...config, dynamicFeeService: this.dynamicFeeService });
    this.orderExecutor = new OrderExecutor({
      liveBroker: this.liveBroker
    });
    this.simulatedLedger = config.executionMode === "paper"
      ? new SimulatedMonitorLedger(config)
      : null;
    this._ledgerInitialized = false;
    this._monitorRoundCount = 0;
  }

  async _ensureLedgerCash() {
    if (!this.simulatedLedger || this._ledgerInitialized) return;
    try {
      const balance = await this.liveBroker.getBalance();
      const cashUsd = Number(balance.collateralBalance) || 0;
      this.simulatedLedger.initialCashUsd = Number(cashUsd.toFixed(4));
      this.simulatedLedger.cashUsd = this.simulatedLedger.initialCashUsd;
      this.simulatedLedger.highWaterMarkUsd = this.simulatedLedger.initialCashUsd;
      if (this.liveBroker.client?.setBalance) {
        this.liveBroker.client.setBalance(cashUsd);
      }
    } catch {
      // balance fetch failed — ledger starts with 0
    }
    this._ledgerInitialized = true;
  }

  _positionReviewInterval(position) {
    const endDate = position.endDate;
    if (!endDate) return 1;
    const msLeft = new Date(endDate).getTime() - Date.now();
    const daysLeft = Math.max(0, msLeft / 86_400_000);
    if (daysLeft <= 3) return 1;
    if (daysLeft <= 7) return 3;
    if (daysLeft <= 30) return 6;
    if (daysLeft <= 60) return 12;
    return 24;
  }

  async runOnce({ confirmation = null, marketId = null, side = "yes", amountUsd = 1 } = {}) {
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
    const dynamicFeeParams = await this.dynamicFeeService.fetchDynamicFeeParams(market.marketId);
    const decision = this.decisionEngine.decide({ market, estimate, side, amountUsd, portfolio, dynamicFeeParams });
    const orderBook = await this.marketSource.getOrderBook?.(decision.tokenId) ?? null;
    const risk = await this.riskEngine.evaluate({ decision, market, portfolio, confirmation, evidence: evidenceBundle, estimate, orderBook });
    const orderResult = await this.orderExecutor.execute({ risk, market, confirmation });

    const artifacts = [
      await this.artifactWriter.writeJson("evidence", runId, evidenceBundle),
      await this.artifactWriter.writeJson("prediction", runId, estimate),
      await this.artifactWriter.writeJson("decision", runId, decision),
      await this.artifactWriter.writeJson("risk", runId, risk)
    ];
    artifacts.push(await this.artifactWriter.writeJson("execution", runId, orderResult));
    await this.stateStore.updateRunStage(run.runId, "completed", { status: "completed" });
    return { ok: true, runId, market, decision, risk, orderResult, artifacts };
  }

  async predictCandidate(candidate) {
    const market = candidate.market;
    const evidence = await this.evidenceCrawler.collect({ market });
    const additionalEvidence = await this.runEvidenceResearch({ market, evidence, candidate });
    const allEvidence = [...evidence, ...additionalEvidence];
    const estimate = await this.probabilityEstimator.estimate({ market, evidence: allEvidence });
    const calibration = this.applyCalibration({ estimate, market, evidence: allEvidence, candidate });
    return { market, evidence: allEvidence, estimate: { ...estimate, calibration }, calibration };
  }

  async predictCandidateNoCache(candidate) {
    const market = candidate.market;
    const evidence = await this.evidenceCrawler.collect({ market, noCache: true });
    const additionalEvidence = await this.runEvidenceResearch({ market, evidence, candidate });
    const allEvidence = [...evidence, ...additionalEvidence];
    const estimate = await this.probabilityEstimator.estimate({ market, evidence: allEvidence });
    const calibration = this.applyCalibration({ estimate, market, evidence: allEvidence, candidate });
    return { market, evidence: allEvidence, estimate: { ...estimate, calibration }, calibration };
  }

  async runEvidenceResearch({ market, evidence, candidate }) {
    if (!this.evidenceResearchProvider) {
      return await this.fillEvidenceGaps({ market, evidence, candidate });
    }
    try {
      const triage = candidate?.summary?.ai_triage ?? null;
      const researchResult = await this.evidenceResearchProvider.research({ market, evidence, triage });
      if (!researchResult || !researchResult.directed_searches || researchResult.directed_searches.length === 0) {
        return await this.fillEvidenceGaps({ market, evidence, candidate });
      }
      const searchQueries = researchResult.directed_searches
        .sort((a, b) => a.priority - b.priority)
        .map((s) => s.query);
      return await this.evidenceGapRuntime.fillGaps({ market, evidenceGaps: searchQueries, priorEvidence: evidence });
    } catch {
      return await this.fillEvidenceGaps({ market, evidence, candidate });
    }
  }

  async fillEvidenceGaps({ market, evidence, candidate }) {
    const triage = candidate?.summary?.ai_triage;
    const evidenceGaps = triage?.evidence_gaps ?? [];
    if (evidenceGaps.length === 0) return [];
    try {
      return await this.evidenceGapRuntime.fillGaps({ market, evidenceGaps, priorEvidence: evidence });
    } catch {
      return [];
    }
  }

  applyCalibration({ estimate, market, evidence, candidate }) {
    const triage = candidate?.summary?.ai_triage ?? null;
    const prescreen = candidate?.summary?.ai_prescreen ?? null;
    return this.calibrationLayer.calibrate({
      rawProbability: estimate.ai_probability ?? estimate.aiProbability ?? 0.5,
      confidence: estimate.confidence,
      market,
      evidence,
      triageAssessment: triage,
      prescreenResult: prescreen
    });
  }

  async applyCandidateTriage({ candidateEntries, accumulator, ledger = null }) {
    if (!this.candidateTriageProvider) {
      return candidateEntries;
    }
    const selected = candidateEntries.filter((item) => item.summary.selected);
    if (selected.length === 0) {
      return candidateEntries;
    }

    try {
      const triage = await this.candidateTriageProvider.triage({
        candidates: selected.map((item) => item.market),
        context: {
          strategy: this.config.pulse?.strategy,
          maxCandidates: this.config.pulse?.maxCandidates,
          maxTradesPerRound: this.config.monitor?.maxTradesPerRound,
          minLiquidityUsd: this.config.pulse?.minLiquidityUsd,
          source: accumulator.scan?.source
        }
      });
      accumulator.candidateTriage = triage;
      const lookup = triageMap(triage);

      for (const entry of candidateEntries) {
        if (!entry.summary.selected) {
          continue;
        }
        const assessment = findTriageAssessment(lookup, entry.market);
        if (!assessment) {
          entry.summary.ai_triage = {
            status: "missing_assessment"
          };
          continue;
        }
        entry.summary.ai_triage = {
          recommended_action: assessment.recommended_action,
          priority_score: assessment.priority_score,
          researchability: assessment.researchability,
          information_advantage: assessment.information_advantage,
          cluster: assessment.cluster,
          rationale: assessment.rationale,
          evidence_gaps: assessment.evidence_gaps
        };
        if (triageShouldReject(assessment, this.config)) {
          entry.summary.selected = false;
          entry.summary.skipped_reasons.push("ai_triage_reject");
        }
        if (ledger) {
          await ledger.log("candidate.triage", {
            market: entry.market.marketSlug,
            action: assessment.recommended_action,
            score: assessment.priority_score,
            researchability: assessment.researchability,
            information_advantage: assessment.information_advantage,
            cluster: JSON.stringify(assessment.cluster),
            gaps: assessment.evidence_gaps.join(",") || "none"
          });
        }
      }

      if (ledger) {
        await ledger.log("candidate.triage_summary", {
          assessments: triage.candidate_assessments.length,
          clusters: (triage.clusters ?? []).length,
          research_gaps: (triage.research_gaps ?? []).join(",") || "none"
        });
      }
      return candidateEntries;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      accumulator.errors.push(`candidate_triage_failed:${message}`);
      if (ledger) {
        await ledger.log("candidate.triage_failed", { error: JSON.stringify(message) });
      }
      return candidateEntries;
    }
  }

  async applyPreScreen({ candidateEntries, accumulator, ledger = null }) {
    if (!this.preScreenProvider) {
      return candidateEntries;
    }
    const selected = candidateEntries.filter((item) => item.summary.selected);
    if (selected.length === 0) {
      return candidateEntries;
    }

    const summary = await this.preScreenProvider.preScreen({
      candidates: selected.map((item) => item.market)
    });
    accumulator.preScreen = summary;

    if (summary.failed) {
      accumulator.errors.push(`prescreen_failed:${summary.failureReason ?? "unknown"}`);
      if (ledger) {
        await ledger.log("candidate.prescreen_failed", { error: JSON.stringify(summary.failureReason ?? "unknown") });
      }
      return candidateEntries;
    }

    const resultMap = new Map();
    for (const result of summary.results) {
      resultMap.set((result.marketSlug ?? "").toLowerCase(), result);
    }

    for (const entry of candidateEntries) {
      if (!entry.summary.selected) continue;
      const key = (entry.market.marketSlug ?? "").toLowerCase();
      const result = resultMap.get(key);
      if (!result) continue;
      entry.summary.ai_prescreen = { suitable: result.suitable, reason: result.reason };
      if (!result.suitable) {
        entry.summary.selected = false;
        entry.summary.skipped_reasons.push("ai_prescreen_skip");
      }
      if (ledger) {
        await ledger.log("candidate.prescreen", {
          market: entry.market.marketSlug,
          action: result.suitable ? "TRADE" : "SKIP",
          reason: result.reason || "none"
        });
      }
    }

    if (ledger) {
      await ledger.log("candidate.prescreen_summary", {
        total: summary.results.length,
        trade: summary.tradeCount,
        skip: summary.skipCount,
        elapsed_ms: summary.elapsedMs
      });
    }
    return candidateEntries;
  }

  async applyTopicDiscovery({ accumulator, ledger = null }) {
    if (!this.topicDiscoveryProvider) return;
    try {
      const markets = accumulator.scan?.markets ?? [];
      const categories = [...new Set(markets.map((m) => m.category).filter(Boolean))];
      const discovery = await this.topicDiscoveryProvider.discover({
        currentCategories: categories,
        currentMarketCount: markets.length,
        recentTopics: []
      });
      accumulator.topicDiscovery = discovery;
      if (discovery.failed) {
        accumulator.errors.push(`topic_discovery_failed:${discovery.failureReason ?? "unknown"}`);
        if (ledger) {
          await ledger.log("topic_discovery.failed", { error: discovery.failureReason ?? "unknown" });
        }
        return;
      }
      if (discovery.discovered_topics.length > 0) {
        if (ledger) {
          await ledger.log("topic_discovery.completed", {
            topics_found: discovery.discovered_topics.length,
            categories: [...new Set(discovery.discovered_topics.map((t) => t.category))].join(","),
            topics: discovery.discovered_topics.map((t) => t.topic).join("; ").slice(0, 500)
          });
        }
        // Semantic discovery: match discovered topics against full market list
        const existingIds = new Set(markets.map((m) => m.marketId));
        const semanticResult = this.semanticDiscovery.discover({
          discoveredTopics: discovery.discovered_topics,
          allMarkets: markets,
          existingCandidateIds: existingIds
        });
        accumulator.semanticDiscovery = semanticResult;
        if (semanticResult.matchedMarkets.length > 0 && ledger) {
          await ledger.log("semantic_discovery.completed", {
            matched: semanticResult.matchedMarkets.length,
            clusters: semanticResult.clusters.length,
            duplicates: semanticResult.duplicates.length,
            topics: semanticResult.topicMatches.map((t) => `${t.topic}(${t.matchedCount})`).join("; ").slice(0, 500)
          });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      accumulator.errors.push(`topic_discovery_error:${message}`);
      if (ledger) {
        await ledger.log("topic_discovery.error", { error: message });
      }
    }
  }

  async getLiveBalanceContext({ confirmation }) {
    if (confirmation !== "LIVE") {
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

  async evaluateAndMaybeOrder({ prediction, confirmation, maxAmountUsd, runId, orderCount, filledUsdThisRun, liveBalance, liveBalanceError }) {
    const portfolio = await this.stateStore.getPortfolio();
    const dynamicFeeParams = await this.dynamicFeeService.fetchDynamicFeeParams(prediction.market.marketId);
    const analysis = this.decisionEngine.analyze({
      market: prediction.market,
      estimate: prediction.estimate,
      portfolio,
      amountUsd: maxAmountUsd,
      dynamicFeeParams
    });
    const chosenSide = analysis.suggested_side ?? "yes";
    const decision = this.decisionEngine.decide({
      market: prediction.market,
      estimate: prediction.estimate,
      side: chosenSide,
      amountUsd: maxAmountUsd,
      portfolio,
      dynamicFeeParams
    });

    if (orderCount >= this.config.monitor.maxTradesPerRound) {
      const risk = blockedRisk("monitor_round_trade_limit_reached");
      return { decision, risk, order: blockedOrder({ reason: "monitor_round_trade_limit_reached" }) };
    }

    const monitorState = await this.stateStore.getMonitorState();
    const maxDaily = this.config.monitor.maxDailyTradeUsd;
    const dailyUsed = asNumber(monitorState.dailyTradeUsd?.amountUsd);
    const remainingDaily = Math.max(0, maxDaily - dailyUsed - filledUsdThisRun);
    if (remainingDaily < this.config.risk.minTradeUsd) {
      const risk = blockedRisk("monitor_daily_trade_limit_reached");
      return { decision, risk, order: blockedOrder({ reason: "monitor_daily_trade_limit_reached" }) };
    }

    const amountUsd = Math.min(maxAmountUsd, remainingDaily);
    const boundedDecision = this.decisionEngine.decide({
      market: prediction.market,
      estimate: prediction.estimate,
      side: chosenSide,
      amountUsd,
      portfolio,
      dynamicFeeParams
    });
    const orderBook = await this.marketSource.getOrderBook?.(boundedDecision.tokenId) ?? null;
    const risk = await this.riskEngine.evaluate({
      decision: boundedDecision,
      market: prediction.market,
      portfolio,
      confirmation,
      evidence: prediction.evidence,
      estimate: prediction.estimate,
      liveBalance,
      liveBalanceError,
      orderBook
    });
    const order = await this.orderExecutor.execute({ risk, market: prediction.market, confirmation });
    if (order.status === "filled" && order.filledUsd > 0) {
      await this.stateStore.recordMonitorTrade({ market: prediction.market, orderResult: order, runId });
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
        requestedUsd: 0,
        filledUsd: closed.proceedsUsd,
        avgPrice: closed.currentPrice,
        reason: closed.closeReason,
        paper: true,
        type: "close"
      });
      this.predictionTracker.recordOutcome({
        marketId: closed.marketId,
        marketSlug: closed.marketSlug,
        outcome: closed.realizedPnlUsd > 0,
        realizedPnlUsd: closed.realizedPnlUsd,
        returnPct: closed.returnPct ?? 0,
        closeReason: closed.closeReason
      });
    }

    if (this.config.monitor?.holdUntilSettlement) {
      for (const position of [...ledger.positions]) {
        await ledger.log("position.review_skipped", {
          market: position.marketSlug,
          reason: "hold_until_settlement"
        });
      }
    } else {
      for (const position of [...ledger.positions]) {
        const reviewInterval = this._positionReviewInterval(position);
        if (this._monitorRoundCount % reviewInterval !== 0) {
          await ledger.log("position.review_deferred", {
            market: position.marketSlug,
            round: this._monitorRoundCount,
            interval: reviewInterval,
            next_review_round: Math.ceil(this._monitorRoundCount / reviewInterval) * reviewInterval
          });
          continue;
        }
        const market = await this.marketSource.getMarket(position.marketId || position.marketSlug, { noCache: true });
        if (!market) {
          await ledger.log("position.review_skipped", { market: position.marketSlug, reason: "market_not_found" });
          continue;
        }
        const prediction = await this.predictCandidateNoCache({ market });
        const portfolio = ledger.portfolio();
        const dynamicFeeParamsReview = await this.dynamicFeeService.fetchDynamicFeeParams(prediction.market.marketId);
        const analysis = this.decisionEngine.analyze({
          market: prediction.market,
          estimate: prediction.estimate,
          portfolio,
          amountUsd: this.config.risk.minTradeUsd,
          dynamicFeeParams: dynamicFeeParamsReview
        });
        const chosenSide = analysis.suggested_side ?? position.side ?? "yes";
        const decision = this.decisionEngine.decide({
          market: prediction.market,
          estimate: prediction.estimate,
          side: chosenSide,
          amountUsd: this.config.risk.minTradeUsd,
          portfolio,
          dynamicFeeParams: dynamicFeeParamsReview
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
            requestedUsd: 0,
            filledUsd: closed.proceedsUsd,
            avgPrice: closed.currentPrice,
            reason: closed.closeReason,
            paper: true,
            type: "close"
          });
          this.predictionTracker.recordOutcome({
            marketId: closed.marketId,
            marketSlug: closed.marketSlug,
            outcome: closed.realizedPnlUsd > 0,
            realizedPnlUsd: closed.realizedPnlUsd,
            returnPct: closed.returnPct ?? 0,
            closeReason: closed.closeReason
          });
        }
      }
    }
    await ledger.log("positions.reviewed", {
      run_id: runId,
      open_positions: ledger.positions.length,
      closed_positions: ledger.closedTrades.length
    });
  }

  async evaluateAndMaybeSimulatedOrder({ prediction, confirmation, maxAmountUsd, runId, orderCount, filledUsdThisRun, side = null }) {
    const ledger = this.simulatedLedger;
    const portfolio = ledger.portfolio();
    const dynamicFeeParams = await this.dynamicFeeService.fetchDynamicFeeParams(prediction.market.marketId);
    const analysis = this.decisionEngine.analyze({
      market: prediction.market,
      estimate: prediction.estimate,
      portfolio,
      amountUsd: maxAmountUsd,
      dynamicFeeParams
    });
    const chosenSide = side ?? analysis.suggested_side ?? "yes";
    const decision = this.decisionEngine.decide({
      market: prediction.market,
      estimate: prediction.estimate,
      side: chosenSide,
      amountUsd: maxAmountUsd,
      portfolio,
      dynamicFeeParams
    });

    if (orderCount >= this.config.monitor.maxTradesPerRound) {
      const risk = blockedRisk("monitor_round_trade_limit_reached");
      await ledger.logPrediction({ market: prediction.market, estimate: prediction.estimate, decision, phase: "open-scan" });
      await ledger.logRisk({ market: prediction.market, risk });
      return { decision, risk, order: blockedOrder({ reason: "monitor_round_trade_limit_reached" }) };
    }

    const maxDaily = this.config.monitor.maxDailyTradeUsd;
    const dailyUsed = asNumber(ledger.dailyTradeUsd?.amountUsd);
    const remainingDaily = Math.max(0, maxDaily - dailyUsed - filledUsdThisRun);
    if (remainingDaily < this.config.risk.minTradeUsd) {
      const risk = blockedRisk("monitor_daily_trade_limit_reached");
      await ledger.logPrediction({ market: prediction.market, estimate: prediction.estimate, decision, phase: "open-scan" });
      await ledger.logRisk({ market: prediction.market, risk });
      return { decision, risk, order: blockedOrder({ reason: "monitor_daily_trade_limit_reached" }) };
    }

    const amountUsd = Math.min(maxAmountUsd, remainingDaily);
    const boundedDecision = this.decisionEngine.decide({
      market: prediction.market,
      estimate: prediction.estimate,
      side: chosenSide,
      amountUsd,
      portfolio,
      dynamicFeeParams
    });
    const orderBook = await this.marketSource.getOrderBook?.(boundedDecision.tokenId) ?? null;
    const risk = await new RiskEngine(this.config).evaluate({
      decision: boundedDecision,
      market: prediction.market,
      portfolio,
      confirmation,
      evidence: prediction.evidence,
      estimate: prediction.estimate,
      systemState: ledger.riskState(),
      liveBalance: ledger.liveBalance(),
      liveBalanceError: null,
      orderBook
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

  async runSimulatedTradeOnce({ confirmation = null, marketId, side = null, maxAmountUsd = 1 } = {}) {
    if (!this.simulatedLedger) {
      throw new Error("paper_ledger_unavailable");
    }
    await this._ensureLedgerCash();
    const runId = monitorRunId();
    const startedAt = nowIso();
    const ledger = this.simulatedLedger;
    const accumulator = {
      runId,
      startedAt,
      completedAt: null,
      scan: { source: this.config.marketSource, fetchedAt: startedAt, markets: [], errors: [] },
      candidates: [],
      predictions: [],
      decisions: [],
      risks: [],
      orders: [],
      errors: [],
      candidateTriage: null,
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
          confirmation,
          maxAmountUsd: maxAmountUsd ?? (this.config.monitor.maxAmountUsd || this.config.risk.minTradeUsd),
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

  async runAcceptanceRound({ confirmation = null, limit = null, maxAmountUsd = null, marketId = null } = {}) {
    await this._ensureLedgerCash();

    const runId = monitorRunId();
    const startedAt = nowIso();
    const amountUsd = maxAmountUsd ?? (this.config.monitor.maxAmountUsd || this.config.risk.minTradeUsd);
    const ledger = this.simulatedLedger;
    const simulated = Boolean(ledger);
    const accumulator = {
      runId,
      startedAt,
      completedAt: null,
      scan: { source: this.config.marketSource, fetchedAt: startedAt, markets: [], errors: [] },
      candidates: [],
      predictions: [],
      decisions: [],
      risks: [],
      orders: [],
      errors: [],
      candidateTriage: null,
      preScreen: null,
      topicDiscovery: null,
      semanticDiscovery: null,
      recoveredRun: null
    };
    const stages = {
      scan: null,
      discovery: null,
      evidence: null,
      prediction: null,
      risk: null,
      execution: null
    };

    if (simulated) {
      await ledger.beginRound({ runId, limit: marketId ? 1 : limit, maxAmountUsd: amountUsd });
    } else {
      accumulator.recoveredRun = await this.stateStore.recoverMonitorRun();
      const monitorState = await this.stateStore.getMonitorState();
      if (monitorState.status === "stopped") {
        return {
          ok: true,
          status: "stopped",
          runId,
          reason: monitorState.stopReason ?? "monitor_stopped",
          stages,
          artifact: null
        };
      }
      await this.stateStore.startMonitorRun({ runId });
    }

    const finishReal = async (status = "completed", error = null) => {
      accumulator.completedAt = nowIso();
      const artifacts = typeof this.artifactWriter.writeMonitorRun === "function"
        ? await this.artifactWriter.writeMonitorRun(accumulator)
        : null;
      if (!simulated) {
        await this.stateStore.completeMonitorRun(runId, {
          status,
          error,
          artifact: artifacts.summary.path,
          markets: accumulator.scan.markets?.length ?? 0,
          candidates: accumulator.candidates.filter((item) => item.selected).length,
          predictions: accumulator.predictions.length,
          orders: accumulator.orders.filter((order) => order.status === "filled").length
        });
      }
      return artifacts;
    };

    try {
      await withTimeout(async () => {
        if (marketId) {
          const market = await this.marketSource.getMarket(marketId, simulated ? { noCache: true } : {});
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
        } else {
          accumulator.scan = await this.marketSource.scan({
            ...(limit == null ? {} : { limit }),
            ...(simulated ? { noCache: true } : {})
          });
        }
        if (simulated) {
          await ledger.logScan(accumulator.scan);
          await this.reviewSimulatedPositions({ runId, accumulator });
        }

        stages.scan = {
          ok: true,
          source: accumulator.scan.source,
          totalFetched: accumulator.scan.totalFetched,
          totalReturned: accumulator.scan.totalReturned,
          riskFlags: accumulator.scan.riskFlags ?? [],
          pulse: accumulator.scan.pulse ?? null,
          markets: accumulator.scan.markets ?? []
        };

        const monitorState = simulated ? ledger.monitorState() : await this.stateStore.getMonitorState();
        const portfolio = simulated ? ledger.portfolio() : await this.stateStore.getPortfolio();
        const candidateEntries = buildCandidates({
          markets: accumulator.scan.markets ?? [],
          monitorState,
          portfolio,
          config: this.config
        });
        await this.applyPreScreen({ candidateEntries, accumulator, ledger: simulated ? ledger : null });
        await this.applyCandidateTriage({ candidateEntries, accumulator, ledger: simulated ? ledger : null });
        accumulator.candidates = candidateEntries.map((item) => item.summary);
        if (simulated) {
          for (const candidate of accumulator.candidates) {
            await ledger.log("candidate", {
              market: candidate.marketSlug,
              selected: candidate.selected,
              reasons: (candidate.skipped_reasons ?? []).join(",") || "none"
            });
          }
        }
        const selected = candidateEntries.filter((item) => item.summary.selected);
        if (selected.length === 0) {
          throw new Error("acceptance_no_selected_monitor_candidates");
        }
        stages.discovery = {
          ok: true,
          liveMonitorAligned: true,
          topicDiscovery: accumulator.topicDiscovery ?? null,
          semanticDiscovery: accumulator.semanticDiscovery ?? null,
          preScreen: accumulator.preScreen ?? null,
          candidateTriage: accumulator.candidateTriage ?? null,
          candidates: accumulator.candidates,
          selectedCandidates: selected.map((item) => item.summary)
        };

        const predictions = await mapLimit(
          selected,
          this.config.monitor.concurrency,
          this.config.monitor.backoffMs,
          async (candidate) => {
            try {
              return simulated
                ? await this.predictCandidateNoCache(candidate)
                : await this.predictCandidate(candidate);
            } catch (error) {
              accumulator.errors.push(`prediction_failed:${candidate.market.marketId}:${error instanceof Error ? error.message : String(error)}`);
              return null;
            }
          }
        );
        accumulator.predictions = predictions.filter(Boolean);
        if (accumulator.predictions.length === 0) {
          throw new Error(`acceptance_no_predictions:${accumulator.errors.join(";") || "unknown"}`);
        }
        stages.evidence = {
          ok: true,
          predictions: accumulator.predictions.map((prediction) => ({
            marketId: prediction.market.marketId,
            marketSlug: prediction.market.marketSlug,
            question: prediction.market.question,
            evidenceCount: prediction.evidence?.length ?? 0,
            sources: [...new Set((prediction.evidence ?? []).map((item) => item.source))],
            evidence: prediction.evidence
          }))
        };

        const portfolioForRanking = simulated ? ledger.portfolio() : await this.stateStore.getPortfolio();
        const dynamicFeeParamsMap = new Map();
        for (const prediction of accumulator.predictions) {
          const params = await this.dynamicFeeService.fetchDynamicFeeParams(prediction.market.marketId);
          if (params) dynamicFeeParamsMap.set(prediction.market.marketId, params);
        }
        const baseRanked = rankPredictionsForExecution({
          predictions: accumulator.predictions,
          portfolio: portfolioForRanking,
          amountUsd,
          decisionEngine: this.decisionEngine,
          dynamicFeeParamsMap
        });
        const rankedPredictions = simulated
          ? this.downsideRiskRanker.rankWithDownsideRisk({
            rankedPredictions: baseRanked,
            portfolio: ledger.portfolio(),
            ledgerStatistics: ledger.statistics()
          })
          : baseRanked;
        if (simulated) {
          for (const [index, ranked] of rankedPredictions.entries()) {
            await ledger.log("candidate.ranked", {
              rank: index + 1,
              market: ranked.prediction.market.marketSlug,
              action: ranked.analysis.action,
              confidence: ranked.analysis.confidence,
              monthly_return: ranked.analysis.monthlyReturn ?? "n/a",
              net_edge: ranked.analysis.netEdge ?? "n/a",
              risk_adjusted_score: ranked.riskAdjusted?.riskAdjustedScore ?? "n/a",
              downside_score: ranked.downsideRisk?.score ?? "n/a",
              reason: ranked.analysis.noTradeReason ?? "none"
            });
            this.predictionTracker.recordPrediction({
              marketId: ranked.prediction.market.marketId,
              marketSlug: ranked.prediction.market.marketSlug,
              category: ranked.prediction.market.category,
              aiProbability: ranked.analysis.aiProbability,
              marketProbability: ranked.analysis.marketProbability ?? ranked.analysis.marketImpliedProbability,
              confidence: ranked.analysis.confidence,
              netEdge: ranked.analysis.netEdge,
              monthlyReturn: ranked.analysis.monthlyReturn,
              quarterKellyPct: ranked.analysis.quarterKellyPct,
              side: ranked.analysis.suggestedSide,
              notionalUsd: ranked.analysis.suggestedNotionalUsd,
              roundId: runId
            });
          }
        }
        stages.prediction = {
          ok: true,
          ranked: rankedPredictions.map((ranked, index) => ({
            rank: index + 1,
            marketId: ranked.prediction.market.marketId,
            marketSlug: ranked.prediction.market.marketSlug,
            question: ranked.prediction.market.question,
            provider: ranked.prediction.estimate?.diagnostics?.provider ?? null,
            effectiveProvider: ranked.prediction.estimate?.diagnostics?.effectiveProvider ?? null,
            providerRuntimeArtifact: ranked.prediction.estimate?.diagnostics?.artifact ?? null,
            ai_probability: ranked.prediction.estimate?.ai_probability ?? null,
            confidence: ranked.prediction.estimate?.confidence ?? null,
            reasoning_summary: ranked.prediction.estimate?.reasoning_summary ?? null,
            key_evidence: ranked.prediction.estimate?.key_evidence ?? [],
            counter_evidence: ranked.prediction.estimate?.counter_evidence ?? [],
            uncertainty_factors: ranked.prediction.estimate?.uncertainty_factors ?? [],
            analysis: ranked.analysis,
            riskAdjusted: ranked.riskAdjusted ?? null,
            downsideRisk: ranked.downsideRisk ?? null
          }))
        };

        if (simulated) {
          let orderCount = 0;
          let filledUsdThisRun = 0;
          for (const { prediction } of rankedPredictions) {
            const result = await this.evaluateAndMaybeSimulatedOrder({
              prediction,
              confirmation,
              maxAmountUsd: amountUsd,
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
        } else {
          const { liveBalance, liveBalanceError } = await this.getLiveBalanceContext({ confirmation });
          let orderCount = 0;
          let filledUsdThisRun = 0;
          for (const { prediction } of rankedPredictions) {
            const result = await this.evaluateAndMaybeOrder({
              prediction,
              confirmation,
              maxAmountUsd: amountUsd,
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
        }
        stages.risk = {
          ok: true,
          risks: accumulator.risks
        };
      }, this.config.monitor.runTimeoutMs, "acceptance_monitor_round");

      accumulator.completedAt = nowIso();
      if (simulated) {
        await ledger.endRound({ runId, status: "completed", errors: accumulator.errors });
      }
      const artifacts = await finishReal("completed");
      stages.execution = {
        ok: true,
        orders: accumulator.orders,
        filledOrders: accumulator.orders.filter((order) => order.status === "filled"),
        action: accumulator.orders.some((order) => order.status === "filled")
          ? (simulated ? "simulated-orders" : "live-orders")
          : "no-trade",
        log: simulated ? ledger.logPath : null,
        artifact: simulated ? ledger.logPath : artifacts?.summary?.path ?? null,
        performance: simulated ? ledger.statistics() : null
      };
      return {
        ok: true,
        status: "completed",
        runId,
        executionMode: this.config.executionMode,
        markets: accumulator.scan.markets?.length ?? 0,
        candidates: accumulator.candidates.filter((item) => item.selected).length,
        predictions: accumulator.predictions.length,
        orders: accumulator.orders.filter((order) => order.status === "filled").length,
        action: stages.execution.action,
        artifact: stages.execution.artifact,
        log: stages.execution.log,
        stages,
        accumulator
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      accumulator.errors.push(message);
      accumulator.completedAt = nowIso();
      if (simulated) {
        await ledger.endRound({ runId, status: "failed", errors: accumulator.errors });
      }
      const artifacts = await finishReal("failed", message);
      stages.execution = stages.execution ?? {
        ok: false,
        orders: accumulator.orders,
        action: "no-trade",
        log: simulated ? ledger.logPath : null,
        artifact: simulated ? ledger.logPath : artifacts?.summary?.path ?? null,
        performance: simulated ? ledger.statistics() : null,
        error: message
      };
      return {
        ok: false,
        status: "failed",
        runId,
        executionMode: this.config.executionMode,
        error: message,
        action: "no-trade",
        artifact: stages.execution.artifact,
        log: stages.execution.log,
        stages,
        accumulator
      };
    }
  }

  async runSimulatedMonitorRound({ confirmation = null, limit = null, maxAmountUsd = null } = {}) {
    await this._ensureLedgerCash();
    this._monitorRoundCount += 1;
    const runId = monitorRunId();
    const startedAt = nowIso();
    const ledger = this.simulatedLedger;
    const accumulator = {
      runId,
      startedAt,
      completedAt: null,
      scan: { source: this.config.marketSource, fetchedAt: startedAt, markets: [], errors: [] },
      candidates: [],
      predictions: [],
      decisions: [],
      risks: [],
      orders: [],
      errors: [],
      candidateTriage: null,
      recoveredRun: null
    };

    await ledger.beginRound({ runId, limit, maxAmountUsd });

    try {
      await withTimeout(async () => {
        accumulator.scan = await this.marketSource.scan({
          ...(limit == null ? {} : { limit }),
          noCache: true
        });
        await ledger.logScan(accumulator.scan);
        await this.applyTopicDiscovery({ accumulator, ledger });
        await this.reviewSimulatedPositions({ runId, accumulator });
        const candidateEntries = buildCandidates({
          markets: accumulator.scan.markets ?? [],
          monitorState: ledger.monitorState(),
          portfolio: ledger.portfolio(),
          config: this.config
        });
        await this.applyPreScreen({ candidateEntries, accumulator, ledger });
        await this.applyCandidateTriage({ candidateEntries, accumulator, ledger });
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
        const validPredictions = predictions.filter(Boolean);
        accumulator.predictions.push(...validPredictions);
        const dynamicFeeParamsMapSim = new Map();
        for (const prediction of validPredictions) {
          const params = await this.dynamicFeeService.fetchDynamicFeeParams(prediction.market.marketId);
          if (params) dynamicFeeParamsMapSim.set(prediction.market.marketId, params);
        }
        const baseRanked = rankPredictionsForExecution({
          predictions: validPredictions,
          portfolio: ledger.portfolio(),
          amountUsd: maxAmountUsd ?? (this.config.monitor.maxAmountUsd || this.config.risk.minTradeUsd),
          decisionEngine: this.decisionEngine,
          dynamicFeeParamsMap: dynamicFeeParamsMapSim
        });
        const rankedPredictions = this.downsideRiskRanker.rankWithDownsideRisk({
          rankedPredictions: baseRanked,
          portfolio: ledger.portfolio(),
          ledgerStatistics: ledger.statistics()
        });
        for (const [index, ranked] of rankedPredictions.entries()) {
          await ledger.log("candidate.ranked", {
            rank: index + 1,
            market: ranked.prediction.market.marketSlug,
            action: ranked.analysis.action,
            confidence: ranked.analysis.confidence,
            monthly_return: ranked.analysis.monthlyReturn ?? "n/a",
            net_edge: ranked.analysis.netEdge ?? "n/a",
            risk_adjusted_score: ranked.riskAdjusted?.riskAdjustedScore ?? "n/a",
            downside_score: ranked.downsideRisk?.score ?? "n/a",
            reason: ranked.analysis.noTradeReason ?? "none"
          });
          this.predictionTracker.recordPrediction({
            marketId: ranked.prediction.market.marketId,
            marketSlug: ranked.prediction.market.marketSlug,
            category: ranked.prediction.market.category,
            aiProbability: ranked.analysis.aiProbability,
            marketProbability: ranked.analysis.marketProbability ?? ranked.analysis.marketImpliedProbability,
            confidence: ranked.analysis.confidence,
            netEdge: ranked.analysis.netEdge,
            monthlyReturn: ranked.analysis.monthlyReturn,
            quarterKellyPct: ranked.analysis.quarterKellyPct,
            side: ranked.analysis.suggestedSide,
            notionalUsd: ranked.analysis.suggestedNotionalUsd,
            roundId: runId
          });
        }
        let orderCount = 0;
        let filledUsdThisRun = 0;
        for (const { prediction } of rankedPredictions) {
          const result = await this.evaluateAndMaybeSimulatedOrder({
            prediction,
            confirmation,
            maxAmountUsd: maxAmountUsd ?? (this.config.monitor.maxAmountUsd || this.config.risk.minTradeUsd),
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
      if (this.predictionTracker.shouldEmitReport()) {
        await this.predictionTracker.emitReport(ledger);
      }
      await ledger.endRound({ runId, status: "completed", errors: accumulator.errors });
      return {
        ok: true,
        status: "completed",
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
        runId,
        error: message,
        artifact: ledger.logPath,
        log: ledger.logPath,
        performance: ledger.statistics()
      };
    }
  }

  async runMonitorRound({ confirmation = null, limit = null, maxAmountUsd = null } = {}) {
    if (this.simulatedLedger) {
      return await this.runSimulatedMonitorRound({ confirmation, limit, maxAmountUsd });
    }
    const runId = monitorRunId();
    const startedAt = nowIso();
    const recoveredRun = await this.stateStore.recoverMonitorRun();
    const monitorState = await this.stateStore.getMonitorState();
    if (monitorState.status === "stopped") {
      return {
        ok: true,
        status: "stopped",
        reason: monitorState.stopReason ?? "monitor_stopped",
        artifact: null
      };
    }

    await this.stateStore.startMonitorRun({ runId });
    const accumulator = {
      runId,
      startedAt,
      completedAt: null,
      scan: { source: this.config.marketSource, fetchedAt: startedAt, markets: [], errors: [] },
      candidates: [],
      predictions: [],
      decisions: [],
      risks: [],
      orders: [],
      errors: [],
      candidateTriage: null,
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
        accumulator.scan = await this.marketSource.scan(limit == null ? {} : { limit });
        const candidateEntries = buildCandidates({
          markets: accumulator.scan.markets ?? [],
          monitorState: await this.stateStore.getMonitorState(),
          portfolio: await this.stateStore.getPortfolio(),
          config: this.config
        });
        await this.applyPreScreen({ candidateEntries, accumulator });
        await this.applyCandidateTriage({ candidateEntries, accumulator });
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
        const dynamicFeeParamsMapLive = new Map();
        for (const prediction of accumulator.predictions) {
          const params = await this.dynamicFeeService.fetchDynamicFeeParams(prediction.market.marketId);
          if (params) dynamicFeeParamsMapLive.set(prediction.market.marketId, params);
        }
        const rankedPredictions = rankPredictionsForExecution({
          predictions: accumulator.predictions,
          portfolio: await this.stateStore.getPortfolio(),
          amountUsd: maxAmountUsd ?? (this.config.monitor.maxAmountUsd || this.config.risk.minTradeUsd),
          decisionEngine: this.decisionEngine,
          dynamicFeeParamsMap: dynamicFeeParamsMapLive
        });
        const { liveBalance, liveBalanceError } = await this.getLiveBalanceContext({ confirmation });
        let orderCount = 0;
        let filledUsdThisRun = 0;
        for (const { prediction } of rankedPredictions) {
          const result = await this.evaluateAndMaybeOrder({
            prediction,
            confirmation,
            maxAmountUsd: maxAmountUsd ?? (this.config.monitor.maxAmountUsd || this.config.risk.minTradeUsd),
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
        runId,
        error: message,
        artifact: artifacts.summary.path
      };
    }
  }

  async monitorRun(options = {}) {
    return await this.runMonitorRound(options);
  }

  async monitorLoop({ confirmation = null, rounds = 1, limit = null, maxAmountUsd = null, onRound = null } = {}) {
    const results = [];
    let completed = 0;
    while (rounds == null || completed < rounds) {
      const state = this.simulatedLedger ? { status: "active" } : await this.stateStore.getMonitorState();
      if (!this.simulatedLedger && state.status === "stopped") {
        const result = { ok: true, status: "stopped", reason: state.stopReason ?? "monitor_stopped", artifact: null };
        results.push(result);
        if (onRound) await onRound(result);
        break;
      }
      const result = await this.monitorRun({ confirmation, limit, maxAmountUsd });
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
      rounds: results.length,
      last: results.at(-1) ?? null
    };
  }
}
