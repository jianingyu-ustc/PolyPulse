# PolyPulse

## 项目概览

PolyPulse 是一个面向 Polymarket 的预测市场自主交易 Agent 框架。统一使用真实钱包，通过 `POLYPULSE_EXECUTION_MODE` 控制最后一步是否真正下单：

- `paper`：连接真实钱包，走完整链路（live preflight、AI provider、RiskEngine），但最后一步不提交真实订单；用内存账本按真实市场价格追踪仓位和 PnL，追加人类可读日志。
- `live`：连接真实钱包，走完整链路，风控允许后提交真实订单。

所有测试、验收和部署命令都必须使用 `.env`，并读取当前 Polymarket 真实市场。

核心链路：抓取当前 Polymarket 市场话题，规则预筛后先用轻量 AI pre-screen 做信息优势预判（TRADE/SKIP），再用 AI provider 做候选 triage，收集证据（包括从 Polymarket 页面抓取的结算规则、注释和社区评论，从 CLOB 获取的 order book 深度和价差，以及对 resolution source URL 的实时访问验证），调用配置的 AI provider 估算事件真实发生概率，借鉴 Predict-Raven `pulse-direct` 的职责分离和收益计算口径计算 fee、net edge、quarter Kelly sizing 和 monthly return，再通过 `RiskEngine`、live preflight、余额检查和 `OrderExecutor` 决定是否执行。

Codex / Claude Code runtime 只允许输出 `CandidateTriage` 或 `ProbabilityEstimate`，不能直接输出 broker 参数、token 改写、交易金额或可执行订单。AI 只负责候选语义 triage、概率、证据质量、可研究性和信息优势判断；fee、net edge、quarter Kelly、monthly return、排序、batch cap 和执行风控都由代码计算。

概率和下单金额口径：AI provider 输出的 `ai_probability` 表示 Yes outcome 的独立概率估计；代码会为每个 outcome 生成可执行比较口径，Yes 使用 `ai_probability`，No 使用 `1 - ai_probability`。`DecisionEngine` 会同时评估 Yes 和 No，分别比较 `outcome_ai_probability` 和该 outcome 的 `market_implied_probability`，计算 `grossEdge = outcome_ai_probability - market_implied_probability`，再扣除 fee 得到 `netEdge`。因此当 Yes 的 `ai_probability < Yes market_implied_probability` 时，不是必然跳过；如果 No outcome 的 `1 - ai_probability` 高于 No 盘口且扣费后 `netEdge > 0`，系统会考虑买入 No，否则跳过。`pulse-direct` 下仓位先按 quarter Kelly 计算：`fullKellyPct = max(0, (outcome_ai_probability - market_implied_probability) / (1 - market_implied_probability))`，`quarterKellyPct = fullKellyPct / 4`，`suggestedNotionalUsd = bankrollUsd * quarterKellyPct`。最终可下单金额不是 AI 决定，也不等于 `MONITOR_MAX_AMOUNT_USD`，而是由代码取 `MONITOR_MAX_AMOUNT_USD`（或默认 `MIN_TRADE_USD`）、daily 剩余额度、`suggestedNotionalUsd`、单笔/总敞口/event 敞口/流动性上限、真实余额和 allowance 等约束后的 `approvedUsd`；实际提交的 `risk.order.amountUsd` 小于等于 `MONITOR_MAX_AMOUNT_USD`，风控不通过时为 0。

PolyPulse 当前不是完整复刻 Predict-Raven 方法。当前实现借鉴 Predict-Raven 的职责分离、fee / edge / Kelly / monthly return 计算和 provider 输出边界。已对齐的 AI 使用边界是：provider 对候选池先做轻量信息优势 pre-screen（TRADE/SKIP），再输出语义 triage、可研究性、信息优势和证据缺口判断；证据收集阶段先由规则适配器抓取基础证据（Polymarket 页面结算规则/注释/评论、CLOB order book 深度、resolution source 实时验证、领域适配器），再由 AI Evidence Research runtime 评估证据充分性、识别信息缺口并主动指导定向搜索，对齐 Predict-Raven 的 AI 驱动研究流水线；provider 对单市场输出概率和证据质量判断；monitor 对一轮候选先生成 AI 概率，再由代码按收益指标排序和执行。

主要 artifact 写入 `runtime-artifacts/`，包括 markets、predictions、runs、monitor、account、test-runs 和 provider runtime 日志；monitor artifact 中会包含 `candidate-triage.json`。`paper` 和 `live` 模式生成完全相同的结构化 artifact（per-round 目录和 provider runtime 日志）；`paper` 模式额外使用进程内内存账本，追加写入 `MONITOR_LOG_PATH` 人类可读日志记录仓位、PnL 和胜率。所有 artifact 和日志写入前会做 secret redaction。不要把真实 `.env`、私钥、助记词、API key、cookie 或 session token 写入仓库、日志、memory 或测试快照。

服务器部署默认目录是 `/home/PolyPulse`，运行时文件默认在 `/home/PolyPulse/.env`、`/home/PolyPulse/runtime-artifacts`、`/home/PolyPulse/runtime-artifacts/state` 和 `/home/PolyPulse/logs`。`.env` 权限必须是 `600`，真实 secret 只放服务器本地。

部署相关文件：`src/config/env.js` 的 `DEFAULTS` 对象是所有环境变量的唯一定义（含注释说明），`deploy/systemd/polypulse-monitor.service` 是 systemd 常驻 monitor 服务，`deploy/scripts/*.sh` 覆盖安装、启动、停止、状态和健康检查。

### 完整链路示例

以真实 paper 模式运行记录为例（市场：`will-the-democratic-party-win-the-ok-02-house-seat`，"民主党会赢得 Oklahoma 第 2 选区众议院席位吗？"）：

| Step | 阶段 | 实际执行 |
|------|------|---------|
| 1 | **Scan** | 从 Polymarket Gamma 拉取 200 个市场，按流动性/volume/规则过滤为 20 个候选 |
| 2 | **Pre-screen** | 轻量 AI 判定 `TRADE`："可通过选区基本面和历史共和党优势验证 7% 定价合理性" |
| 3 | **Triage** | AI 语义 triage：score=0.2, researchability=medium, information_advantage=low；识别证据缺口（partisan lean, incumbency, polling, wave indicators, order book depth） |
| 4 | **Evidence** | 收集证据：Polymarket 页面结算规则/评论、CLOB order book 深度、resolution source 验证、领域适配器、AI Evidence Research 定向搜索 |
| 5 | **Prediction** | AI 估算 `ai_probability=0.05`（民主党仅 5% 概率赢），confidence=low；代码计算 No 侧 market_probability=0.935, grossEdge=0.015, 扣 fee 后 netEdge=0.015, quarterKellyPct=5.8%, monthlyReturn=0.26% |
| 6 | **Risk** | RiskEngine 批准：allowed=true, approvedUsd=$10（warning: ai_confidence_below_minimum）；daily limit/exposure/slippage 均未触发阻断 |
| 7 | **Execution** | 买入 No @ $0.935, size=10.695 shares, cost=$10；paper 模式写入内存账本，不提交真实订单 |

后续每轮 position-review 重新评估 edge，确认仍为正（netEdge=0.015）→ `hold_until_settlement`。


### 与 Predict-Raven 的关系和当前差距

PolyPulse 当前和 Predict-Raven 相同或接近的部分：

- AI provider 只输出 `CandidateTriage` 或 `ProbabilityEstimate`：候选语义 triage、概率估计、置信度、证据引用、不确定性因素、可研究性、信息优势和证据缺口。
- 代码负责 fee、edge、net edge、quarter Kelly、monthly return、候选排序、batch cap、风控和执行。
- provider 输出不能控制 broker、token 改写、交易金额或真实订单。
- `monitor run` 在规则预筛后会先调用轻量 AI pre-screen 对候选做信息优势预筛（TRADE/SKIP 分类，60 秒超时，失败时全部保留），再调用 AI candidate triage 对剩余候选做语义聚类、主题优先级、可研究性、信息优势和证据缺口判断；`reject` 候选会被记录为 `ai_triage_reject`，不进入后续概率估算。这对齐了 Predict-Raven 的 `pulse-prescreen.ts` 两层 AI 筛选机制。
- `monitor run` 对规则预筛后的候选先调用 provider 生成概率估计，再由代码按 `action`、`confidence`、`monthly_return`、`net_edge`、`quarter_kelly_pct`、`expected_value` 等 AI 衍生收益指标排序后执行。
- 证据收集阶段会从 Polymarket 事件页面抓取 `__NEXT_DATA__` SSR 数据，提取完整结算规则、注释/公告和社区高赞评论，作为高可信度证据传给 AI。这对齐了 Predict-Raven 的 `scrape-market.ts --sections context,rules,comments` 深度研究步骤，使 AI 能看到市场完整的结算条件、官方公告和社区讨论。
- 证据收集阶段会从 Polymarket CLOB 获取每个 outcome token 的 order book 深度，提取 best bid/ask、spread、spread%、2% 档位深度和 top 5 挂单，作为高可信度市场微结构证据。这对齐了 Predict-Raven 的 `orderbook.ts` 研究步骤（BUY side, medium urgency, 5 levels），使 AI 能看到真实流动性分布和执行成本，避免正 edge 被交易成本吃掉。
- 证据收集阶段会对 resolution source URL 做实时访问验证（从 market data、page-scrape metadata 或 resolution rules 文本中提取 URL），获取官方数据源的当前真实状态作为概率估算的硬约束输入。这对齐了 Predict-Raven SKILL.md 的 A0 模块（Resolution Source 实时查验 — 必须在 AI 推理之前执行），防止基于过时事实做出交易决策。数据源不可访问时返回"resolution source 当前状态未确认"并降低相关主张权重。
- 证据收集阶段包含 5 个领域专用研究适配器（体育赛程、宏观日历、天气数据、链上指标、公司财报），按 market category/question 自动激活，从公开搜索引擎获取领域相关证据。这对齐了 Predict-Raven 的领域专用数据源机制。
- AI candidate triage 输出的 `evidence_gaps` 会被 EvidenceGapRuntime 自动处理：按 gap 类别（news, social, expert, official, schedule, financial, on-chain, weather）自动搜索外部公开信息填补证据空白，生成带 freshness/relevance/source_quality 元数据的证据项传给概率估算。这对齐了 Predict-Raven 的自动证据扩展机制。
- 证据收集阶段在规则适配器完成后，调用 AI Evidence Research runtime（EvidenceResearchProvider，60 秒超时）：AI 接收已收集的全部证据和市场上下文，评估证据充分性（sufficient/needs_more/critical_gap），识别具体信息缺口，输出最多 5 个定向搜索查询（含 category、rationale、priority），由代码执行搜索后将结果合并到证据池传给概率估算。失败时回退到 legacy gap-fill。这对齐了 Predict-Raven 的 AI-in-the-loop 证据研究流水线，AI 主动指导研究方向而非被动接收适配器输出。
- `monitor run` 开始时会调用 AI Topic Discovery runtime（60 秒超时），让 provider 基于当前新闻、体育、宏观、加密等外部信号主动发现可能被规则预筛遗漏的新话题，并输出 Polymarket 搜索关键词映射。这对齐了 Predict-Raven 的 AI 外部信号话题发现能力。
- Topic Discovery 完成后，SemanticDiscoveryRuntime 会自动将发现的话题 search_terms 在 Polymarket 全市场列表中做 token-based 匹配、语义聚类和重复事件合并，新发现的市场加入候选池参与后续 pre-screen 和 triage。这对齐了 Predict-Raven 的全市场语义发现和机会地图能力。
- 概率校准层（ProbabilityCalibrationLayer）在 AI 概率估算之后、决策引擎之前运行，根据 confidence、researchability、information_advantage、evidence freshness、evidence count、liquidity、days-to-resolution 和 pre-screen 分类对原始概率做 shrinkage 校准（向 0.5 先验收缩），输出 rawProbability、calibratedProbability 和 calibrationReasons。这对齐了 Predict-Raven 的概率校准系统基础。
- 动态校准存储（DynamicCalibrationStore）记录每次预测结果和实际结算，按概率桶计算 Brier score，生成动态校准曲线（isotonic regression 近似）；支持按 category、confidence 维度的分维度校准，数据不足时回退到静态校准。这对齐了 Predict-Raven 的 Brier score 反馈环动态校准机制。
- 收益归因引擎（ReturnAttributionEngine）将每笔平仓的最终 P&L 分解为 7 个独立因子：prediction_error、market_price_change、fee_impact、slippage_impact、position_size_impact、holding_period_impact 和 exit_decision_impact，每个因子以 USD 贡献量化，支持跨仓位聚合统计。这对齐了 Predict-Raven 的收益归因系统。
- 候选排序增加了 Downside Risk Ranking（DownsideRiskRanker）：在原有 monthly return / net edge / Kelly 排序基础上，计算每个机会的下行风险评分（概率加权最大亏损、流动性风险、时间风险、价差风险、edge 质量）和跨轮资金分配惩罚（类别集中度、事件重复、可用资本比例、边际递减），输出 risk-adjusted score 用于最终排序。这对齐了 Predict-Raven 的 downside risk ranking 和 cross-round capital allocation。
- 预测效果评估追踪器（PredictionPerformanceTracker）记录每次预测和平仓结果，每 N 轮（默认 5 轮）在 monitor log 中输出完整评估报表：包括 hit rate、Brier score、概率校准偏差（predicted vs actual by bucket）、按 confidence/category 分组的胜率和收益、edge 预测精度（预测 edge vs 实际 return）。这对齐了 Predict-Raven 的预测效果评估和持续改进反馈环。
- provider prompt 要求区分盘口价格和独立证据，并在 `reasoning_summary` / `uncertainty_factors` 中说明可研究性、外部证据充分性和相对盘口的信息优势；不可研究或信息优势不足时必须降为 `low` confidence。
- `paper` 和 `live` 模式的 monitor artifact 均保留 `candidate-triage.json` 和完整 per-round 结构化目录；`paper` 模式额外把 `candidate.prescreen`、`candidate.prescreen_summary`、`candidate.triage`、`candidate.triage_summary`、`candidate.triage_failed`、`topic_discovery.completed`、`topic_discovery.failed`、`semantic_discovery.completed`、`calibration.applied`、`calibration.dynamic`、`performance.report`、`performance.calibration`、`performance.by_confidence`、`performance.edge_accuracy` 追加到人类可读日志。
- `live` 模式下单前仍必须通过 env preflight、余额/allowance 检查、账户审计、`confirm LIVE` 和 `RiskEngine`。
- V2 动态费率查询：`DynamicFeeService` 通过 CLOB API `GET /markets/{conditionId}` 获取市场实时 `{ feeRate, exponent }` 参数（1h 内存 Map 缓存），在决策引擎计算 fee/edge/Kelly/monthly return 之前预取并传入 `buildPulseTradePlan`，替代纯静态费率表；失败时自动回退到 `lookupCategoryFeeParams` 静态查找。这对齐了 Predict-Raven 的 `fetchDynamicFeeParams`（V2 SDK `getClobMarketInfo` + 1h cache + null fallback）。
- 费率验证：`DynamicFeeService.verifyAndLog` 在 `LiveBroker.submit` 下单前对比静态 fee params 与 CLOB API 返回的动态 fee params（feeRate 和 exponent），偏差超 `PULSE_FEE_VERIFY_THRESHOLD` 时记录到 `{artifactDir}/fee-discrepancies.jsonl`；验证失败不阻断下单。这对齐了 Predict-Raven 的 `verifyFeeEstimate` + `logFeeDiscrepancyIfNeeded`。

- 滑点限制下单（order book walk）：`RiskEngine.evaluate` 接受预取的 order book（通过 `PolymarketMarketSource.getOrderBook` 获取 CLOB `/book` 端点），在风控层调用 `walkAskBook` 遍历 ask book 计算在最大 `RISK_MAX_PRICE_IMPACT_PCT`（默认 4%）price impact 内可买入的最大 notional，作为 `approvedUsd` 的硬约束上限（`orderbookSlippageCapUsd`）；获取失败时跳过不阻断。这对齐了 Predict-Raven 的 `computeMaxBuyNotionalWithinSlippage`。
- 交易所最小订单验证：`RiskEngine.evaluate` 在最终 adjusted notional 确定后，通过 `validateMinOrderSize` 检查 `shares = amountUsd / bestAsk >= exchange minOrderSize`（从 CLOB `/book` 响应中读取 `min_order_size`），不满足时以 `below_exchange_minimum_order_size` 阻断下单。这对齐了 Predict-Raven 的交易所最小订单检查。

PolyPulse 当前没有实现的完整 Predict-Raven 能力：

- 缺少跨轮资金占用的动态优化（当前是单轮内按 risk-adjusted score 排序后顺序分配）。
- 缺少历史回放机制：用真实结算市场和已产生 artifact 比较不同参数组合对收益的影响。
- 平仓逻辑差异（三层退出策略）：

| 退出层 | Predict-Raven | PolyPulse 当前 |
| --- | --- | --- |
| **Position Review（每轮）** | 基于 edge 做梯度退出：强正 edge(>0.05) hold、弱正 edge(0~0.05) hold+人工复核标记、微负 edge(-0.05~0) 减仓 50%、显著负 edge(<-0.05) 全部平仓、对立信号直接平仓 | 简化为二元判断：edge > 0 hold，edge ≤ 0 或方向反转直接全部平仓（`edge_reversal_or_no_trade`）；无减仓 50%、无人工复核标记 |
| **Stop-Loss（独立守护）** | 独立进程每 30 秒轮询，unrealized loss > 30% VWAP 成本时市价卖出 | 集成在每轮 round 内检查，`RISK_MAX_POSITION_LOSS_PCT`（默认 50%）触发平仓；非独立进程，依赖 round 间隔 |
| **Auto-Redeem（结算）** | 每轮开始扫描已结算市场，调用 Polygon ConditionalTokens 合约自动赎回 USDC | 仅检测 `closed=true` 后以 mark-to-market 价格平仓记入内存账本；无合约交互 |
| **额外退出信号** | 无 | `near_full_value`（价格 ≥ 0.99）和 `near_zero_value`（价格 ≤ 0.01）提前退出，不等结算 |

**待办项**（直接影响预测成功率、概率校准和净收益率；所有项保持 live-only，读取当前 Polymarket 真实市场）：

- [x] ~~增加 AI 外部话题发现~~：已实现 `TopicDiscoveryProvider`，provider 基于新闻/体育/宏观/链上等外部信号提出可映射 Polymarket 的新话题（60s 超时，失败不阻断）。已通过 SemanticDiscoveryRuntime 自动搜索匹配 Polymarket 市场并加入候选池。
- [x] ~~按 `CandidateTriage.evidence_gaps` 自动扩展外部证据抓取~~：已实现 `EvidenceGapRuntime`，按 gap 类别（news, social, expert, official, schedule, financial, on-chain, weather）自动搜索外部公开信息，生成带 freshness/relevance/source_quality 元数据的证据项。
- [x] ~~增加市场类别专用研究适配器~~：已实现 5 个领域适配器（SportsScheduleAdapter, MacroCalendarAdapter, WeatherDataAdapter, OnChainDataAdapter, FinancialDataAdapter），按市场 category/question 自动激活。
- [x] ~~增加概率校准层~~：已实现 `ProbabilityCalibrationLayer`，按 confidence、researchability、information_advantage、evidence freshness/count、liquidity、days-to-resolution 和 pre-screen 分类做 shrinkage 校准，输出 rawProbability、calibratedProbability 和 calibrationReasons。
- [x] ~~Topic Discovery 结果自动匹配~~：已实现 `SemanticDiscoveryRuntime`，把 TopicDiscoveryProvider 返回的 search_terms 在全市场做 token-based 匹配、语义聚类和重复事件合并，新市场加入候选池。
- [x] ~~全市场语义发现~~：通过 SemanticDiscoveryRuntime 实现对全市场的跨页语义聚类、主题扩展和重复事件合并。
- [x] ~~动态概率校准~~：已实现 `DynamicCalibrationStore`，用历史预测结果建立 Brier score 反馈环，按概率桶生成动态校准曲线（isotonic regression 近似），支持 category/confidence 维度分维度校准。
- [x] ~~增加收益归因 artifact~~：已实现 `ReturnAttributionEngine`，将 P&L 分解为 prediction_error、market_price_change、fee_impact、slippage、position_size、holding_period 和 exit_decision 7 个因子。
- [x] ~~进一步改进收益排序~~：已实现 `DownsideRiskRanker`，在 monthly return / net edge / Kelly 排序基础上加入下行风险评分（概率加权最大亏损、流动性风险、时间风险、价差风险、edge 质量）和跨轮资金分配惩罚（类别集中度、事件重复、可用资本），输出 risk-adjusted score 用于最终排序。
- [x] ~~建立预测效果评估报表~~：已实现 `PredictionPerformanceTracker`，每 N 轮在 monitor log 中输出完整评估：hit rate、Brier score、校准偏差、按 confidence/category 分组胜率、edge 精度。
- [ ] 将扫描结果升级为收益导向的 pulse snapshot：记录 `totalFetched`、`selectedCandidates`、category/tag 统计、过滤原因、risk flags、快照年龄，用于追踪哪些筛选条件提升命中率和收益率。
- [ ] 优化候选筛选：用流动性、24h volume、spread、结束时间、category/tag、证据新鲜度、AI triage priority_score、pre-screen 分类和历史命中率过滤低质量市场，并记录每个过滤维度对收益率的贡献。
- [ ] 把 order book 证据中的 spread、深度和滑点估算纳入 expected return 计算（当前 order book 只作为 AI 证据输入），避免正 edge 被交易成本吃掉；低于净收益阈值的机会应标记为 skip。
- [x] ~~增加滑点限制下单（order book walk）~~：已实现 `walkAskBook` 纯函数模块（`src/core/orderbook-walk.js`），`RiskEngine` 在风控层预取 order book 后遍历 ask book 计算最大 4% price impact 内的 notional 上限，作为 `approvedUsd` 硬约束。对齐 Predict-Raven 的 `computeMaxBuyNotionalWithinSlippage`。
- [x] ~~增加交易所最小订单验证~~：已实现 `validateMinOrderSize`，在 `RiskEngine` 最终 adjusted 确定后检查 `shares = amountUsd / bestAsk >= minOrderSize`（从 CLOB `/book` 获取），不满足时以 `below_exchange_minimum_order_size` 阻断。对齐 Predict-Raven 的交易所最小订单检查。
- [x] ~~增加 V2 动态费率查询~~：已实现 `DynamicFeeService`，通过 CLOB API `GET /markets/{conditionId}` 获取市场实时费率参数（1h 内存缓存），在决策引擎计算 fee/edge/Kelly 之前预取并传入，失败时回退到静态费率表。对齐 Predict-Raven 的 `fetchDynamicFeeParams`。
- [x] ~~增加费率验证~~：已实现 `DynamicFeeService.verifyAndLog`，下单前通过 CLOB API 获取动态费率参数，对比静态估算的 feeRate/exponent，偏差超阈值时记录 `fee-discrepancies.jsonl` 并用动态值覆盖。对齐 Predict-Raven 的 `verifyFeeEstimate`。
- [ ] 增加已有仓位收益复核：基于 avg cost、best bid、unrealized PnL、stop-loss 距离和刷新后的 calibrated edge，决定 hold/reduce/close，以提升实际收益率和降低回撤。
- [ ] 用历史真实结算市场和已产生 artifact 做回放评估，比较不同 provider、PULSE_* 参数、筛选条件和排序规则对命中率、净收益率、最大回撤的影响。

### 开仓金额计算和风控逻辑

开仓金额由 **DecisionEngine**（收益计算）和 **RiskEngine**（风控约束）两阶段确定，AI 不参与金额决策。

#### 第一阶段：DecisionEngine 计算建议金额

1. **双侧评估**：对 Yes 和 No 两侧各自独立执行 steps 2-7 的完整计算。
2. **计算 grossEdge**：`grossEdge = aiProbability - marketImpliedProbability`。
3. **计算 fee**：根据市场类别查找费率参数（动态费率优先，静态费率回退），`entryFeePct = feeRate × (price × (1 - price))^exponent`。
4. **计算 netEdge**：`netEdge = grossEdge - entryFeePct`。
5. **Quarter Kelly sizing**：
   ```
   fullKellyPct = max(0, (aiProb - marketProb) / (1 - marketProb))
   quarterKellyPct = fullKellyPct / 4
   suggestedNotionalUsd = bankrollUsd × quarterKellyPct
   ```
   其中 `bankrollUsd` = 组合总权益（`portfolio.totalEquityUsd`）。
6. **Monthly return**：`monthlyReturn = netEdge / (daysToResolution / 30)`，其中 `daysToResolution` 取 `market.endDate` 距当前的天数（无 endDate 时回退 180 天）。同样的 net edge，短期市场月化收益更高。
7. **开仓条件**：`quarterKellyUsd > 0 && netEdge > 0 && netEdge >= PULSE_MIN_NET_EDGE` 时 `action=open`，否则 `skip`。
8. **选择方向**：两侧均计算完毕后，选 `monthlyReturn` 最高且 `action=open` 的方向作为最终候选。

DecisionEngine 输出的 `suggestedNotionalUsd` 是风控前的建议金额上限。

#### 第二阶段：RiskEngine 逐层约束

RiskEngine 对 `suggestedNotionalUsd` 和 `requestedUsd`（= `MONITOR_MAX_AMOUNT_USD` 或 `MIN_TRADE_USD`）取较小值后，按以下顺序逐层缩减：

| 约束层 | 环境变量 | 计算方式 | 作用 |
| --- | --- | --- | --- |
| 单笔上限 | `MAX_TRADE_PCT` | `portfolioEquity × maxTradePct` | 单笔不超过总资金的 N% |
| 总敞口上限 | `MAX_TOTAL_EXPOSURE_PCT` | `portfolioEquity × maxTotalExposurePct - currentExposure` | 所有持仓不超过总资金的 N% |
| 事件敞口上限 | `MAX_EVENT_EXPOSURE_PCT` | `portfolioEquity × maxEventExposurePct - eventExposure` | 同一事件不超过总资金的 N% |
| 流动性上限 | `LIQUIDITY_TRADE_CAP_PCT` | `market.liquidityUsd × liquidityTradeCapPct` | 单笔不超过市场流动性的 N% |
| 滑点上限 | `RISK_MAX_PRICE_IMPACT_PCT` | `walkAskBook` 遍历 ask book，计算 4% price impact 内的最大 notional | 防止滑点吃掉 edge |
| 交易所最小单 | `RISK_EXCHANGE_MIN_ORDER_CHECK` | `shares = amountUsd / bestAsk >= minOrderSize` | 不满足则阻断 |
| 最小交易金额 | `MIN_TRADE_USD` | 约束后金额 < `MIN_TRADE_USD` 则阻断 | 避免过小订单 |

#### 阻断检查（任一触发则 `approvedUsd = 0`）

| 阻断条件 | 说明 |
| --- | --- |
| `system_paused` / `system_halted` | 系统级暂停或回撤触发停机 |
| `drawdown_halt_threshold_exceeded` | 组合回撤超 `DRAWDOWN_HALT_PCT` |
| `decision_action_*_not_executable` | DecisionEngine 输出非 `open`（如 `skip`） |
| `market_closed` / `market_inactive` / `market_not_tradable` | 市场已关闭或不可交易 |
| `above_max_position_count` | 持仓数已达 `MAX_POSITION_COUNT` |
| `liquidity_unavailable` | 市场无流动性数据 |
| `below_exchange_minimum_order_size` | 低于交易所最小下单量 |
| `below_min_trade_usd` / `adjusted_notional_below_min_trade_usd` | 金额低于最小交易门槛 |
| `no_risk_budget_available` | 所有约束层缩减后金额 ≤ 0 |
| `live_requires_confirm_live` | live 模式缺少 `--confirm LIVE` |
| `live_preflight_failed` | env 配置校验未通过 |
| `insufficient_live_collateral` | 真实余额不足 |
| `insufficient_live_allowance` | 真实 allowance 不足 |

#### 非阻断警告（记录但不阻止下单）

| 警告 | 触发条件 |
| --- | --- |
| `ai_confidence_below_minimum` | AI 置信度低于 `MIN_AI_CONFIDENCE`（pulse-direct 模式下为 warning） |
| `insufficient_evidence` | 证据不足（pulse-direct 模式下为 warning） |
| `market_data_stale` | 市场数据超 `MARKET_MAX_AGE_SECONDS`（pulse-direct 模式下为 warning） |
| `position_loss_limit_triggered` | 某已有仓位亏损超 `MAX_POSITION_LOSS_PCT` |

#### 最终金额

```
approvedUsd = min(
  MONITOR_MAX_AMOUNT_USD,                    ← 环境变量配置的单笔硬上限
  suggestedNotionalUsd,                      ← Quarter Kelly 建议仓位 = bankroll × quarterKellyPct
  portfolioEquity × MAX_TRADE_PCT,           ← 单笔不超过总资金的固定比例
  totalExposureRoom,                         ← 总敞口上限 - 当前所有持仓总价值
  eventExposureRoom,                         ← 事件敞口上限 - 同一事件已有持仓价值
  liquidityCapUsd,                           ← 市场流动性 × LIQUIDITY_TRADE_CAP_PCT，防市场冲击
  orderbookSlippageCapUsd,                   ← ask book 在 4% price impact 内可买入的最大金额
  liveCollateral,                            ← 真实钱包 CLOB 可用保证金余额
  liveAllowance                              ← 真实钱包对 CLOB 合约的授权额度
)
```

`approvedUsd` 即为实际提交的订单金额。阻断检查任一不通过时为 0。

### Monitor 候选去重（已持仓市场处理）

`buildCandidates()` 对每个扫描到的市场执行两项去重检查，确保不会对同一话题重复开仓：

1. **`tradedByMonitor`** — 检查 `monitorState.tradedMarkets`，即本轮 monitor 生命周期内已经交易过的市场。命中时标记 `already_traded_market_or_event`，跳过。
2. **`heldInPortfolio`** — 检查当前组合中是否已持有同 `marketId`、`marketSlug`、`eventId` 或 `eventSlug` 的仓位。命中时标记 `existing_position_market_or_event`，跳过。

匹配粒度是 **event 级别**：同一事件下的不同子市场（outcome token）也会被跳过（通过 `eventId`/`eventSlug` 匹配）。被标记的候选 `selected: false`，不进入后续 prescreen、triage、prediction 和下单流程。

### 一次性验收 vs 持续 Monitor

一次性验收（`scripts/acceptance.js`）和持续 monitor（`monitor run --loop`）共用同一套内部逻辑（scan → prescreen → triage → evidence → prediction → risk → execution），但状态模型和输出完全不同：

| 维度 | 一次性验收 | 持续 Monitor |
| --- | --- | --- |
| 轮次 | 1 轮，运行后退出 | 无限循环或 N 轮，间隔 `MONITOR_INTERVAL_SECONDS` |
| 仓位持久性 | 不持久，round 结束即丢 | 内存账本跨轮持久：开仓、持有、平仓都在同一进程内存中累积 |
| 仓位复核 | 仅对已有仓位做一次 mark-to-market | 每轮对所有持仓做 mark-to-market + 重新预测，决定 hold/reduce/close |
| 胜率计算 | 无（单轮无平仓结算） | 有：`wins / (wins + losses)`，每次平仓时更新 |
| 输出 | `runtime-artifacts/acceptance-runs/<ts>/step1-7.stdout.log` + `summary.json` | 追加写入 `MONITOR_LOG_PATH` + per-round `runtime-artifacts/monitor/<date>/<run-slug>/` |
| runtime-artifacts | 有：per-round 目录 + provider runtime 日志 | 有：完全相同的结构化 artifact |

持续 monitor 不是"每 N 分钟执行一遍验收"，而是一个**有状态的交易循环**。关键区别：验收是无状态的 pipeline 健康检查；monitor 是有仓位、有资金、有 PnL 积累的连续交易系统。

### 仓位生命周期和平仓逻辑

PolyPulse 的平仓逻辑参考 Predict-Raven 的三层退出策略，但做了简化实现：

**Predict-Raven 的退出策略**（三层）：
1. **Position Review Module**（每轮 pulse:live cycle）：基于刷新后的 edge 做梯度退出 —— 强正 edge 持有、弱正 edge 持有但标记人工复核、微负 edge 减仓 50%、显著负 edge 全部平仓、对立信号直接平仓。
2. **Stop-Loss Monitor**（独立守护进程，每 30 秒）：纯价格驱动，unrealized loss > 30% VWAP 入场成本时自动市价卖出，不涉及 AI 判断。
3. **Auto-Redeem**（每轮开始时）：扫描已结算市场，调用 Polygon ConditionalTokens 合约自动赎回 USDC。

**PolyPulse 当前实现**（简化版）：

| 平仓触发 | 条件 | 对应 Predict-Raven |
| --- | --- | --- |
| `market_closed` | 市场 `closed=true`（已结算） | Auto-Redeem |
| `near_full_value` | `currentPrice >= 0.99` | PolyPulse 独有 |
| `near_zero_value` | `currentPrice <= 0.01` | PolyPulse 独有 |
| `stop_loss` | 亏损 > `RISK_MAX_POSITION_LOSS_PCT`（默认 50%） | Stop-Loss Monitor |
| `edge_reversal_or_no_trade` | 重新预测后 edge ≤ 0 或方向反转 | Position Review Module |

**胜率计算**（`MonitorLedger.statistics()`）：
```
realizedPnlUsd = currentValueUsd - costUsd
wins = closedTrades.filter(t => t.realizedPnlUsd > 0).length
losses = closedTrades.filter(t => t.realizedPnlUsd < 0).length
winRate = wins / (wins + losses)
```

胜率在 log 中的体现：每次平仓时 `close.filled` 事件带 `realized_pnl_usd` 和累计 `win_rate`；每轮 `round.end` 汇报 `wins`、`losses`、`win_rate`；每 N 轮 `performance.report` 输出完整评估报表。

**是否可以不平仓（buy and hold until settlement）**：可以。设置环境变量 `POSITION_HOLD_UNTIL_SETTLEMENT=true` 即可关闭所有主动平仓逻辑（stop-loss、near_full_value、near_zero_value、edge_reversal），仓位仅在市场结算（`market_closed`）时退出。该模式下 `closeOnDecision` 也会被跳过，所有已开仓位一律持有到期。注意：Predict-Raven 早期版本曾使用过"全部 hold 不卖"的策略，后来被明确替换为主动仓位复核，原因是不平仓会导致资金被低质量仓位长期锁定、无法及时止损或释放资金给更好的机会。

### 持续 Monitor 的 runtime-artifacts

`paper` 和 `live` 模式下，持续 monitor 生成**完全相同的** per-round 结构化 artifact：
- `runtime-artifacts/monitor/<date>/<run-slug>/` 目录，含 markets.json, candidates.json, candidate-triage.json, decisions.json, risk.json, orders.json, summary.md
- `runtime-artifacts/codex-runtime/<ts>/runtime-log.md` — 每次 AI 调用的完整 prompt/output 归档
- 每个候选的 `predictions/<market-slug>/evidence.json, estimate.json, decision.json`

两种模式的唯一区别是 `paper` 模式额外追加写入 `MONITOR_LOG_PATH` 人类可读日志（含仓位、PnL、胜率等内存账本状态）。

### Monitor Log 格式（paper / live 通用）

`MONITOR_LOG_PATH` 是人类可读追加日志，不是稳定的机器解析协议。每次启动 `trade once` 或 `monitor run` 都会先写入 session header：

```text
================================================================================
[2026-05-06T15:26:35.807Z] monitor session started
execution_mode=paper
initial_cash_usd=1000
market_source=polymarket
gamma=https://gamma-api.polymarket.com
================================================================================
```

header 字段含义：

| 字段 | 含义 |
| --- | --- |
| `execution_mode` | 执行模式；`paper` 不提交真实订单，`live` 提交真实订单。 |
| `initial_cash_usd` | 本次进程内内存账本的初始现金，来自真实钱包余额。 |
| `market_source` | 市场源；当前只支持 `polymarket`。 |
| `gamma` | 当前读取真实 Polymarket market metadata 的 Gamma API host。 |

普通日志行格式：

```text
[ISO_TIMESTAMP] event.name | key=value key=value ...
```

通用字段含义：

| 字段 | 含义 |
| --- | --- |
| `ISO_TIMESTAMP` | 日志写入时间，UTC ISO 8601。 |
| `event.name` | 本行事件类型，例如 `round.start`、`prediction`、`risk`、`open.filled`。 |
| `key=value` | 事件字段。字段之间用空格分隔；`question` 等长文本会用 JSON string 形式写出，日志主要用于人工阅读。 |
| `none` | 没有对应内容，例如没有风控阻断、没有 warning 或没有错误。 |
| `n/a` | 该字段当前不适用或没有可用值。 |

事件和字段：

| 事件 | 字段 | 含义 |
| --- | --- | --- |
| `round.start` | `run_id` | 本轮 monitor run ID。 |
| `round.start` | `limit` | 本轮扫描候选数量限制；`default` 表示使用 `.env` 中的 `MARKET_SCAN_LIMIT`。 |
| `round.start` | `max_amount_usd` | 本轮单次模拟开仓的最大美元金额。 |
| `round.start` | `cash_usd` | 本轮开始时模拟账本现金。 |
| `round.start` | `open_positions` | 本轮开始时模拟账本中的未平仓数量。 |
| `topics.fetched` | `source` | 市场读取来源；实时读取通常是 `polymarket-gamma`。 |
| `topics.fetched` | `markets` | 本轮返回给 monitor 的候选市场数量。 |
| `topics.fetched` | `total_fetched` | 从 Gamma API 原始拉取并归一化前后的扫描规模诊断。 |
| `topics.fetched` | `risk_flags` | 市场扫描风险标记，例如结果不足、部分失败、低流动性过滤；`none` 表示无标记。 |
| `topics.candidate` | `rank` | 本轮前 5 个候选的展示排序。 |
| `topics.candidate` | `market` | Polymarket market slug。 |
| `topics.candidate` | `liq` | 归一化后的市场流动性美元值。 |
| `topics.candidate` | `vol24h` | 24 小时成交量美元值。 |
| `topics.candidate` | `question` | 市场问题文本。 |
| `position.review_skipped` | `market` | 被跳过复核的持仓 market slug 或 market ID。 |
| `position.review_skipped` | `reason` | 跳过原因，例如 `market_not_found`。 |
| `mark_to_market` | `open_positions` | mark-to-market 后仍未平仓的数量。 |
| `mark_to_market` | `unrealized_pnl_usd` | 当前未实现盈亏美元值。 |
| `mark_to_market` | `total_equity_usd` | 当前模拟总权益，等于现金加未平仓当前价值。 |
| `positions.reviewed` | `run_id` | 完成持仓复核的 run ID。 |
| `positions.reviewed` | `open_positions` | 复核后仍未平仓数量。 |
| `positions.reviewed` | `closed_positions` | 本进程内累计已平仓交易数量。 |
| `candidate` | `market` | 正在评估的 market slug。 |
| `candidate` | `selected` | 是否进入预测和风控链路。 |
| `candidate` | `reasons` | 未选中原因，例如 `watchlist_not_matched`、`blocklisted`、`already_traded_market_or_event`、`existing_position_market_or_event`、`ai_prescreen_skip`、`ai_triage_reject`；`none` 表示进入候选。 |
| `candidate.prescreen` | `market` | 完成 AI 信息优势预筛的 market slug。 |
| `candidate.prescreen` | `action` | AI 预筛分类：`TRADE` 或 `SKIP`。 |
| `candidate.prescreen` | `reason` | AI 预筛的一句话分类原因。 |
| `candidate.prescreen_summary` | `total` | 本轮 AI 预筛覆盖的候选总数。 |
| `candidate.prescreen_summary` | `trade` | 被分类为 TRADE 的候选数。 |
| `candidate.prescreen_summary` | `skip` | 被分类为 SKIP 的候选数。 |
| `candidate.prescreen_summary` | `elapsed_ms` | 预筛用时毫秒。 |
| `candidate.prescreen_failed` | `error` | AI 预筛失败原因；失败时全部候选保留为 TRADE。 |
| `candidate.triage` | `market` | 完成 AI triage 的 market slug。 |
| `candidate.triage` | `action` | AI triage 建议：`prioritize`、`watch`、`defer` 或 `reject`。 |
| `candidate.triage` | `score` | AI triage 的研究/执行优先级分数；不是概率，也不是交易信号。 |
| `candidate.triage` | `researchability` | AI 对候选可研究性的判断：`low`、`medium` 或 `high`。 |
| `candidate.triage` | `information_advantage` | AI 对相对盘口潜在信息优势的判断：`low`、`medium` 或 `high`。 |
| `candidate.triage` | `cluster` | AI 给候选分配的语义主题。 |
| `candidate.triage` | `gaps` | 后续应补充的外部证据类别；`none` 表示未列出。 |
| `candidate.triage_summary` | `assessments` | 本轮 AI triage 覆盖的候选数。 |
| `candidate.triage_summary` | `clusters` | 本轮 AI triage 输出的主题簇数量。 |
| `candidate.triage_summary` | `research_gaps` | 本轮候选池层面的共性证据缺口。 |
| `candidate.triage_failed` | `error` | AI triage 子进程失败原因；失败时 monitor 会保留规则预筛候选继续执行。 |
| `topic_discovery.completed` | `topics` | AI Topic Discovery 发现的话题数量。 |
| `topic_discovery.completed` | `elapsed_ms` | Topic Discovery 用时毫秒。 |
| `topic_discovery.completed` | `categories` | 发现话题覆盖的类别列表。 |
| `topic_discovery.failed` | `error` | AI Topic Discovery 失败原因；失败不阻断后续流程。 |
| `semantic_discovery.completed` | `matched` | SemanticDiscoveryRuntime 匹配到的新市场数量。 |
| `semantic_discovery.completed` | `clusters` | 语义聚类数量。 |
| `semantic_discovery.completed` | `duplicates` | 被去重的重复事件数量。 |
| `semantic_discovery.completed` | `added_to_pool` | 实际加入候选池的新市场数。 |
| `calibration.applied` | `market` | 应用校准的 market slug。 |
| `calibration.applied` | `raw_probability` | 校准前的原始 AI 概率。 |
| `calibration.applied` | `calibrated_probability` | 校准后的概率。 |
| `calibration.applied` | `reasons` | 校准原因列表（shrinkage 因子）。 |
| `calibration.dynamic` | `market` | 应用动态校准的 market slug。 |
| `calibration.dynamic` | `calibrated` | 动态校准后的概率值。 |
| `calibration.dynamic` | `dimension` | 使用的校准维度（global、category、confidence）。 |
| `calibration.dynamic` | `brier_score` | 该维度的历史 Brier score。 |
| `performance.report` | `resolved` | 已结算的预测数量。 |
| `performance.report` | `win_rate` | 已结算交易的胜率。 |
| `performance.report` | `brier_score` | 整体 Brier score。 |
| `performance.report` | `total_pnl_usd` | 累计已实现盈亏美元值。 |
| `performance.report` | `avg_return_pct` | 平均每笔交易回报率。 |
| `performance.report` | `best_category` | 盈利最多的市场类别。 |
| `performance.report` | `worst_category` | 亏损最多的市场类别。 |
| `performance.calibration` | `bucket` | 概率桶范围（如 0-0.2）。 |
| `performance.calibration` | `count` | 该桶内的预测数量。 |
| `performance.calibration` | `avg_predicted` | 该桶内平均预测概率。 |
| `performance.calibration` | `avg_actual` | 该桶内实际发生率。 |
| `performance.calibration` | `gap` | 预测与实际的偏差。 |
| `performance.by_confidence` | `confidence` | 置信度级别（low/medium/high）。 |
| `performance.by_confidence` | `count` | 该置信度的交易数量。 |
| `performance.by_confidence` | `win_rate` | 该置信度的胜率。 |
| `performance.by_confidence` | `avg_return_pct` | 该置信度的平均回报率。 |
| `performance.by_confidence` | `total_pnl_usd` | 该置信度的累计盈亏。 |
| `performance.edge_accuracy` | `mean_abs_error` | 预测 edge 与实际 return 的平均绝对误差。 |
| `performance.edge_accuracy` | `avg_predicted_edge` | 平均预测 net edge。 |
| `performance.edge_accuracy` | `avg_actual_return` | 平均实际回报率。 |
| `candidate.ranked` | `rank` | 完成 AI 概率估算后，本轮执行排序名次。 |
| `candidate.ranked` | `market` | 被排序的 market slug。 |
| `candidate.ranked` | `action` | 代码基于 AI 概率和盘口计算出的候选动作。 |
| `candidate.ranked` | `confidence` | AI provider 输出的置信度。 |
| `candidate.ranked` | `monthly_return` | 排序使用的月化收益估计；不适用时为 `n/a`。 |
| `candidate.ranked` | `net_edge` | 排序使用的净 edge；不适用时为 `n/a`。 |
| `candidate.ranked` | `risk_adjusted_score` | DownsideRiskRanker 计算的风险调整后综合得分（0-1，越高越好）。 |
| `candidate.ranked` | `downside_score` | 下行风险评分（0-1，越高越危险）。 |
| `candidate.ranked` | `reason` | 跳过原因或 `none`。 |
| `prediction` | `phase` | 预测阶段；`open-scan` 表示开仓扫描，`position-review` 表示已有持仓复核。 |
| `prediction` | `market` | market slug。 |
| `prediction` | `ai_probability` | AI provider 给出的 Yes outcome 概率。 |
| `prediction` | `confidence` | AI provider 置信度：`low`、`medium` 或 `high`。 |
| `prediction` | `side` | 代码基于概率和盘口选择的方向；二元市场通常是 `yes` 或 `no`。 |
| `prediction` | `market_probability` | 当前盘口隐含概率。 |
| `prediction` | `edge` | AI 概率与盘口隐含概率的原始差值。 |
| `prediction` | `net_edge` | 扣除 fee/slippage 口径后的净 edge。 |
| `prediction` | `quarter_kelly_pct` | 1/4 Kelly 建议仓位比例。 |
| `prediction` | `monthly_return` | 按到期时间折算的月化收益估计。 |
| `prediction` | `action` | 决策动作；`open` 表示具备开仓候选，其他值表示跳过或不执行。 |
| `risk` | `market` | market slug。 |
| `risk` | `allowed` | RiskEngine 是否允许本次模拟执行。 |
| `risk` | `approved_usd` | 风控批准的美元金额；阻断时为 `0`。 |
| `risk` | `adjusted_notional` | 应用仓位、流动性、总敞口、事件敞口等限制后的名义金额。 |
| `risk` | `blocks` | 阻断原因，例如 `live_requires_confirm_live`、`insufficient_live_collateral`、`market_not_tradable`、`adjusted_notional_below_min_trade_usd`；`none` 表示未阻断。 |
| `risk` | `warnings` | 非阻断风险提示，例如 `ai_confidence_below_minimum`、`insufficient_evidence`、`market_data_stale`。 |
| `open.filled` | `market` | 模拟开仓 market slug。 |
| `open.filled` | `outcome` | 开仓 outcome 标签，例如 `Yes` 或 `No`。 |
| `open.filled` | `price` | 模拟成交价格，来自当前 outcome 的 bid/ask/implied/last price 回退链。 |
| `open.filled` | `size` | 模拟买入份额，约等于 `cost_usd / price`。 |
| `open.filled` | `cost_usd` | 本次模拟开仓消耗现金。 |
| `open.filled` | `cash_usd` | 开仓后的模拟现金余额。 |
| `open.filled` | `order_id` | 本地模拟订单 ID，以 `sim-log-` 开头；不是 Polymarket 真实订单 ID。 |
| `open.filled` | `end_date` | 市场到期时间（ISO 8601）；用于 dashboard 展示到期日。 |
| `open.filled` | `market_url` | Polymarket 市场页面 URL；用于 dashboard 生成可点击链接。 |
| `order.blocked` | `market` | 被阻断的 market slug。 |
| `order.blocked` | `status` | 阻断后的订单状态，通常是 `blocked`。 |
| `order.blocked` | `reason` | 订单未执行原因。 |
| `hold` | `market` | 持仓复核中的 market slug。 |
| `hold` | `outcome` | 当前持仓 outcome。 |
| `hold` | `current_price` | mark-to-market 后的当前价格。 |
| `hold` | `unrealized_pnl_usd` | 当前持仓未实现盈亏。 |
| `hold` | `reason` | 继续持有原因；例如 `edge_still_supports_position`。 |
| `close.filled` | `market` | 模拟平仓 market slug。 |
| `close.filled` | `outcome` | 平仓 outcome。 |
| `close.filled` | `reason` | 平仓原因：`market_closed`、`near_full_value`、`near_zero_value`、`stop_loss` 或 `edge_reversal_or_no_trade`。 |
| `close.filled` | `exit_price` | 模拟退出价格。 |
| `close.filled` | `proceeds_usd` | 平仓回收现金。 |
| `close.filled` | `realized_pnl_usd` | 本次平仓实现盈亏。 |
| `close.filled` | `cash_usd` | 平仓后的模拟现金余额。 |
| `close.filled` | `win_rate` | 本进程内已平仓交易的胜率；无已分胜负交易时为 `n/a`。 |
| `round.end` | `run_id` | 本轮 run ID。 |
| `round.end` | `status` | 本轮状态，通常是 `completed` 或 `failed`。 |
| `round.end` | `cash_usd` | 本轮结束时模拟现金。 |
| `round.end` | `equity_usd` | 本轮结束时模拟总权益。 |
| `round.end` | `open_positions` | 本轮结束时未平仓数量。 |
| `round.end` | `realized_pnl_usd` | 本进程内累计已实现盈亏。 |
| `round.end` | `unrealized_pnl_usd` | 本轮结束时未实现盈亏。 |
| `round.end` | `wins` | 本进程内盈利平仓次数。 |
| `round.end` | `losses` | 本进程内亏损平仓次数。 |
| `round.end` | `win_rate` | 本进程内平仓胜率；没有已分胜负平仓时为 `n/a`。 |
| `round.end` | `max_drawdown_usd` | 本进程内模拟权益相对高水位的最大回撤美元值。 |
| `round.end` | `errors` | 本轮错误摘要；`none` 表示无错误。 |

### 关键文档

- `docs/specs/product-requirements.md`
- `docs/specs/architecture.md`
- `docs/specs/risk-controls.md`
- `docs/specs/testing-plan.md`
- `docs/runbooks/server-deploy.md`
- `docs/runbooks/live-trading-checklist.md`
- `docs/testing.md`
- `docs/FINAL_ACCEPTANCE.md`
- `docs/KNOWN_LIMITATIONS.md`
- `docs/ROADMAP.md`
- `docs/memory/POLYPULSE_MEMORY.md`

### Codex live runtime 提示词

执行一次完整 `monitor run` pipeline，AI provider 会被调用 **5 类提示词**（每类对应一个 runtime）：

| 序号 | Runtime | 提示词用途 | 调用次数/轮 |
| --- | --- | --- | --- |
| 1 | `topic-discovery-runtime.js` | AI 话题发现：从外部信号发现被规则遗漏的话题 | 1 次 |
| 2 | `prescreen-runtime.js` | AI pre-screen：对候选池做 TRADE/SKIP 信息优势预判 | 1 次（批量） |
| 3 | `candidate-triage-runtime.js` | AI candidate triage：语义聚类、可研究性、证据缺口 | 1 次（批量） |
| 4 | `evidence-research-runtime.js` | AI 证据研究：评估证据充分性、指导定向搜索 | N 次（每个选中候选 1 次） |
| 5 | `codex-runtime.js` | AI 概率估算：估算事件发生概率 | N 次（每个选中候选 1 次） |

`predict` 和 `trade once` 只调用第 4、5 步（单市场：证据研究 + 概率估算 = 2 次 AI 调用）。

每个 runtime 文件顶部的 JSDoc 注释包含完整的中文提示词模板示例。具体参见：

| Runtime | 提示词模板位置 |
| --- | --- |
| `src/runtime/topic-discovery-runtime.js` | 文件顶部 JSDoc + `buildPrompt()` |
| `src/runtime/prescreen-runtime.js` | 文件顶部 JSDoc + `buildPrompt()` |
| `src/runtime/candidate-triage-runtime.js` | 文件顶部 JSDoc + `buildPrompt()` |
| `src/runtime/evidence-research-runtime.js` | 文件顶部 JSDoc + `buildPrompt()` |
| `src/runtime/codex-runtime.js` | 文件顶部 JSDoc + `buildPrompt()` |

所有 prompt 由各 runtime 的 `buildPrompt()` 函数动态生成，支持 `CODEX_SKILL_LOCALE=zh|en` 双语切换。实际命令形态：

```bash
codex exec \
  --skip-git-repo-check \
  -C <repoRoot> \
  -s read-only \
  --output-schema <tempDir>/<schema>.json \
  -o <tempDir>/provider-output.json \
  --color never \
  [-m <CODEX_MODEL>] \
  -
```

最后的 `-` 表示 prompt 通过 stdin 传入。Codex 的输出必须写成对应 JSON schema，并由代码解析、校验和归一化。Codex 不生成订单、不选择 broker 参数、不直接改写 token 或下单金额；交易方向、fee、net edge、quarter Kelly、monthly return、排序、batch cap 和最终风控都由代码计算。

## 使用方法

### Clone 与解密

本仓库使用 [git-crypt](https://github.com/AGWA/git-crypt) 加密 `.env` 文件。Clone 后需要 unlock 才能读取明文配置。

**安装 git-crypt：**

```bash
# macOS
brew install git-crypt

# Ubuntu/Debian
apt-get install git-crypt
```

**首次 clone：**

```bash
git clone git@github.com:jianingyu-ustc/PolyPulse.git
cd PolyPulse

# 方式 A：使用对称密钥文件
git-crypt unlock /path/to/polypulse-git-crypt-key

# 方式 B：使用 GPG（需要已被 add-gpg-user 添加）
git-crypt unlock
```

**验证解密成功：**

```bash
head -1 .env
# 应看到明文（如 POLYPULSE_EXECUTION_MODE=paper）
# 如果看到乱码，说明未成功 unlock
```

**注意：** git-crypt 密钥文件等同于 `.env` 明文访问权限，请勿提交到任何仓库或公开分享。

只保留必要配置和命令；所有命令都使用 `.env`，并读取当前 Polymarket 真实市场。每个关键流程保留 `Codex 提示词版本`，可直接交给 Codex 代跑；`live` 模式必须先确认真实资金风险。

### 必需运行模式

`.env` 统一使用真实钱包配置，通过 `POLYPULSE_EXECUTION_MODE` 控制是否真正下单：

```bash
# 通用必填（paper 和 live 都需要）
POLYPULSE_EXECUTION_MODE=paper          # paper | live
PRIVATE_KEY=<server-local-secret>
FUNDER_ADDRESS=<0x...>
SIGNATURE_TYPE=<signature-type>
CHAIN_ID=137
POLYMARKET_HOST=https://clob.polymarket.com
POLYPULSE_MARKET_SOURCE=polymarket
POLYMARKET_GAMMA_HOST=https://gamma-api.polymarket.com
MONITOR_LOG_PATH=/home/PolyPulse/logs/polypulse-monitor.log
```

- `paper`：走完整链路，最后一步不提交真实订单，用内存账本追踪仓位和 PnL。
- `live`：走完整链路，风控允许后提交真实订单。

下单前必须完成真实钱包检查（`paper` 和 `live` 均适用）：

```bash
# 1. 检查 env、secret 必填项和 Polymarket CLOB client。
node ./bin/polypulse.js env check --env-file .env

# 2. 查询真实 Polymarket CLOB collateral balance 和 allowance。
node ./bin/polypulse.js account balance --env-file .env

# 3. 一次性审计真实账户仓位、历史成交、撤单/拒单、本地记录、胜率和收益质量。
node ./bin/polypulse.js account audit --env-file .env

# 4. 确认仍在读取当前 Polymarket 真实市场；quick 只做轻量实时可读性检查。
node ./bin/polypulse.js market topics --env-file .env --limit 20 --quick

# 5. 如果 allowance 不足，只能在明确接受真实授权风险后执行。
node ./bin/polypulse.js account approve --env-file .env --confirm APPROVE
```

真实钱包必须确认：

- `PRIVATE_KEY`、`FUNDER_ADDRESS`、`SIGNATURE_TYPE`、`CHAIN_ID=137`、`POLYMARKET_HOST=https://clob.polymarket.com` 已配置。
- `FUNDER_ADDRESS` 是预期真实资金地址；不要在日志、README、issue 或提示词中输出 secret。
- `account balance` 返回的 CLOB collateral balance 足以覆盖计划下单金额，allowance 不为 0 且满足下单需要；allowance 不足时先停止下单，再决定是否手动运行 `account approve --confirm APPROVE`。
- `account audit` 必须返回 `ok=true`，并能核对已有仓位：market、outcome、token、size、avg cost、current value、unrealized PnL、到期/结算状态；如有未知仓位或风险暴露超限，停止下单。
- `account audit` 必须核对历史交易记录：最近成交、撤单/拒单、买入/卖出方向、成交均价、费用估算、realized PnL，并与 `runtime-artifacts` 中的 runs、monitor、account artifact 交叉检查。
- `account audit` 必须统计真实账户胜率和收益质量：已结算/已平仓交易的 wins、losses、win rate、平均盈利、平均亏损、净收益率、最大回撤；胜率或净收益异常时暂停下单并复盘预测和风控。
- `market topics --quick` 能读取当前 Polymarket 真实市场；如果市场源、余额、allowance、真实账户审计或 env preflight 任一失败，停止下单。

`live` 模式额外要求 `--confirm LIVE` 才会提交真实订单。

Codex 提示词版本：

```text
1. 请检查 .env 的 POLYPULSE_EXECUTION_MODE 是 paper 还是 live，并确认 POLYPULSE_MARKET_SOURCE=polymarket、POLYMARKET_GAMMA_HOST 指向真实 Gamma API。
2. 请一次性完成真实账户检查：确认 PRIVATE_KEY、FUNDER_ADDRESS、SIGNATURE_TYPE、CHAIN_ID 和 POLYMARKET_HOST；运行 env check、account balance、account audit 和 market topics --quick；不要输出真实 secret；汇总 funder 地址、collateral balance、allowance、真实市场读取结果、已有仓位（market、outcome、size、avg cost、current value、unrealized PnL、到期/结算状态）、历史交易（最近成交、撤单/拒单、费用、realized PnL）和胜率收益质量（wins、losses、win rate、平均盈利、平均亏损、净收益率、最大回撤）；如果真实余额不足、allowance 不足、已有仓位风险暴露超限、历史交易/胜率无法核对、CLOB client/preflight 失败或无法读取当前 Polymarket 真实市场，请停止下单。只有我明确要求授权时，才可以运行 account approve --confirm APPROVE。
```

### Predict-Raven Pulse 策略配置

默认 `.env` 使用 Predict-Raven `pulse-direct` 兼容口径。这里的”兼容”只表示职责分离和收益计算口径相近，不表示 PolyPulse 已实现完整 Predict-Raven 方法。

所有环境变量的完整枚举和逐项说明见 `src/config/env.js` 的 `DEFAULTS` 对象。**所有变量必须在 `.env` 中显式定义，无默认值**；缺失任何 key 启动时报错退出。

行为概要：

- `market topics` 默认按 Pulse-compatible 候选池筛选；`market topics --quick` 关闭候选筛选做轻量可读性检查。
- `monitor run` 链路：规则预筛 → AI pre-screen（TRADE/SKIP）→ AI candidate triage（语义聚类、可研究性、信息优势、证据缺口）→ 证据收集（page scrape、order book、resolution source、领域适配器、gap auto-fill）→ AI 概率估算 → 概率校准（静态 shrinkage + 动态 Brier score 反馈）→ downside risk ranking → 代码计算 fee/edge/Kelly/monthly return → RiskEngine → 执行。
- `predict`、`trade once` 和 `monitor run` 输出包含 `edge`、`net_edge`、`entry_fee_pct`、`quarter_kelly_pct`、`monthly_return`，用于验证 Predict-Raven fee / Kelly / monthly return 口径。
- `PULSE_REQUIRE_EVIDENCE_GUARD=false` 与 Predict-Raven pulse-direct 服务层分工一致：证据不足时 warning，不硬阻断；`live` 模式仍必须通过 confirm、env preflight、余额检查和 `RiskEngine`。

Codex 提示词版本：

```text
1. 请检查 .env 的 PULSE_* 配置是否与 Predict-Raven pulse-direct 兼容口径一致。
2. 请说明 market topics、predict、trade once 和 monitor run 会如何使用这些 PULSE_* 配置。
```

### 切换概率估算 Provider

只保留真实 AI provider 路径。启用 Codex：

```bash
AI_PROVIDER=codex
CODEX_SKILL_ROOT_DIR=skills
CODEX_SKILL_LOCALE=zh
CODEX_SKILLS=polypulse-market-agent
```

启用 Claude Code：

```bash
AI_PROVIDER=claude-code
CLAUDE_CODE_SKILL_ROOT_DIR=skills
CLAUDE_CODE_SKILL_LOCALE=zh
CLAUDE_CODE_SKILLS=polypulse-market-agent
CLAUDE_CODE_PERMISSION_MODE=bypassPermissions
CLAUDE_CODE_ALLOWED_TOOLS=Read,Glob,Grep
```

验证当前 provider：

```bash
# 如果使用 Claude Code，把 expect 改成 claude-code。
npm run agent:check -- --env-file .env --expect codex
```

Codex 提示词版本：

```text
1. 请检查 .env 是否启用了 Codex 或 Claude Code provider，并确认会调用配置的真实 AI provider。
2. 请运行 agent:check 验证当前 provider、runtime provider 和 skill 配置。
```

### 一次性验收

#### 一键执行全部 7 步

```bash
# 使用 live monitor 同一套逻辑，顺序输出 Step 1-7 验收日志
# 参数：
#   --env-file <path>            读取指定 env 文件，默认 .env
#   --market <market-slug|id>    手动指定单个市场；省略时按 monitor scan 自动生成候选池
#   --allow-live-execution       仅 live 模式使用：传入 LIVE confirmation，可能提交真实订单
node scripts/acceptance.js --env-file .env
```

脚本会在同一轮内存状态中依次输出：环境检查 → monitor 规则扫描和候选过滤 → monitor AI pre-screen/triage → monitor 证据收集 → monitor AI 预测和排序 → monitor 风控 → monitor 执行。
只运行一次 `node scripts/acceptance.js --env-file .env` 即可生成全部 Step 1-7 日志；下面每个 Step 小节说明的是查看同一个 `runtime-artifacts/acceptance-runs/<timestamp>/` 目录中的对应输出文件，不是让每步重新执行一次验收。
失败时脚本会写入 `summary.json` 和 `error.log`，并尽量保留已完成 Step 的 stdout/stderr 日志。
Step 2-7 复用 live monitor 的 `Scheduler` 阶段，不再用 `topics[0]` 串联独立 CLI 命令。
`paper` 模式下 Step 7 会走内存账本路径，不提交真实订单。
`live` 模式下默认不传 `LIVE` confirmation，因此会跑到 monitor 风控/执行器但不会自动提交真实订单；只有显式加 `--allow-live-execution` 才会把 `LIVE` confirmation 传入验收执行阶段。

#### Step 1: 环境检查

确认 `.env` 配置、provider、执行模式正确。一次性验收会把结果写入 `step1-env-check.stdout.log`；也可以用下面命令单独做预检查。

```bash
node ./bin/polypulse.js env check --env-file .env
```

Codex 提示词：

```text
请检查 env，确认当前 .env 的 POLYPULSE_EXECUTION_MODE 是 paper 还是 live，确认 provider 配置正确，输出 env 摘要。
```

#### Step 2: 规则扫描市场候选池

从 Polymarket Gamma API 拉取活跃市场，使用 live monitor 相同的 pulse-compatible scan、watchlist/blocklist、已交易市场和持仓过滤逻辑生成候选池。不涉及独立取 `topics[0]`。

查看本轮 `step2-monitor-scan-and-candidates.stdout.log`，重点确认 `scan.totalFetched`、`scan.totalReturned`、`scan.pulse`、`candidates[].selected` 和 `candidates[].skipped_reasons`。

Codex 提示词：

```text
请运行 acceptance Step 2，确认 monitor scan 返回真实 Polymarket 市场，并汇总 totalFetched、totalReturned、pulse selection、selectedCandidates 和 skipped_reasons。
```

#### Step 3: AI pre-screen / candidate triage

调用 monitor 相同的 AI pre-screen 和 candidate triage，对 Step 2 候选市场做适合性和优先级评估。一次性验收不再运行独立 topic discovery；这和当前 monitor 生产路径保持一致。

查看本轮 `step3-monitor-ai-prescreen-triage.stdout.log`，重点确认 `preScreen`、`candidateTriage` 和 `selectedCandidates` 是否正常返回；`paper` 模式下同时检查 monitor log 中的 triage 事件。

Codex 提示词：

```text
请查看 acceptance Step 3，确认 preScreen、candidateTriage、selectedCandidates 正常返回；paper 模式下同时汇总 topicDiscovery 输出。
```

#### Step 4: 证据收集 + AI 研究指导

对 monitor 选中的候选市场运行与 live monitor 相同的证据收集路径：先由规则适配器抓取基础证据，再由 AI Evidence Research runtime 评估证据缺口并指导定向搜索。Step 5 使用同一轮内存中的 evidence，不再重新跑一个互不相干的 `predict` 命令。

查看本轮 `step4-monitor-evidence-collect.stdout.log`，重点确认每个 prediction 的 `evidenceCount`、`sources` 列表和各 evidence 状态。

Codex 提示词：

```text
请查看 acceptance Step 4，确认证据收集正常，汇总每个 prediction 的 evidenceCount、sources 列表和各 evidence 状态。
```

#### Step 5: AI Agent 预测

调用 live monitor 相同的 probability estimator，对 Step 4 同一批 evidence 做概率估算，然后用 monitor 相同的 ranking 逻辑排序。Step 5 日志会保存 AI provider 的 `reasoning_summary`、key/counter evidence、uncertainty factors 和 provider runtime artifact 路径（如当前 provider 配置会生成）。

查看本轮 `step5-monitor-ai-prediction-ranking.stdout.log`，重点确认 provider、`ai_probability`、盘口概率、edge、net edge、quarter Kelly、monthly return、`reasoning_summary` 和 provider runtime artifact 路径。

Codex 提示词：

```text
请查看 acceptance Step 5，汇总 provider、ai_probability、market_implied_probability、edge、net_edge、quarter_kelly_pct、monthly_return、reasoning_summary 和 provider runtime artifact 路径。
```

#### Step 6: 风控评估

在 Step 5 同一轮预测基础上运行 live monitor 相同的 RiskEngine 检查，确认 risk_allowed、blocked_reasons、warnings、approved_usd。

查看本轮 `step6-monitor-risk-evaluate.stdout.log`，重点确认 `risks[].allowed`、阻断原因、warnings 和 `approvedUsd`。交易金额上限通过环境变量 `MONITOR_MAX_AMOUNT_USD` 配置。

Codex 提示词：

```text
请查看 acceptance Step 6，确认 risk_allowed 状态、blocked_reasons、warnings、approved_usd。
```

#### Step 7: 交易执行

风控通过后，使用 monitor 相同的 OrderExecutor 或内存账本路径执行。`paper` 模式不提交真实订单。`live` 模式默认不自动传 `LIVE` confirmation；需要真实执行时必须显式使用 `--allow-live-execution`，并且仍需先完成 account balance/audit。

查看本轮 `step7-monitor-execution.stdout.log`，重点确认 `executionMode`、`orders`、`filledOrders`、最终 `action` 和 `performance`。`paper` 模式下还可以查看追加的人类可读 monitor log：

```bash
# paper 模式
tail -n 80 /home/PolyPulse/logs/polypulse-monitor.log
```

`live` 模式需要先检查余额和审计；只有明确接受真实资金风险后，才在启动整轮验收时加 `--allow-live-execution`。

```bash
# live 模式预检查
node ./bin/polypulse.js account balance --env-file .env
node ./bin/polypulse.js account audit --env-file .env

# 真实执行整轮验收
node scripts/acceptance.js --env-file .env --allow-live-execution
```

Codex 提示词：

```text
如果是 paper 模式，请运行 acceptance 验收，并确认 Step 7 走内存账本、不提交真实订单，检查 monitor log 输出。
如果是 live 模式，请先运行 account balance 和 account audit；只在我明确确认接受真实资金风险且 audit 无阻断后，才用 --allow-live-execution 运行 acceptance。
```

#### 流水线说明

`trade once` 和 `monitor run` 使用同一套进程内内存账本逻辑：初始资金来自真实钱包余额，每次进程启动都会写同样的 session header，执行过程都追加到 `MONITOR_LOG_PATH`，并使用同样的 `round.start`、`topics.fetched`、`candidate`、`prediction`、`risk`、`open.filled`、`mark_to_market`、`round.end` 日志格式。区别是 `trade once` 只针对指定市场执行一轮，不做候选池 AI triage，进程结束后仓位丢失；`monitor run --loop` 在同一进程内跨轮保留仓位，并按间隔继续 mark-to-market、复核和平仓。

### 持续 Monitor

同一个命令用于 `paper` 和 `live` 模式；区别由 `.env` 的 `POLYPULSE_EXECUTION_MODE` 决定。`live` 模式会在风控通过后提交真实订单。

```bash
node ./bin/polypulse.js monitor run --env-file .env --confirm LIVE --loop
```

Monitor 行为：

- 每轮自动抓取当前 Polymarket topic，按 pulse-compatible 口径筛选候选。
- 规则预筛后先调用轻量 AI pre-screen 做信息优势预判（TRADE/SKIP，60 秒超时，失败时保留全部），被标为 SKIP 的候选记录 `ai_prescreen_skip` 并排除。
- 通过 pre-screen 的候选再调用 provider 做 candidate triage：语义聚类、主题优先级、可研究性、信息优势和证据缺口；被标记为 `reject` 的候选会记录 `ai_triage_reject` 并跳过概率估算。
- 证据收集阶段从 Polymarket 事件页面抓取 `__NEXT_DATA__` SSR 数据（结算规则、注释/公告、社区高赞评论），从 CLOB 获取每个 outcome token 的 order book 深度（best bid/ask、spread、2% 深度、top 5 挂单），并对 resolution source URL 做实时访问验证获取官方数据源当前状态，连同 market metadata 和 resolution rules 一起作为上下文传给 AI 做概率估算。
- 对候选市场调用配置的真实 AI provider 预测胜率、证据质量、可研究性和信息优势，并由代码计算 implied probability、edge、net edge、quarter Kelly 和 monthly return。
- AI 概率估算后，ProbabilityCalibrationLayer 对原始概率做 shrinkage 校准；DynamicCalibrationStore 在有充足历史数据时进一步按动态校准曲线调整，输出最终 calibrated probability 用于排序和执行决策。
- 每轮先完成全部候选预测，再按 `action`、`confidence`、`monthly_return`、`net_edge`、`quarter_kelly_pct`、`expected_value` 等 AI 衍生指标排序后，由 DownsideRiskRanker 进行二次排序（综合下行风险、流动性风险、类别集中度和资金分配），最终按 `risk_adjusted_score` 顺序执行；AI 不输出交易指令或 broker 参数。
- 用 `RiskEngine` 做金额、流动性、仓位、回撤、证据和置信度检查。
- `paper` 模式下风控允许时在内存账本开仓；`live` 模式下提交真实订单。已有仓位每轮 mark-to-market，并在市场关闭、接近 0/1、触发止损或预测 edge 反转时自动平仓。
- 每一步都会追加到 `MONITOR_LOG_PATH`：抓取 topic、候选过滤、预测、风控、开仓、平仓、现金、权益、realized/unrealized PnL、wins/losses、win rate 和最大回撤。
- `trade once` 和 `monitor run` 共用同一套日志格式和执行逻辑；`trade once` 是指定市场的一轮执行，`monitor run --loop` 是按间隔重复执行并在同一进程中保留仓位。
- `paper` 模式下程序退出后不保留仓位、现金或交易状态（内存账本随进程消亡）；持久保留的有：`MONITOR_LOG_PATH` 人类可读日志和 `runtime-artifacts/` 下的 per-round 结构化 artifact。需要停止 monitor 时，使用 `systemctl stop polypulse-monitor.service` 或结束进程，而不是依赖 `monitor stop` 的持久状态。

Codex 提示词版本：

```text
1. 请检查 .env 的 POLYPULSE_EXECUTION_MODE、provider、真实市场读取和 confirm LIVE。
2. 如果是 paper 模式，请启动 monitor，并确认它读取当前 Polymarket 真实市场、调用真实 AI provider、使用内存账本自动开仓/平仓，但不提交真实订单；程序退出后只保留人类可读 log。
3. 如果是 live 模式，请先运行 account balance 和 account audit，并只在我明确确认真实交易风险且 audit 无阻断后启动 monitor。
4. 启动后请汇总 monitor 状态、风控状态、artifact 或 monitor log 位置。
```

### Monitor 管理

```bash
# 终止 monitor 进程（推荐顺序）

# 方法 1：当前终端发送 SIGQUIT（Ctrl+C 无效时使用）
# Ctrl+\

# 方法 2：另一个终端强制杀掉
kill -9 $(pgrep -f "polypulse.*monitor")

# 方法 3：如果是 systemd 服务
systemctl stop polypulse-monitor.service

# 方法 4：pkill
pkill -9 -f "node.*polypulse.js monitor"
```

```bash
# 写入 monitor stop 状态，用于暂停持续运行。
node ./bin/polypulse.js monitor stop --env-file .env --reason manual_stop

# 清除 stop 状态，允许 monitor 再次运行。
node ./bin/polypulse.js monitor resume --env-file .env

# 查看 monitor 状态、最近运行和最近错误。
node ./bin/polypulse.js monitor status --env-file .env

# 查看系统级风控状态。
node ./bin/polypulse.js risk status --env-file .env

# 终止 monitor 进程（前台运行时直接 Ctrl+C；后台运行时用以下方式）。
# 如果是 pm2 托管：
pm2 stop polypulse-monitor
pm2 delete polypulse-monitor

# 如果是 nohup/& 后台运行：
pkill -f "polypulse.js monitor run"

# 如果是 systemd 服务：
systemctl stop polypulse-monitor
```

Codex 提示词版本：

```text
1. 请根据需要执行 monitor stop 或 resume，并说明 stop/resume 状态。
2. 请查看 monitor status，汇总最近运行、最近错误、暂停状态和 stop/resume 状态。
3. 请查看 risk status，说明当前是否允许继续运行以及阻断原因。
```

### 服务器部署

在 macOS 本机同步项目到 `/home/PolyPulse`，排除本地 secret、运行产物、依赖目录和 git 元数据：

```bash
rsync -az --delete \
  --exclude '.git' \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude 'runtime-artifacts' \
  --exclude 'node_modules' \
  /Users/jianingyu/PolyPulse/ \
  root@43.165.166.171:/home/PolyPulse/
```

登录服务器安装服务：

```bash
ssh root@43.165.166.171
cd /home/PolyPulse
chmod +x deploy/scripts/*.sh
deploy/scripts/install.sh
```

`install.sh` 会创建 `/home/PolyPulse/.env`；启动前必须编辑 `POLYPULSE_EXECUTION_MODE`（`paper` 或 `live`）和真实钱包配置，并强制权限为 `600`：

```bash
cd /home/PolyPulse
vim /home/PolyPulse/.env
chmod 600 /home/PolyPulse/.env
deploy/scripts/start.sh
deploy/scripts/status.sh
deploy/scripts/healthcheck.sh
```

验证服务、日志和真实市场读取：

```bash
cd /home/PolyPulse
systemctl is-active polypulse-monitor.service
deploy/scripts/status.sh
deploy/scripts/healthcheck.sh
journalctl -u polypulse-monitor.service -n 100 --no-pager
tail -n 100 /home/PolyPulse/logs/polypulse-monitor.log
node ./bin/polypulse.js market topics --env-file .env --limit 20 --quick
node ./bin/polypulse.js account audit --env-file .env
```

Codex 提示词版本：

```text
1. 请在我的 macOS 本机把当前 PolyPulse 项目同步到 root@43.165.166.171:/home/PolyPulse/，同步时排除 .git、.env、.env.*、runtime-artifacts 和 node_modules。
2. 请登录 root@43.165.166.171，在 /home/PolyPulse 运行部署安装脚本，并确认 systemd unit、运行目录和日志轮转安装成功。
3. 请检查 /home/PolyPulse/.env；不要输出真实 secret，必须配置 POLYPULSE_EXECUTION_MODE（paper 或 live），并确认读取当前 Polymarket 真实市场。
4. 请把 /home/PolyPulse/.env 权限设置为 600，启动 systemd monitor 服务，并执行 status 和 healthcheck。
5. 请查看 systemd journal、/home/PolyPulse/logs/polypulse-monitor.log、account audit 和 market topics --quick 输出，确认部署后仍读取当前 Polymarket 真实市场且真实账户检查通过。
```

### Web Dashboard（监控仪表板）

Monitor 运行时内嵌一个轻量 HTTP 服务器，提供实时 Web 仪表板，展示：

- **摘要面板**：程序开始时间、运行天数、初始资金、当前现金/权益、已实现/未实现收益、月化/年化收益率、胜率、最大回撤
- **持仓表格**：市场（可点击跳转 Polymarket 原始页面）、方向、开仓时间、到期时间、开仓金额、AI 预测胜率、市场预测胜率、Edge、手续费、Net Edge、未实现盈亏
- **已关仓表格**：市场（可点击跳转 Polymarket）、方向、开仓时间、关仓时间、开仓金额、Edge、手续费、Net Edge、盈亏、收益率
- **中英文切换**：右上角按钮一键切换语言，选择持久化到 localStorage

**配置（.env）：**

```bash
DASHBOARD_ENABLED=true
DASHBOARD_PORT=3847
```

**访问方式：**

```bash
# 浏览器
http://43.165.166.171:3847

# 终端浏览器
curl http://43.165.166.171:3847/api/data | jq .
```

页面每 30 秒自动刷新数据。Dashboard 作为 monitor 进程的一部分运行，无需额外部署。如果端口已被占用（如 standalone dashboard 进程），monitor 会打印 warning 并继续运行，dashboard 功能自动禁用。

**Standalone Dashboard（不重启 monitor 时临时查看）：**

```bash
# 独立进程，读取 monitor log 文件解析仓位数据
node bin/dashboard-standalone.js --port 3847 --log logs/polypulse-monitor.log
```

**服务器部署：**

```bash
ssh root@43.165.166.171
cd /home/PolyPulse

# 在 .env 中添加
echo 'DASHBOARD_ENABLED=true' >> .env
echo 'DASHBOARD_PORT=3847' >> .env

# 开放防火墙端口（云厂商控制台开放 + OS 级别）
ufw allow 3847/tcp

# 重启服务
systemctl restart polypulse-monitor.service

# 验证
curl http://localhost:3847/api/data
```
