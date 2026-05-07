import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { redactSecrets } from "../config/env.js";
import { assertSchema } from "../domain/schemas.js";

function safeKind(kind) {
  return String(kind).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "artifact";
}

function safeTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function safeSlug(value) {
  return String(value ?? "market")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "market";
}

function marketSummary(scan) {
  const riskFlags = scan.riskFlags?.length ? scan.riskFlags.join(", ") : "none";
  const filters = scan.filters ? JSON.stringify(scan.filters, null, 2) : "{}";
  const pulse = scan.pulse ? JSON.stringify(scan.pulse, null, 2) : null;
  const rows = (scan.markets ?? []).slice(0, 20).map((market, index) => {
    const priceLine = market.outcomes
      .map((outcome) => `${outcome.label}:${outcome.impliedProbability ?? outcome.lastPrice ?? "n/a"}`)
      .join(" / ");
    return `${index + 1}. ${market.question} | ${market.marketSlug} | ${priceLine} | liq=${market.liquidityUsd} | vol24h=${market.volume24hUsd}`;
  });
  return [
    "# PolyPulse Market Scan",
    "",
    `- source: ${scan.source}`,
    `- fetched_at: ${scan.fetchedAt}`,
    `- from_cache: ${Boolean(scan.fromCache)}`,
    `- fallback: ${Boolean(scan.fallback)}`,
    `- total_fetched: ${scan.totalFetched}`,
    `- total_returned: ${scan.totalReturned}`,
    `- risk_flags: ${riskFlags}`,
    "",
    "## Filters",
    "",
    "```json",
    filters,
    "```",
    ...(pulse ? [
      "",
      "## Pulse Selection",
      "",
      "```json",
      pulse,
      "```"
    ] : []),
    "",
    "## Top Markets",
    "",
    ...(rows.length ? rows : ["No markets returned."]),
    ""
  ].join("\n");
}

function predictionDecisionMarkdown({ market, estimate, decision }) {
  const keyEvidence = (estimate.key_evidence ?? [])
    .map((item, index) => `${index + 1}. ${item.title} | ${item.source} | relevance=${item.relevanceScore}`)
    .join("\n") || "None.";
  const counterEvidence = (estimate.counter_evidence ?? [])
    .map((item, index) => `${index + 1}. ${item.title} | ${item.source} | status=${item.status}`)
    .join("\n") || "None.";
  const uncertainty = (estimate.uncertainty_factors ?? []).join(", ") || "none";
  return [
    "# PolyPulse Prediction Decision",
    "",
    `- market: ${market.marketSlug}`,
    `- question: ${market.question}`,
    `- ai_probability: ${estimate.ai_probability}`,
    `- confidence: ${estimate.confidence}`,
    `- freshness_score: ${estimate.freshness_score}`,
    `- suggested_side: ${decision.suggested_side ?? "none"}`,
    `- market_implied_probability: ${decision.market_implied_probability ?? "n/a"}`,
    `- edge: ${decision.edge ?? "n/a"}`,
    `- net_edge: ${decision.netEdge ?? "n/a"}`,
    `- entry_fee_pct: ${decision.entryFeePct ?? "n/a"}`,
    `- quarter_kelly_pct: ${decision.quarterKellyPct ?? "n/a"}`,
    `- monthly_return: ${decision.monthlyReturn ?? "n/a"}`,
    `- expected_value: ${decision.expected_value ?? "n/a"}`,
    `- suggested_notional_before_risk: ${decision.suggested_notional_before_risk ?? 0}`,
    `- action: ${decision.action}`,
    `- no_trade_reason: ${decision.noTradeReason ?? "none"}`,
    "",
    "## Reasoning Summary",
    "",
    estimate.reasoning_summary,
    "",
    "## Key Evidence",
    "",
    keyEvidence,
    "",
    "## Counter Evidence",
    "",
    counterEvidence,
    "",
    "## Uncertainty Factors",
    "",
    uncertainty,
    ""
  ].join("\n");
}

function onceRunSummary({ input, market, estimate, decision, risk, order, action }) {
  return [
    "# PolyPulse One-Shot Run",
    "",
    `- mode: ${input.mode}`,
    `- market: ${market.marketSlug}`,
    `- question: ${market.question}`,
    `- ai_probability: ${estimate.ai_probability}`,
    `- market_probability: ${decision.market_implied_probability ?? decision.marketProbability ?? "n/a"}`,
    `- edge: ${decision.edge ?? decision.grossEdge ?? "n/a"}`,
    `- net_edge: ${decision.netEdge ?? "n/a"}`,
    `- quarter_kelly_pct: ${decision.quarterKellyPct ?? "n/a"}`,
    `- monthly_return: ${decision.monthlyReturn ?? "n/a"}`,
    `- confidence: ${estimate.confidence}`,
    `- action: ${action}`,
    `- risk_allow: ${risk.allow ?? risk.allowed}`,
    `- adjusted_notional: ${risk.adjusted_notional ?? risk.approvedUsd ?? 0}`,
    `- blocked_reasons: ${(risk.blocked_reasons ?? risk.reasons ?? []).join(", ") || "none"}`,
    `- order_status: ${order?.status ?? "none"}`,
    "",
    "## Reasoning Summary",
    "",
    estimate.reasoning_summary ?? "No reasoning summary.",
    "",
    "## Input",
    "",
    "```json",
    JSON.stringify(redactSecrets(input), null, 2),
    "```",
    ""
  ].join("\n");
}

function monitorRunSummary({ runId, mode, scan, candidates, predictions, decisions, risks, orders, errors, recoveredRun, startedAt, completedAt, candidateTriage }) {
  const filled = orders.filter((order) => order.status === "filled");
  const blocked = orders.filter((order) => order.status === "blocked" || order.status === "rejected");
  const riskBlocks = risks.flatMap((item) => item.blocked_reasons ?? item.reasons ?? []);
  const uniqueRiskBlocks = [...new Set(riskBlocks)];
  const triageAssessments = candidateTriage?.candidate_assessments?.length ?? 0;
  const triageGaps = candidateTriage?.research_gaps?.length ? candidateTriage.research_gaps.join(", ") : "none";
  return [
    "# PolyPulse Monitor Run",
    "",
    `- run_id: ${runId}`,
    `- mode: ${mode}`,
    `- started_at: ${startedAt}`,
    `- completed_at: ${completedAt}`,
    `- markets_returned: ${scan?.markets?.length ?? 0}`,
    `- candidates: ${candidates.length}`,
    `- predictions: ${predictions.length}`,
    `- decisions: ${decisions.length}`,
    `- filled_orders: ${filled.length}`,
    `- blocked_or_rejected_orders: ${blocked.length}`,
    `- ai_candidate_triage_assessments: ${triageAssessments}`,
    `- recovered_previous_run: ${recoveredRun ? recoveredRun.runId : "none"}`,
    `- errors: ${errors.length ? errors.join("; ") : "none"}`,
    `- risk_blocks: ${uniqueRiskBlocks.length ? uniqueRiskBlocks.join(", ") : "none"}`,
    `- ai_research_gaps: ${triageGaps}`,
    "",
    "## Orders",
    "",
    ...(orders.length
      ? orders.map((order, index) => `${index + 1}. ${order.status} | ${order.mode} | requested=${order.requestedUsd} | filled=${order.filledUsd} | reason=${order.reason ?? "none"}`)
      : ["No orders submitted."]),
    ""
  ].join("\n");
}

function monitorPredictionSummary({ market, estimate, decision, risk, order }) {
  return [
    "# PolyPulse Monitor Prediction",
    "",
    `- market: ${market.marketSlug}`,
    `- question: ${market.question}`,
    `- ai_probability: ${estimate.ai_probability}`,
    `- confidence: ${estimate.confidence}`,
    `- market_probability: ${decision.market_implied_probability ?? decision.marketProbability ?? "n/a"}`,
    `- edge: ${decision.edge ?? decision.grossEdge ?? "n/a"}`,
    `- action: ${decision.action}`,
    `- risk_allow: ${risk?.allow ?? risk?.allowed ?? "n/a"}`,
    `- order_status: ${order?.status ?? "not_submitted"}`,
    "",
    "## Reasoning Summary",
    "",
    estimate.reasoning_summary ?? "No reasoning summary.",
    ""
  ].join("\n");
}

async function pathExists(absolutePath) {
  try {
    await stat(absolutePath);
    return true;
  } catch {
    return false;
  }
}

export class ArtifactWriter {
  constructor(config) {
    this.config = config;
  }

  async writeJson(kind, runId, payload) {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const dir = path.join(this.config.artifactDir, "runs", day, runId);
    await mkdir(dir, { recursive: true });
    const filename = `${safeKind(kind)}.json`;
    const absolutePath = path.join(dir, filename);
    await writeFile(absolutePath, JSON.stringify(redactSecrets(payload), null, 2), "utf8");
    return assertSchema("RunArtifact", {
      kind,
      runId,
      path: path.relative(process.cwd(), absolutePath),
      publishedAt: now.toISOString()
    });
  }

  async writeMarketScan(scan) {
    const now = new Date();
    const runId = safeTimestamp(now);
    const dir = path.join(this.config.artifactDir, "markets", runId);
    await mkdir(dir, { recursive: true });
    const marketsPath = path.join(dir, "markets.json");
    const summaryPath = path.join(dir, "summary.md");
    await writeFile(marketsPath, JSON.stringify(redactSecrets(scan), null, 2), "utf8");
    await writeFile(summaryPath, marketSummary(redactSecrets(scan)), "utf8");
    return {
      markets: assertSchema("RunArtifact", {
        kind: "market-scan-markets",
        runId,
        path: path.relative(process.cwd(), marketsPath),
        publishedAt: now.toISOString()
      }),
      summary: assertSchema("RunArtifact", {
        kind: "market-scan-summary",
        runId,
        path: path.relative(process.cwd(), summaryPath),
        publishedAt: now.toISOString()
      })
    };
  }

  async writePrediction({ market, evidence, estimate, decision }) {
    const now = new Date();
    const runId = `${safeTimestamp(now)}-${safeSlug(market.marketSlug ?? market.marketId)}`;
    const dir = path.join(this.config.artifactDir, "predictions", runId);
    await mkdir(dir, { recursive: true });
    const evidencePath = path.join(dir, "evidence.json");
    const estimatePath = path.join(dir, "estimate.json");
    const decisionPath = path.join(dir, "decision.md");
    await writeFile(evidencePath, JSON.stringify(redactSecrets(evidence), null, 2), "utf8");
    await writeFile(estimatePath, JSON.stringify(redactSecrets(estimate), null, 2), "utf8");
    await writeFile(decisionPath, predictionDecisionMarkdown({
      market,
      estimate: redactSecrets(estimate),
      decision: redactSecrets(decision)
    }), "utf8");
    return {
      evidence: assertSchema("RunArtifact", {
        kind: "prediction-evidence",
        runId,
        path: path.relative(process.cwd(), evidencePath),
        publishedAt: now.toISOString()
      }),
      estimate: assertSchema("RunArtifact", {
        kind: "prediction-estimate",
        runId,
        path: path.relative(process.cwd(), estimatePath),
        publishedAt: now.toISOString()
      }),
      decision: assertSchema("RunArtifact", {
        kind: "prediction-decision",
        runId,
        path: path.relative(process.cwd(), decisionPath),
        publishedAt: now.toISOString()
      })
    };
  }

  async writeAccountBalance(balance) {
    const now = new Date();
    const runId = safeTimestamp(now);
    const dir = path.join(this.config.artifactDir, "account", runId);
    await mkdir(dir, { recursive: true });
    const balancePath = path.join(dir, "balance.json");
    await writeFile(balancePath, JSON.stringify(redactSecrets(balance), null, 2), "utf8");
    return assertSchema("RunArtifact", {
      kind: "account-balance",
      runId,
      path: path.relative(process.cwd(), balancePath),
      publishedAt: now.toISOString()
    });
  }

  async writeAccountAudit(audit) {
    const now = new Date();
    const runId = safeTimestamp(now);
    const dir = path.join(this.config.artifactDir, "account", runId);
    await mkdir(dir, { recursive: true });
    const auditPath = path.join(dir, "audit.json");
    await writeFile(auditPath, JSON.stringify(redactSecrets(audit), null, 2), "utf8");
    return assertSchema("RunArtifact", {
      kind: "account-audit",
      runId,
      path: path.relative(process.cwd(), auditPath),
      publishedAt: now.toISOString()
    });
  }

  async writeAccountApproval(approval) {
    const now = new Date();
    const runId = safeTimestamp(now);
    const dir = path.join(this.config.artifactDir, "account", runId);
    await mkdir(dir, { recursive: true });
    const approvalPath = path.join(dir, "allowance-approval.json");
    await writeFile(approvalPath, JSON.stringify(redactSecrets(approval), null, 2), "utf8");
    return assertSchema("RunArtifact", {
      kind: "account-allowance-approval",
      runId,
      path: path.relative(process.cwd(), approvalPath),
      publishedAt: now.toISOString()
    });
  }

  async writeOnceRun({ input, market, evidence, estimate, decision, risk, order, action }) {
    const now = new Date();
    const runId = `${safeTimestamp(now)}-once`;
    const dir = path.join(this.config.artifactDir, "runs", runId);
    await mkdir(dir, { recursive: true });
    const files = {
      input: path.join(dir, "input.json"),
      market: path.join(dir, "market.json"),
      evidence: path.join(dir, "evidence.json"),
      estimate: path.join(dir, "estimate.json"),
      decision: path.join(dir, "decision.json"),
      risk: path.join(dir, "risk.json"),
      order: path.join(dir, "order.json"),
      summary: path.join(dir, "summary.md")
    };
    await writeFile(files.input, JSON.stringify(redactSecrets(input), null, 2), "utf8");
    await writeFile(files.market, JSON.stringify(redactSecrets(market), null, 2), "utf8");
    await writeFile(files.evidence, JSON.stringify(redactSecrets(evidence), null, 2), "utf8");
    await writeFile(files.estimate, JSON.stringify(redactSecrets(estimate), null, 2), "utf8");
    await writeFile(files.decision, JSON.stringify(redactSecrets(decision), null, 2), "utf8");
    await writeFile(files.risk, JSON.stringify(redactSecrets(risk), null, 2), "utf8");
    await writeFile(files.order, JSON.stringify(redactSecrets(order), null, 2), "utf8");
    await writeFile(files.summary, onceRunSummary({
      input,
      market,
      estimate: redactSecrets(estimate),
      decision: redactSecrets(decision),
      risk: redactSecrets(risk),
      order: redactSecrets(order),
      action
    }), "utf8");

    const artifact = (kind, absolutePath) => assertSchema("RunArtifact", {
      kind,
      runId,
      path: path.relative(process.cwd(), absolutePath),
      publishedAt: now.toISOString()
    });
    return {
      runId,
      dir: path.relative(process.cwd(), dir),
      input: artifact("once-input", files.input),
      market: artifact("once-market", files.market),
      evidence: artifact("once-evidence", files.evidence),
      estimate: artifact("once-estimate", files.estimate),
      decision: artifact("once-decision", files.decision),
      risk: artifact("once-risk", files.risk),
      order: artifact("once-order", files.order),
      summary: artifact("once-summary", files.summary)
    };
  }

  async writeMonitorRun({
    runId,
    mode,
    startedAt,
    completedAt,
    scan,
    candidates,
    predictions,
    decisions,
    risks,
    orders,
    errors = [],
    recoveredRun = null,
    candidateTriage = null
  }) {
    const now = new Date();
    const day = (startedAt ?? now.toISOString()).slice(0, 10);
    const dir = path.join(this.config.artifactDir, "monitor", day, safeSlug(runId));
    const predictionsDir = path.join(dir, "predictions");
    await mkdir(predictionsDir, { recursive: true });
    const files = {
      markets: path.join(dir, "markets.json"),
      candidates: path.join(dir, "candidates.json"),
      candidateTriage: path.join(dir, "candidate-triage.json"),
      decisions: path.join(dir, "decisions.json"),
      risk: path.join(dir, "risk.json"),
      orders: path.join(dir, "orders.json"),
      summary: path.join(dir, "summary.md")
    };
    await writeFile(files.markets, JSON.stringify(redactSecrets(scan), null, 2), "utf8");
    await writeFile(files.candidates, JSON.stringify(redactSecrets(candidates), null, 2), "utf8");
    await writeFile(files.candidateTriage, JSON.stringify(redactSecrets(candidateTriage), null, 2), "utf8");
    await writeFile(files.decisions, JSON.stringify(redactSecrets(decisions), null, 2), "utf8");
    await writeFile(files.risk, JSON.stringify(redactSecrets(risks), null, 2), "utf8");
    await writeFile(files.orders, JSON.stringify(redactSecrets(orders), null, 2), "utf8");

    for (const prediction of predictions) {
      const predictionDir = path.join(predictionsDir, safeSlug(prediction.market.marketSlug ?? prediction.market.marketId));
      await mkdir(predictionDir, { recursive: true });
      await writeFile(path.join(predictionDir, "evidence.json"), JSON.stringify(redactSecrets(prediction.evidence), null, 2), "utf8");
      await writeFile(path.join(predictionDir, "estimate.json"), JSON.stringify(redactSecrets(prediction.estimate), null, 2), "utf8");
      await writeFile(path.join(predictionDir, "decision.json"), JSON.stringify(redactSecrets(prediction.decision), null, 2), "utf8");
      await writeFile(path.join(predictionDir, "summary.md"), monitorPredictionSummary(redactSecrets(prediction)), "utf8");
    }

    await writeFile(files.summary, monitorRunSummary({
      runId,
      mode,
      scan: redactSecrets(scan),
      candidates: redactSecrets(candidates),
      predictions: redactSecrets(predictions),
      decisions: redactSecrets(decisions),
      risks: redactSecrets(risks),
      orders: redactSecrets(orders),
      errors,
      recoveredRun,
      startedAt,
      completedAt,
      candidateTriage: redactSecrets(candidateTriage)
    }), "utf8");

    await this.cleanupArtifacts();

    const artifact = (kind, absolutePath) => assertSchema("RunArtifact", {
      kind,
      runId,
      path: path.relative(process.cwd(), absolutePath),
      publishedAt: now.toISOString()
    });
    return {
      runId,
      dir: path.relative(process.cwd(), dir),
      markets: artifact("monitor-markets", files.markets),
      candidates: artifact("monitor-candidates", files.candidates),
      candidateTriage: artifact("monitor-candidate-triage", files.candidateTriage),
      decisions: artifact("monitor-decisions", files.decisions),
      risk: artifact("monitor-risk", files.risk),
      orders: artifact("monitor-orders", files.orders),
      summary: artifact("monitor-summary", files.summary)
    };
  }

  async cleanupArtifacts() {
    const retentionDays = this.config.artifacts?.retentionDays ?? 0;
    const maxRuns = this.config.artifacts?.maxRuns ?? 0;
    if (retentionDays <= 0 && maxRuns <= 0) {
      return;
    }
    const monitorRoot = path.join(this.config.artifactDir, "monitor");
    if (!(await pathExists(monitorRoot))) {
      return;
    }
    const dayNames = await readdir(monitorRoot);
    const runs = [];
    for (const dayName of dayNames) {
      const dayPath = path.join(monitorRoot, dayName);
      const dayStat = await stat(dayPath).catch(() => null);
      if (!dayStat?.isDirectory()) {
        continue;
      }
      for (const runName of await readdir(dayPath)) {
        const runPath = path.join(dayPath, runName);
        const runStat = await stat(runPath).catch(() => null);
        if (runStat?.isDirectory()) {
          runs.push({ path: runPath, mtimeMs: runStat.mtimeMs });
        }
      }
    }
    const cutoffMs = retentionDays > 0 ? Date.now() - (retentionDays * 86_400_000) : null;
    const byAge = cutoffMs == null ? [] : runs.filter((run) => run.mtimeMs < cutoffMs);
    const byCount = maxRuns > 0
      ? runs.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(maxRuns)
      : [];
    for (const item of [...new Set([...byAge, ...byCount].map((run) => run.path))]) {
      await rm(item, { recursive: true, force: true });
    }
  }
}
