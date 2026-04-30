# PolyPulse 产品需求规格

最后更新：2026-04-30

## 1. 产品定位

PolyPulse 是一个预测市场自主交易 Agent 框架。它面向 Polymarket 这类预测市场，持续扫描大量市场，主动抓取外部证据，独立估算事件发生概率，再结合市场隐含概率、edge、流动性、费用和风控规则，决定是否生成交易建议、paper 模拟交易或 live 实盘交易。

产品默认运行在安全模式：默认 paper，不默认实盘。任何 live 路径都必须经过 preflight、dry-run 或 recommend-only，并需要用户显式确认。

## 2. 目标

- 支持从 Polymarket 扫描大量市场，而不是只服务几十个固定市场。
- 支持 AI 自动抓取外部证据，并生成可审计的概率估计。
- 支持 market probability、AI probability、edge、流动性与风险约束统一进入交易决策。
- 支持 paper 与 live 两套 broker，但复用同一套决策与风控逻辑。
- 支持一次性交易与持久监控两类运行方式。
- 支持 crash recovery、可恢复运行状态、去重下单与完整运行归档。
- 支持轻量级服务器部署，适合单机或小规模云主机长期运行。

## 3. 非目标

- 本规格不限定 TypeScript、Python、数据库、队列、Web 框架或部署平台。
- 本阶段不实现交易逻辑，不集成真实钱包，不运行 live 命令。
- 不承诺高频交易。PolyPulse 是证据驱动的预测市场决策系统，不是低延迟做市系统。
- 不让 AI 直接绕过服务层风控。AI 输出只能作为建议。

## 4. 用户与使用场景

### 4.1 研究型用户

用户希望快速发现当前有 edge 的市场，并查看证据、概率、理由和风险拦截结果。

核心能力：

- 扫描当前市场话题。
- 抓取证据并估算概率。
- 生成 recommend-only 报告。
- 查看 no-trade 原因。

### 4.2 Paper 交易用户

用户希望先用模拟盘验证策略。

核心能力：

- 查询模拟账户状态。
- 一次性 paper 下单。
- 持久监控话题并自动 paper 下单。
- 崩溃后恢复未完成 run。

### 4.3 Live 交易用户

用户希望在严格风控下执行真实订单。

核心能力：

- 查询 Polymarket 账户余额和持仓。
- live preflight。
- live dry-run。
- 显式确认后一次性 live 下单。
- 显式启用后持久 live 监控与自动下单。

## 5. 功能需求

### 5.1 Polymarket 账户余额查询

系统必须提供余额查询能力：

- 输入：env 引用、账户地址或 broker profile。
- 输出：脱敏账户标识、collateral / pUSD / USDC 可用余额、open positions 数量、最近更新时间。
- 安全要求：不得打印私钥、助记词、session、cookie 或完整 env 内容。
- live 交易前必须查询余额；查询失败时 live fail-fast。

验收标准：

- 缺少必要 env 时返回 preflight failure。
- 输出只包含脱敏地址和余额摘要。
- 余额结果写入 run artifact，但不包含 secrets。

### 5.2 当前市场话题抓取

系统必须从 MarketSource 抓取 Polymarket 当前可交易市场：

- 支持分页、批量抓取和增量刷新。
- 支持按分类、标签、结束时间、流动性、成交量、价格区间筛选。
- 市场结构必须包含 market id、event id、slug、question、outcomes、token ids、best bid、best ask、spread、liquidity、volume、end date、resolution rules。
- 必须支持大量市场扫描，设计目标不是几十个市场，而是数千到数万市场的分批处理。

验收标准：

- 扫描结果包含原始数量、过滤数量、候选数量和风险标记。
- 缺 token、缺价格、缺结算规则或明显 stale 的市场被标记。
- 高频轮询时复用未过期市场快照，避免无意义重复抓取。

### 5.3 AI 抓取外部证据

系统必须通过 EvidenceCrawler 为候选市场抓取证据：

- Polymarket 市场规则、resolution source、评论、订单簿摘要。
- 外部网页、新闻、官方来源、数据源、社交或公告来源。
- 每条证据必须记录 source url、retrieved_at、摘要、可信度、抓取状态。
- 证据抓取要支持并发、限流、重试和失败追踪。

验收标准：

- 抓取失败不能伪造成证据；必须进入 evidence gaps。
- 证据不足时 ProbabilityEstimator 可以输出低置信度或 no-trade。
- 所有证据输入写入 artifact，便于复盘。

### 5.4 AI 估算事件胜率 / 发生概率

系统必须用 ProbabilityEstimator 独立估算事件概率：

- 输入：market snapshot、evidence bundle、历史上下文、结算规则。
- 输出：每个 outcome 的 `aiProbability`、置信度、理由、证据引用、模型诊断。
- 必须区分市场价格和 AI 估计，不能把市场价格直接当作 AI 概率。
- 多 outcome 市场必须保证概率口径明确。

验收标准：

- 缺证据时输出 `insufficient_evidence` 或低置信度，不强行交易。
- 输出可被 schema 校验。
- 概率估计写入 artifact。

### 5.5 市场隐含概率计算

系统必须从市场价格计算隐含概率：

- 二元市场：优先使用可执行价格，如 BUY side 使用 best ask 或可成交加权价。
- 多 outcome 市场：必须说明是否归一化、是否考虑 neg risk、费用和盘口深度。
- 当订单簿缺失时，市场概率状态为 unavailable。

验收标准：

- `marketProbability` 的来源可追踪。
- 价格缺失或异常时不允许进入 live execution。

### 5.6 Edge 计算

系统必须计算：

```text
grossEdge = aiProbability - marketProbability
netEdge = grossEdge - estimatedFees - slippageAllowance
```

系统应保留 gross edge、net edge、费用估计、slippage 估计和计算输入。

验收标准：

- edge 为负或低于策略阈值时默认 no-trade。
- edge 计算不直接触发下单，必须经过 DecisionEngine 与 RiskEngine。

### 5.7 流动性过滤

系统必须在多个阶段执行流动性过滤：

- 扫描阶段：过滤低 liquidity / low volume 市场。
- 预测阶段：标记盘口薄、spread 宽或订单簿不可用的市场。
- 执行阶段：按订单簿深度和 slippage cap 计算最大可执行金额。

验收标准：

- 不为了满足最小下单额而放大订单。
- 订单金额超过可执行深度时只向下裁剪。
- 裁剪后低于最小单则 skip。

### 5.8 Paper 模拟盘一次性下单

系统必须支持一次性 paper 下单：

- 用户指定 market、side、amount 或使用推荐 run。
- 订单通过同一套 RiskEngine。
- PaperBroker 写入模拟成交、持仓、现金和 equity curve。

验收标准：

- 默认 broker 是 PaperBroker。
- paper 下单不需要真实私钥。
- paper 成交有 artifact 与可恢复状态。

### 5.9 Live 实盘一次性下单

系统必须支持显式确认后的 live 一次性下单：

- 必须先运行 live preflight。
- 必须先生成 dry-run 或 recommend-only artifact。
- 必须带 `confirmLive` 参数，绑定 run id、market、side、amount 和 env fingerprint。
- LiveBroker 只能执行 RiskEngine 输出的 execution plan。

验收标准：

- 没有确认时返回 blocked。
- env 校验失败、余额不足、订单簿不可用、状态 halted 时 fail-fast。
- 所有 live 结果写入 execution summary。

### 5.10 Paper 模式持久化话题监测与自动下单

系统必须支持 paper monitor：

- Scheduler 按周期扫描市场。
- 对新增或变化显著的市场抓取证据和估算概率。
- DecisionEngine 生成候选交易。
- RiskEngine 裁剪后 PaperBroker 自动成交。
- StateStore 持久保存 cursor、run status、dedupe key、持仓和 checkpoint。

验收标准：

- 进程崩溃后可从最近 checkpoint 继续。
- 同一市场/事件不会因为重复轮询误下单。
- 高频轮询时不会反复抓取未变化证据。

### 5.11 Live 模式持久化话题监测与自动下单

系统必须支持 live monitor，但默认关闭：

- 需要显式配置 `allowLiveExecution=true` 或等价确认。
- 每轮必须 preflight。
- 每轮必须先写 recommend-only / dry-run artifact。
- 自动执行范围必须由 allowlist、max order、daily loss、event exposure、dedupe lock 限制。
- 用户未确认自动 live 时，只能发送 Reporter 通知，不执行订单。

验收标准：

- live monitor 默认 recommend-only。
- 自动 live 执行必须能证明本轮授权、风控通过、dedupe lock 已获取。
- 崩溃恢复后不会重复提交同一订单。

### 5.12 交易决策归档

每次 run 必须归档：

- scan snapshot
- evidence bundle
- probability estimates
- market probability and edge calculation
- decision set
- risk decision
- paper / live execution result
- runtime log
- error artifact

验收标准：

- 任意交易或 no-trade 都能通过 run id 复盘。
- artifact 不能包含 secrets。
- artifact 有保留与清理策略。

### 5.13 可恢复运行状态

系统必须用 StateStore 保存：

- run id、stage、status、started_at、updated_at。
- scheduler cursor。
- market snapshot hash。
- evidence cache key。
- decision dedupe key。
- broker order id 或 paper order id。
- last successful checkpoint。

验收标准：

- 任意阶段 crash 后可以恢复或安全终止。
- 已提交 broker 的 live order 不会在恢复时重复提交。

### 5.14 轻量级服务器部署

系统必须支持轻量级部署：

- 单机长期运行。
- 一个 scheduler/worker 进程即可完成扫描、证据、预测、决策、下单。
- 可选 HTTP server 提供 health、run status、artifact index 和手动触发接口。
- 可选外部数据库和队列，但不能成为 MVP 强制依赖。

验收标准：

- 支持本地开发与单机云主机运行。
- health endpoint 或等价命令能报告 scheduler、broker、state store、artifact writer 状态。

## 6. 性能与可靠性目标

- 市场扫描：设计上支持数千到数万市场分页扫描；候选筛选必须流式或批量处理，避免一次性把所有阶段串行阻塞。
- 并发与限流：MarketSource、EvidenceCrawler、ProbabilityEstimator、Broker 都必须支持并发上限、速率限制和超时。
- 重试与降级：外部 API 失败要可重试；重试耗尽后写入 failure artifact。降级只能降低覆盖面或进入 no-trade，不能伪造数据。
- Crash recovery：持久监控必须至少在 run stage、market cursor、decision dedupe、broker submission 四个层面可恢复。
- 去重交易：同一 market/event/outcome/side 在同一策略窗口内必须有 dedupe key 和锁。
- 抓取去重：高频轮询时按 market snapshot hash、evidence TTL、source ETag 或内容 hash 避免重复抓取。
- 存储治理：memory 与 runtime artifacts 不能无限膨胀；必须支持保留策略、压缩归档、索引摘要和过期清理。

## 7. 安全要求

- 默认 paper。
- live 必须显式确认。
- 私钥不落盘、不打印，不写入 memory、artifact、测试快照或 git。
- env 校验失败 fail-fast。
- 风控在服务层强制执行，不能只靠 prompt。
- AI 输出只能作为建议，最终交易必须经过 RiskEngine。
- LiveBroker 必须 fail-closed：配置缺失、状态不明、余额异常、订单簿异常、重复锁获取失败时不下单。

## 8. 关键指标

- scanned markets count
- candidate count
- evidence success / failure count
- probability estimate latency
- risk blocked count
- no-trade reason distribution
- paper/live orders submitted
- duplicate order prevented count
- recovery success count
- artifact storage size and cleanup count

## 9. MVP 验收顺序

1. 定义接口和数据结构。
2. 实现 MarketSource scan 与 ArtifactWriter。
3. 实现 EvidenceCrawler 和 ProbabilityEstimator 的可替换适配。
4. 实现 DecisionEngine 与 RiskEngine。
5. 实现 PaperBroker 与 paper monitor。
6. 增加 LiveBroker preflight 和 dry-run。
7. 在显式确认下开放 live once。
8. 最后开放受限 live monitor。
