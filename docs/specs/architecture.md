# PolyPulse 架构规格

最后更新：2026-04-30

## 1. 架构原则

- 不过早绑定技术栈。本文使用接口和数据契约描述系统，不要求固定语言、框架、数据库或队列。
- AI 负责证据理解和概率估计，服务层负责状态、风控、去重和执行。
- PaperBroker 与 LiveBroker 共享 DecisionEngine 和 RiskEngine。
- 所有关键阶段写 StateStore 与 ArtifactWriter，支持 crash recovery。
- 默认 paper；live 执行必须显式确认并 fail-closed。

## 2. 组件总览

```text
Scheduler
  -> MarketSource
  -> EvidenceCrawler
  -> ProbabilityEstimator
  -> DecisionEngine
  -> RiskEngine
  -> Broker (PaperBroker / LiveBroker)
  -> StateStore + ArtifactWriter
  -> Notifier / Reporter
```

### 2.1 MarketSource

职责：

- 抓取 Polymarket 当前市场话题。
- 提供分页、过滤、增量刷新和订单簿读取。
- 输出标准 MarketSnapshot，不暴露 provider 私有结构给下游。

接口：

```ts
interface MarketSource {
  scan(request: MarketScanRequest): Promise<MarketScanResult>;
  getMarket(marketId: string): Promise<Market | null>;
  getOrderBook(tokenId: string): Promise<OrderBookSnapshot | null>;
  getAccountBalance(accountRef: AccountRef): Promise<BalanceSnapshot>;
  getOpenPositions(accountRef: AccountRef): Promise<PositionSnapshot[]>;
}
```

性能要求：

- `scan()` 支持分页 cursor。
- 支持扫描数千到数万市场。
- 支持 per-host rate limit、超时、重试和 partial result。

### 2.2 EvidenceCrawler

职责：

- 为候选市场抓取外部证据。
- 记录来源、抓取状态、内容摘要、可信度和证据缺口。
- 高频轮询时避免重复抓取未变化内容。

接口：

```ts
interface EvidenceCrawler {
  collect(request: EvidenceRequest): Promise<EvidenceBundle>;
  refresh(source: EvidenceSourceRef): Promise<EvidenceItem>;
}
```

缓存策略：

- 按 market id、source url、retrieved window、content hash 建缓存 key。
- 支持 TTL，不同 source 类型 TTL 可不同。
- 使用 stale-while-revalidate 时必须标记证据是否 stale。

### 2.3 ProbabilityEstimator

职责：

- 基于 market snapshot 与 evidence bundle 估算事件发生概率。
- 输出可校验的 ProbabilityEstimate。
- 失败时给出 no-estimate 原因，不编造概率。

接口：

```ts
interface ProbabilityEstimator {
  estimate(request: ProbabilityRequest): Promise<ProbabilityEstimate>;
}
```

约束：

- 输出必须引用 evidence ids。
- AI 输出必须通过 schema 校验。
- 估算结果不能直接下单。

Codex provider 兼容层：

- PolyPulse 支持 Predict-Raven 风格的 `AGENT_RUNTIME_PROVIDER=codex` / `CODEX_*` 配置。
- Codex 运行时必须使用 read-only sandbox、output schema、temp dir、timeout、原始输出归档和失败诊断保留。
- 与 Predict-Raven 不同的是，Codex 在 PolyPulse 中只能输出 `ProbabilityEstimate`，不能直接输出可执行交易 JSON；后续仍必须经过 DecisionEngine 与 RiskEngine。

### 2.4 DecisionEngine

职责：

- 汇总市场隐含概率、AI 概率、edge、费用、流动性和当前持仓。
- 输出 TradeDecisionSet。
- 对 no-trade 给出明确原因。

接口：

```ts
interface DecisionEngine {
  decide(request: DecisionRequest): Promise<TradeDecisionSet>;
}
```

决策建议：

- open：仅当 net edge、置信度、流动性和结算规则同时满足。
- hold：已有持仓没有反向证据且未触发风险退出。
- reduce / close：止损、反向证据、edge 转负或事件风险变化。
- skip：证据不足、流动性不足、风险过高、重复交易、市场不可执行。

### 2.5 RiskEngine

职责：

- 服务层强制风控。
- 把 TradeDecisionSet 转成 RiskAdjustedPlan。
- 所有 PaperBroker 和 LiveBroker 执行前必须调用 RiskEngine。

接口：

```ts
interface RiskEngine {
  preflight(request: PreflightRequest): Promise<PreflightReport>;
  evaluate(request: RiskEvaluationRequest): Promise<RiskDecision>;
  buildExecutionPlan(request: ExecutionPlanRequest): Promise<RiskAdjustedPlan>;
}
```

强制检查：

- system status。
- env 和 broker readiness。
- token 是否来自当前 market snapshot。
- sell 是否来自当前持仓。
- bankroll、单笔、总敞口、单事件敞口、最大持仓数。
- 订单簿、最小单、slippage cap。
- dedupe lock。
- live confirmation。

### 2.6 Broker / PaperBroker / LiveBroker

职责：

- Broker 是执行抽象。
- PaperBroker 只更新模拟状态。
- LiveBroker 连接真实 Polymarket，必须 fail-closed。

接口：

```ts
interface Broker {
  kind: "paper" | "live";
  preflight(request: BrokerPreflightRequest): Promise<BrokerPreflightReport>;
  quote(order: OrderIntent): Promise<OrderQuote>;
  submit(plan: ExecutableOrder, confirmation?: LiveConfirmation): Promise<OrderResult>;
  sync(accountRef: AccountRef): Promise<PortfolioSnapshot>;
}

interface PaperBroker extends Broker {
  kind: "paper";
}

interface LiveBroker extends Broker {
  kind: "live";
}
```

LiveBroker 额外要求：

- 不接收原始 AI decision，只接收 RiskEngine 输出的 ExecutableOrder。
- 必须验证 confirmation 绑定 run id、market、token、side、amount、env fingerprint。
- submit 前再次读取订单簿和余额。
- 服务器 live 部署支持 `POLYPULSE_LIVE_WALLET_MODE=simulated|real`。`simulated` 只演练 live 路径，不连接真实钱包；`real` 才连接 Polymarket 钱包。

### 2.7 StateStore

职责：

- 保存 run 状态、checkpoint、cursor、positions、orders、dedupe locks。
- 支持 crash recovery。
- 支持单机轻量实现和外部 DB 实现。

接口：

```ts
interface StateStore {
  createRun(input: CreateRunInput): Promise<RunRecord>;
  updateRunStage(runId: string, stage: RunStage, patch?: unknown): Promise<void>;
  getRun(runId: string): Promise<RunRecord | null>;
  saveCheckpoint(runId: string, checkpoint: Checkpoint): Promise<void>;
  loadCheckpoint(runId: string): Promise<Checkpoint | null>;
  acquireDedupeLock(key: string, ttlMs: number): Promise<DedupeLockResult>;
  recordOrder(result: OrderResult): Promise<void>;
  getPortfolio(accountRef: AccountRef): Promise<PortfolioSnapshot>;
}
```

Recovery 要求：

- 如果 crash 发生在 broker submit 前，恢复后可重新评估。
- 如果 crash 发生在 broker submit 后，必须先按 broker order id 查询状态，不能重复提交。
- 所有 run stage 必须幂等。

### 2.8 ArtifactWriter

职责：

- 写入 scan、evidence、prediction、decision、risk、execution、error、summary。
- 做脱敏、索引、保留策略和清理。

接口：

```ts
interface ArtifactWriter {
  write(input: ArtifactWriteRequest): Promise<ArtifactRef>;
  writeJson(kind: ArtifactKind, runId: string, payload: unknown): Promise<ArtifactRef>;
  writeMarkdown(kind: ArtifactKind, runId: string, markdown: string): Promise<ArtifactRef>;
  redact(payload: unknown): unknown;
  cleanup(policy: RetentionPolicy): Promise<CleanupReport>;
}
```

存储策略：

- 最近 N 天原始 artifact 保留。
- 老 artifact 压缩或转摘要。
- runtime memory 只保留索引与摘要，不无限追加大对象。
- secret pattern 扫描作为写入前校验。

### 2.9 Scheduler

职责：

- 调度一次性 run 和持久 monitor。
- 控制并发、限流、重试和心跳。
- 维护 cursor 和 crash recovery。

接口：

```ts
interface Scheduler {
  runOnce(request: RunOnceRequest): Promise<RunResult>;
  startMonitor(request: MonitorRequest): Promise<MonitorHandle>;
  stopMonitor(id: string): Promise<void>;
  recover(): Promise<RecoveryReport>;
}
```

约束：

- 同一策略和市场窗口内不得并发提交重复订单。
- monitor 每轮必须写 heartbeat。
- backoff 后重试，重试耗尽进入 failed，不静默丢失。

### 2.10 Notifier / Reporter

职责：

- 向用户或外部通道报告 run summary、blocked reason、preflight failure、live confirmation request。
- Reporter 可以是 CLI、日志、HTTP response、Slack、Telegram、邮件或 Web UI。

接口：

```ts
interface Reporter {
  stage(event: StageEvent): Promise<void>;
  result(summary: RunSummary): Promise<void>;
  alert(alert: AlertEvent): Promise<void>;
}
```

要求：

- 屏幕输出短状态。
- 长分析写入 ArtifactWriter 或 memory。
- live confirmation request 必须包含 run id、订单摘要、风险摘要和 artifact 路径。

## 3. 核心数据模型

### 3.1 Market

```ts
interface Market {
  marketId: string;
  eventId: string;
  marketSlug: string;
  eventSlug: string;
  question: string;
  outcomes: Outcome[];
  endDate: string | null;
  resolutionRules: string | null;
  resolutionSourceUrl: string | null;
  liquidityUsd: number;
  volume24hUsd: number;
  category: string | null;
  tags: string[];
  fetchedAt: string;
}
```

### 3.2 Outcome

```ts
interface Outcome {
  label: string;
  tokenId: string;
  bestBid: number | null;
  bestAsk: number | null;
  lastPrice: number | null;
}
```

### 3.3 EvidenceBundle

```ts
interface EvidenceBundle {
  marketId: string;
  collectedAt: string;
  items: EvidenceItem[];
  gaps: EvidenceGap[];
  sourceStats: {
    requested: number;
    succeeded: number;
    failed: number;
    stale: number;
  };
}
```

### 3.4 ProbabilityEstimate

```ts
interface ProbabilityEstimate {
  marketId: string;
  outcomeEstimates: Array<{
    tokenId: string;
    label: string;
    aiProbability: number;
    confidence: "low" | "medium" | "medium-high" | "high";
    reasoning: string;
    evidenceIds: string[];
  }>;
  diagnostics: {
    model: string;
    evidenceCoverage: number;
    missingEvidence: string[];
    generatedAt: string;
  };
}
```

### 3.5 TradeDecisionSet

```ts
interface TradeDecisionSet {
  runId: string;
  generatedAt: string;
  mode: "scan" | "recommend" | "paper" | "live";
  decisions: TradeDecision[];
  artifacts: ArtifactRef[];
}
```

### 3.6 TradeDecision

```ts
interface TradeDecision {
  action: "open" | "hold" | "reduce" | "close" | "skip";
  marketId: string;
  eventId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  marketProbability: number | null;
  aiProbability: number | null;
  grossEdge: number | null;
  netEdge: number | null;
  confidence: string;
  requestedUsd: number;
  thesis: string;
  sources: string[];
}
```

## 4. 运行流程

### 4.1 扫描与推荐

```text
Scheduler.runOnce
  -> StateStore.createRun
  -> MarketSource.scan
  -> liquidity/filter/dedupe
  -> EvidenceCrawler.collect
  -> ProbabilityEstimator.estimate
  -> DecisionEngine.decide
  -> RiskEngine.buildExecutionPlan
  -> ArtifactWriter.write
  -> Reporter.result
```

### 4.2 Paper 一次性下单

```text
TradeDecisionSet
  -> RiskEngine.buildExecutionPlan
  -> PaperBroker.submit
  -> StateStore.recordOrder
  -> ArtifactWriter.write execution summary
```

### 4.3 Live 一次性下单

```text
Live preflight
  -> recommend-only or dry-run
  -> user confirmLive(runId)
  -> RiskEngine re-evaluate
  -> LiveBroker quote
  -> LiveBroker submit
  -> Broker sync
  -> ArtifactWriter.write execution summary
```

### 4.4 持久监控

```text
Scheduler loop
  -> load cursor/checkpoint
  -> scan changed markets
  -> refresh stale evidence only
  -> estimate changed candidates
  -> acquire dedupe lock
  -> risk plan
  -> paper execute or live confirmation/execute
  -> checkpoint
```

## 5. 并发、限流与重试

每个外部依赖都要独立控制：

- MarketSource：分页并发、host rate limit、scan timeout。
- EvidenceCrawler：source-level concurrency、robots/ToS 合规、重试与 backoff。
- ProbabilityEstimator：模型调用并发、token budget、schema retry。
- Broker：串行化同账户提交，避免 nonce/order state 冲突。
- ArtifactWriter：批量写入、压缩、写失败重试。

失败策略：

- 可重试错误：网络超时、429、临时 5xx、模型 schema 可修复错误。
- 不可重试错误：env 缺失、live 未确认、余额不足、重复锁失败、token 不在 snapshot。
- 降级只允许减少候选或 no-trade，不允许 mock live 数据。

## 6. 去重与幂等

交易 dedupe key：

```text
strategyId:eventId:marketId:tokenId:side:action:timeWindow
```

执行幂等 key：

```text
runId:decisionId:brokerKind:accountRef
```

规则：

- 获取 dedupe lock 失败时 skip，不等待重试下单。
- 恢复时若存在 broker order id，先查询 broker 状态。
- PaperBroker 与 LiveBroker 都必须记录 idempotency key。

## 7. 部署形态

MVP 轻量部署：

- 一个 CLI 或 worker 进程。
- 本地文件或轻量数据库作为 StateStore。
- 本地目录作为 ArtifactWriter。
- 可选 HTTP server 暴露 `/health`、`/runs/:id`、`/artifacts`、`/trigger`.

扩展部署：

- Market scan worker、evidence worker、probability worker、broker worker 分离。
- 外部队列和数据库。
- Web UI 读取 ArtifactWriter index 与 StateStore。

## 8. 安全边界

- Secrets 只通过运行时 secret provider 或 env 注入。
- ArtifactWriter 写入前必须脱敏。
- Reporter 只能显示脱敏账户。
- LiveBroker 不接受未确认订单。
- RiskEngine 是 broker 前最后强制边界。
