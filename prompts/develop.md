### 抛砖引玉
https://github.com/Alchemist-X/predict-raven?v=2
这是一个调用codex/claudecode，在预测市场上自主交易的Agent框架，以下是作者的博客：

===================================================================
我把Predict-Raven开源了，这是一个可以在预测市场上自主交易的Agent框架。 在一个月的时间里他已经取得了实盘+8%的收益。我身边一小撮对AI trading和Polymarket感兴趣的极客和交易员朋友，已经开始部署和测试它

Predict-Raven有点像一只盘旋在上空持续寻找机会的小乌鸦，它会定时扫描数千个市场，持续地搜集证据，评估事件真实发生概率，再对比市场隐含的赔率。当它发现足够大的偏差时，就会自动下单、风控、止损，并记录下来自己的决策思路和依据

我做这个项目的动机源自主观性较强的几点判断：
1. AI已经拥有了和人类相等甚至超过人类的推理能力
2. 交易，在本质上可能和其他推理任务并没有不同，AI缺少的，可能只是更好的交互环境和上下文
3. 预测市场在交易里又尤为特殊，他们交易的，本质上是主观预估概率vs市场隐含概率的gap。如果你能比市场更准确地预测未来，你就能持续地获得收益。而预测本身，可能可以拆成两个相对独立的能力：信息搜集和推理。ai在一系列高难度benchmark的进步表明，ai在agentic search和reasoing上终会战胜人类，或者，已经战胜

人类的优势是直觉和通过社交来获得隐含信息。再退几步说，哪怕AI的推理能力仍然稍弱于人类，也能通过同时扫描复数个市场和7x24的待机，来等候定价错误的市场出现实现盈利，战胜市场某种程度上也是胜出人类的baseline。就像在德扑中：牌技高低只是盈利能力的一部分，更重要的是“找局”能力，能不能稳定地找上有漏洞的对手。以盈利为目的时，永远要在自己有edge的场子玩。

预测市场，尤其是科技和政治市场，是一个还没被充分开发的蓝海，当做市商还在畏惧库存管理和逆向选择时。agent真的有可能跑出一些优势；同时我也相信：开源协作会比闭门造车更快跑出东西，对于 Predict-Raven 来讲，还非常有趣的一点是，它也有类似龙虾 soul.md 的架构，允许用户按照自己的偏好和设定去交易。

举个例子，我经过测试并打磨的一个用例是告诉 Agent：市场存在 long-shot bias，即市场会高估小概率事件发生的概率。同时，我让它限定在流动性非常差的政治和科技市场，因为我相信这些地方被不正确定价的概率更高，竞争也不激烈。大家可以很自由地把自己的交易原则代入到小乌鸦里，并通过一些参数增加强约束

哪怕这已经是一个经过很多轮迭代的项目，我也想向大家坦白这个项目还有非常多可以改进的地方。比如真实的测试资金只有500u，而预期的策略容量可能在15万美金以上。目前的一些最优先的需求还包括：更高频的交易，持久化运行和云端部署。我觉得现在也是一个合适的时机把它发布向公众，通过building in public收获非常珍贵的反馈，来调整后续的开发方向

我会挑选五位转发并私信我的朋友，可以简单介绍下自己想参与到Predict-Raven的原因，我将手把手地帮你们搭建属于自己的预测市场agent.
===================================================================

现在，我fork了这个仓库，在/Users/jianingyu/predict-raven，并且创建了一个新的仓库/Users/jianingyu/PolyPulse

我想让codex学习predict-raven的功能和用法，生成skill，并且帮我构建一个相似的系统，部署在轻量级服务器上，帮我分段写提示词。要求：

先学习，后开发

强调这个仓库的特色就是ai爬取数据并决策，需要一比一迁移原 Predict-Raven 的所有codex相关逻辑

提示词侧重功能和性能，不要将技术栈限制得太多

测试模块包括但不局限于：polymarket账户余额查询（可参考predict-raven仓库.env.example的环境变量配置方法）、当前市场话题抓取、胜率预测、模拟盘/实盘一次性下单、模拟盘/实盘持久性话题监测与下单等

中间分析全部写入memory文件，屏幕只输出简短状态

### 0. 全局约束，建议每段都带上
你现在在目标仓库 /Users/jianingyu/PolyPulse 工作。
源参考仓库在 /Users/jianingyu/predict-raven。

核心目标：
构建一个类似 Predict-Raven 的预测市场自主交易 Agent 框架。项目特色必须突出：
AI 会主动抓取 Polymarket 市场与外部证据，独立评估事件发生概率，再根据市场赔率、edge、流动性和风控规则决定是否交易。

执行原则：
1. 先学习 predict-raven，再开发 PolyPulse。
2. 不要过早绑定技术栈；除非现有代码或实际依赖强制要求，否则优先定义清晰接口、模块边界和性能目标。
3. 所有中间分析、设计权衡、源码阅读笔记、接口推断、失败原因、测试观察，全部追加写入：
   docs/memory/POLYPULSE_MEMORY.md
4. 屏幕只输出简短状态，不输出长篇分析。格式：
   [stage] <当前阶段> | [status] <ok/warn/fail> | [artifact] <关键文件路径>
5. 不要把私钥、钱包助记词、API key、cookie、session token 写入日志、memory、测试快照或 git。
6. 任何 live 实盘路径都必须有 preflight、dry-run 或 recommend-only 阶段；没有显式 live 确认，不允许真实下单。
7. 每个阶段结束前运行相关测试或至少给出可执行验证命令。
8. 每个阶段结束前更新 docs/memory/POLYPULSE_MEMORY.md，并输出本阶段创建/修改的关键文件路径。

### 1. 学习 Predict-Raven，并生成 PolyPulse skill
任务：只学习，不开发业务功能。

请系统阅读 /Users/jianingyu/predict-raven，重点看：
- README.md
- AGENTS.md / claude.md
- .env.example
- skills/daily-pulse/SKILL.md
- skills/daily-pulse/agents/*
- docs/diagrams/dev-reference.md
- docs/risk-controls.md
- services/orchestrator
- services/executor
- packages/contracts
- packages/db
- scripts
- deploy

输出到目标仓库 /Users/jianingyu/PolyPulse：

1. 创建或更新 docs/memory/POLYPULSE_MEMORY.md
   记录：
   - predict-raven 的核心功能链路
   - 关键命令
   - 关键环境变量
   - 关键数据结构
   - 风控规则
   - 运行产物目录
   - paper/live 模式差异
   - provider-runtime / pulse-direct 思路
   - 可以借鉴但不应直接照搬的点

2. 创建 skills/polypulse-market-agent/SKILL.md
   这是给 Codex/Claude Code 使用的项目 skill，要求覆盖：
   - 什么时候触发
   - 默认安全模式
   - paper 模式命令
   - live 模式命令
   - 市场扫描
   - 余额查询
   - 胜率预测
   - 一次性下单
   - 持久监控与下单
   - 运行结束应汇报哪些路径
   - 失败时应保存哪些诊断文件

3. 创建 docs/learned-from-predict-raven.md
   用中文写，面向开发者，说明 PolyPulse 要学习 predict-raven 的哪些设计，而不是复制哪些实现。

限制：
- 这一阶段不要实现交易逻辑。
- 不要修改真实 env。
- 不要运行 live 命令。
- 屏幕只输出简短状态，长分析全部写 memory。

### 2. 写 PolyPulse 的产品需求与架构规格
任务：基于上一阶段学习结果，先写规格，不写核心实现。

请在 /Users/jianingyu/PolyPulse 中创建：

1. docs/specs/product-requirements.md
2. docs/specs/architecture.md
3. docs/specs/risk-controls.md
4. docs/specs/testing-plan.md

必须覆盖的功能：
- Polymarket 账户余额查询
- 当前市场话题抓取
- AI 抓取外部证据
- AI 估算事件胜率 / 发生概率
- 市场隐含概率计算
- edge 计算
- 流动性过滤
- paper 模拟盘一次性下单
- live 实盘一次性下单
- paper 模式持久化话题监测与自动下单
- live 模式持久化话题监测与自动下单
- 交易决策归档
- 可恢复运行状态
- 轻量级服务器部署

性能目标必须写清楚：
- 支持扫描大量市场，不要只为几十个市场设计
- 抓取、证据检索、概率估计、下单执行要可并发但可限流
- 外部 API 失败要可重试、可降级、可追踪
- 持久监控必须支持 crash recovery
- 同一个市场/事件不能重复误下单
- 高频轮询时要避免无意义重复抓取
- memory 与 runtime artifacts 不能无限膨胀，需要归档/清理策略

架构上不要限制具体技术栈，但必须定义接口：
- MarketSource
- EvidenceCrawler
- ProbabilityEstimator
- DecisionEngine
- RiskEngine
- Broker
- PaperBroker
- LiveBroker
- StateStore
- ArtifactWriter
- Scheduler
- Notifier 或 Reporter

安全要求：
- 默认 paper
- live 必须显式确认
- 私钥不落盘、不打印
- env 校验失败 fail-fast
- 风控在服务层强制执行，不能只靠 prompt
- AI 输出只能作为建议，最终交易必须过 RiskEngine

屏幕只输出简短状态，完整设计分析写入 docs/memory/POLYPULSE_MEMORY.md。

### 3. 初始化工程骨架和统一命令
任务：实现 PolyPulse 的最小可运行工程骨架。

要求：
1. 根据 docs/specs/architecture.md 创建合理目录结构。
2. 不要为了模仿 predict-raven 而强行使用完全相同技术栈；优先选择当前仓库最适合、最少依赖、易部署的方案。
3. 提供统一 CLI 或脚本入口，至少支持以下命令语义：

   polypulse env check
   polypulse account balance --env-file <path>
   polypulse market topics --limit 20
   polypulse predict --market <market-id-or-slug>
   polypulse trade once --market <id> --side yes --amount 1
   polypulse trade once --market <id> --side yes --amount 1 --confirm LIVE
   polypulse monitor run
   polypulse monitor run --confirm LIVE

4. 创建 .env.example，参考 predict-raven 的配置风格，但不要照抄无关项。至少包括：
   - PRIVATE_KEY=
   - FUNDER_ADDRESS=
   - SIGNATURE_TYPE=
   - CHAIN_ID=137
   - POLYMARKET_HOST=
   - STATE_DIR=
   - ARTIFACT_DIR=
   - MAX_TRADE_PCT=
   - MAX_TOTAL_EXPOSURE_PCT=
   - MAX_EVENT_EXPOSURE_PCT=
   - MIN_TRADE_USD=
   - MARKET_SCAN_LIMIT=
   - MONITOR_INTERVAL_SECONDS=
   - AI_PROVIDER=
   - AI_MODEL=
   - AI_COMMAND=

5. 创建基础 domain types / schemas：
   - Market
   - Outcome
   - Evidence
   - ProbabilityEstimate
   - TradeCandidate
   - TradeDecision
   - RiskDecision
   - OrderRequest
   - OrderResult
   - PortfolioSnapshot
   - RunArtifact

6. 添加最小测试框架和 smoke test。

所有中间分析写入 docs/memory/POLYPULSE_MEMORY.md。
屏幕只输出阶段状态、测试命令和关键文件路径。

### 4. 实现 Polymarket 市场话题抓取
任务：实现“当前市场话题抓取”模块。

功能要求：
1. 能从 Polymarket 获取当前可交易市场或事件。
2. 输出标准 Market 列表，包括：
   - market id / slug
   - question / title
   - outcomes
   - yes/no 或 outcome token 信息
   - 当前价格
   - 隐含概率
   - 流动性
   - 成交量
   - 截止时间
   - 标签/分类
   - 是否 active / closed
3. 支持过滤：
   - 最小流动性
   - 最小成交量
   - 分类关键词
   - 结束时间范围
   - 是否可交易
4. 支持缓存，避免持久监控时重复请求。
5. 支持分页或批量抓取，不要只取第一页。
6. 支持 artifacts：
   - runtime-artifacts/markets/<timestamp>/markets.json
   - runtime-artifacts/markets/<timestamp>/summary.md

性能要求：
- 大量市场扫描时要有限流、重试和超时。
- 失败不能伪装成真实数据；fallback 必须明确标记。
- 抓取结果不足时要返回风险标记。

测试要求：
- mock API 测试
- schema 校验测试
- 过滤逻辑测试
- CLI smoke test：polypulse market topics --limit 20

所有分析写 memory，屏幕只输出简短状态。

### 5. 实现 AI 证据抓取与胜率预测
任务：实现 AI 抓取数据并决策的核心分析模块。

核心原则：
PolyPulse 的特色不是普通量化脚本，而是 AI 主动收集信息、整理证据、估算事件真实发生概率，并把这个概率和市场隐含概率比较。

实现要求：
1. EvidenceCrawler：
   - 输入 Market
   - 输出 Evidence[]
   - 每条 Evidence 至少包含 source、title、url 或来源标识、timestamp、summary、relevance_score
   - 支持搜索/抓取适配器接口，不要把实现写死
   - 支持超时、重试、去重、缓存

2. ProbabilityEstimator：
   - 输入 Market + Evidence[]
   - 输出 ProbabilityEstimate
   - 至少包含：
     - ai_probability
     - confidence
     - reasoning_summary
     - key_evidence
     - counter_evidence
     - uncertainty_factors
     - freshness_score
   - AI 的完整推理不要打印到屏幕；写入 artifact markdown。
   - 屏幕只显示概率、confidence、edge、artifact 路径。

3. DecisionEngine：
   - 输入 Market、ProbabilityEstimate、PortfolioSnapshot
   - 计算：
     - market_implied_probability
     - edge = ai_probability - market_implied_probability
     - expected value
     - suggested side
     - suggested notional before risk
   - 输出 TradeCandidate 或 no-trade reason。

4. Prompt 模板：
   - 创建 prompts/probability-estimation.md
   - 创建 prompts/evidence-search.md
   - 创建 prompts/trade-decision.md
   - 强调：必须基于证据，不允许编造信息；证据不足时输出 no-trade。

5. Artifacts：
   - runtime-artifacts/predictions/<timestamp>-<market>/evidence.json
   - runtime-artifacts/predictions/<timestamp>-<market>/estimate.json
   - runtime-artifacts/predictions/<timestamp>-<market>/decision.md

测试要求：
- 用 mock EvidenceCrawler 测 ProbabilityEstimator schema。
- 用 deterministic fake AI 输出测 DecisionEngine。
- 测 edge 正负场景。
- 测证据不足时 no-trade。
- CLI smoke test：polypulse predict --market <mock-or-real-market>

所有中间分析写 memory，屏幕只输出简短状态。

### 6. 实现账户余额查询和 paper/live Broker
任务：实现账户与交易执行层。

先实现安全路径，再接 live。

功能要求：
1. EnvLoader / Preflight：
   - 读取 --env-file
   - 校验 PRIVATE_KEY、FUNDER_ADDRESS、SIGNATURE_TYPE、CHAIN_ID、POLYMARKET_HOST
   - 打印当前使用的 env 文件路径、chain id、funder address 的脱敏形式
   - 不打印 private key
   - 缺字段 fail-fast

2. Account balance：
   - 实现 polypulse account balance --env-file <path>
   - 查询 Polymarket 相关账户余额
   - 输出：
     - wallet/proxy address 脱敏
     - collateral balance
     - artifact path
   - 将完整结构化结果写入 runtime-artifacts/account/<timestamp>/balance.json

3. PaperBroker：
   - 本地模拟成交
   - 记录 cash、positions、orders
   - 支持 buy/sell
   - 支持 mark-to-market
   - 状态写入 STATE_DIR
   - 支持 crash recovery

4. LiveBroker：
   - 对接 Polymarket 下单
   - 默认禁止 live
   - 只有命令显式包含 --confirm LIVE 才允许真实下单
   - live 下单前必须执行 preflight、balance check、risk check
   - 下单结果必须归档
   - API 错误要保留原始错误摘要，但不能泄露 secret

5. OrderExecutor：
   - 输入 RiskDecision
   - paper/live 共用同一接口
   - 实盘前强制检查 RiskEngine 输出是否 allow
   - 禁止绕过 RiskEngine 直接下单

测试要求：
- env 缺字段测试
- private key 不出现在日志测试
- balance query mock 测试
- paper once order 测试
- live order 默认拒绝测试
- live order 无 --confirm LIVE 拒绝测试
- live broker 用 mock client 测试，不要在自动测试里真实下单

屏幕只输出简短状态，完整分析写 memory。

### 7. 实现服务层硬风控
任务：实现 RiskEngine，要求风控在代码层强制执行，不依赖 prompt。

规则至少包括：
1. 系统级：
   - paused / halted 状态禁止新开仓
   - drawdown 超阈值进入 halted
   - 只有显式 resume 才恢复

2. 仓位级：
   - 单仓最大亏损触发 reduce/close 建议
   - 单事件最大敞口限制
   - 最大持仓数量限制

3. 交易级：
   - 单笔最大资金占比 MAX_TRADE_PCT
   - 最大总敞口 MAX_TOTAL_EXPOSURE_PCT
   - 单事件最大敞口 MAX_EVENT_EXPOSURE_PCT
   - 最小交易额 MIN_TRADE_USD
   - 流动性 cap
   - AI 建议金额只能向下裁剪，不能为了满足最小交易额而向上加仓

4. 数据级：
   - 市场数据过期禁止 open
   - 证据不足禁止 open
   - AI confidence 低于阈值禁止 open
   - market token 缺失禁止 open
   - closed/inactive 市场禁止 open

5. live 级：
   - 未通过 env preflight 禁止 live
   - 未通过 balance check 禁止 live
   - 未显式 --confirm LIVE 禁止 live
   - paper 和 live 状态文件隔离

输出：
- RiskDecision.allow
- adjusted_notional
- blocked_reasons
- warnings
- applied_limits

测试：
- 每条规则至少一个单测
- 组合规则测试
- AI 输出越权 token 时被拒绝
- stale market 被拒绝
- 风控裁剪金额低于 MIN_TRADE_USD 时丢弃
- live 未确认被拒绝

所有分析写 memory，屏幕只输出简短状态。

### 8. 实现一次性预测与下单闭环
任务：打通 one-shot 闭环。

命令目标：
1. polypulse predict --market <id-or-slug>
   只预测，不下单。

2. polypulse trade once --market <id-or-slug> --max-amount <usd>
   抓市场 → 抓证据 → 估概率 → 算 edge → 风控 → paper 下单或 no-trade。

3. polypulse trade once --market <id-or-slug> --max-amount <usd> --env-file <path> --confirm LIVE
   抓市场 → 抓证据 → 估概率 → 算 edge → 风控 → live preflight → live 下单或 no-trade。

必须归档：
runtime-artifacts/runs/<timestamp>-once/
- input.json
- market.json
- evidence.json
- estimate.json
- decision.json
- risk.json
- order.json
- summary.md

屏幕只输出：
- mode
- market question
- AI probability
- market probability
- edge
- action: no-trade / paper-order / live-order
- artifact path

测试：
- paper one-shot 成功
- no-trade 场景
- live 缺 confirm 拒绝
- live mock 下单成功
- artifact 完整性测试

不要打印长推理；长推理写 artifact 和 memory。

### 9. 实现持久化话题监测与自动下单
任务：实现 persistent monitor。

命令目标：
1. polypulse monitor run
2. polypulse monitor run --env-file <path> --confirm LIVE
3. polypulse monitor status
4. polypulse monitor stop
5. polypulse monitor resume

功能要求：
- 周期性抓取当前市场话题
- 根据配置过滤市场
- 对候选市场抓证据
- AI 估概率
- 决策是否交易
- 通过 RiskEngine
- paper/live broker 执行
- 保存每轮 run artifact
- 保存 monitor state
- crash 后可恢复
- 同一市场避免重复下单
- 支持 watchlist 和 blocklist
- 支持最大每轮交易数
- 支持最大每日交易额
- 支持 sleep/backoff/rate limit

性能要求：
- 抓取和预测可以并发，但必须有限流。
- 同一来源短时间内不要重复抓取。
- 每轮要有超时。
- 长时间运行时 memory/artifacts 要有清理策略。
- 每轮只在屏幕输出简短状态。

必须归档：
runtime-artifacts/monitor/<date>/<run-id>/
- markets.json
- candidates.json
- predictions/
- decisions.json
- risk.json
- orders.json
- summary.md

测试：
- paper monitor 跑一轮
- paper monitor 跑多轮不重复下单
- live monitor 默认拒绝
- live monitor mock broker 可执行
- crash recovery
- rate limit
- artifact 完整性
- stop/resume 状态

所有中间分析写 memory。

### 10. 补齐测试矩阵
任务：按 testing-plan 补齐测试模块，不局限于当前已有测试。

必须至少覆盖：

1. 环境配置
   - .env.example 字段完整性
   - 缺 PRIVATE_KEY 时 live preflight fail
   - private key 不进入日志、artifact、memory

2. Polymarket 账户余额查询
   - mock client 成功
   - API 失败
   - 地址/chain 配置错误
   - artifact 输出

3. 当前市场话题抓取
   - 分页
   - 过滤
   - cache
   - stale 标记
   - 流动性不足

4. 胜率预测
   - mock evidence
   - fake AI response
   - schema 校验
   - 证据不足 no-trade
   - confidence 过低 no-trade

5. 模拟盘一次性下单
   - buy
   - sell/reduce
   - 余额不足
   - 持仓更新
   - artifact 完整性

6. 实盘一次性下单
   - 默认拒绝
   - 缺 confirm 拒绝
   - mock live broker 成功
   - risk 拒绝后不调用 broker

7. 模拟盘持久监测与下单
   - 单轮
   - 多轮
   - 去重
   - crash recovery
   - stop/resume

8. 实盘持久监测与下单
   - 默认拒绝
   - 缺 confirm 拒绝
   - mock live broker 可执行
   - halted 状态禁止 open

9. 风控
   - 单笔上限
   - 总敞口上限
   - 单事件上限
   - 最大持仓数
   - 最小交易额
   - stale market
   - token 不匹配
   - AI 越权输出

10. 性能/稳定性
   - 大量市场 mock scan
   - 并发限流
   - 超时
   - 重试
   - artifact 清理策略

要求：
- 所有测试命令写入 docs/testing.md
- CI 或本地一键测试命令可用
- 屏幕只输出测试摘要
- 失败详情写入 runtime-artifacts/test-runs/<timestamp>/
- 完整测试分析写 memory

### 11. 轻量级服务器部署
任务：让 PolyPulse 可以部署在轻量级服务器上，登陆方式：ssh root@43.165.166.171。

目标：
- 写好脚本即可，不要现在部署
- 支持低配 VPS 长期运行
- 默认 paper 部署
- live 部署必须显式配置和确认
- 支持 systemd 或 Docker 二选一/都支持，按当前项目最简方案实现
- 不要引入过重依赖

请创建：
1. deploy/README.md
2. deploy/env.example
3. deploy/systemd/polypulse-monitor.service
4. deploy/scripts/install.sh
5. deploy/scripts/start.sh
6. deploy/scripts/stop.sh
7. deploy/scripts/status.sh
8. deploy/scripts/healthcheck.sh
9. docs/runbooks/server-deploy.md
10. docs/runbooks/live-trading-checklist.md
所有md文件均为中文版

部署要求：
- 所有部署文件均创建在/home/PolyPulse目录下
- secrets 不进 git
- env 文件权限检查
- STATE_DIR 和 ARTIFACT_DIR 可配置
- 日志轮转
- healthcheck
- 自动重启
- 启动前 preflight
- paper smoke test
- live 启动必须 --confirm LIVE 或等效强确认
- 部署后给出验证命令

运行方式至少覆盖：
- paper monitor 常驻
- live monitor 常驻
- 手动跑一次预测
- 手动查余额
- 查看最近 artifact
- 停止 monitor
- 恢复 monitor

所有部署分析写 memory。
屏幕只输出简短状态和关键文件路径。

### 12. 最终验收与整理
任务：最终验收 PolyPulse。

请执行：
1. 阅读 docs/specs/product-requirements.md，对照功能逐项检查。
2. 运行完整测试。
3. 运行 paper one-shot demo。
4. 运行 paper monitor demo，至少一轮。
5. 检查所有 live 路径默认是否拒绝。
6. 检查 private key 是否可能出现在日志、artifact、memory、测试快照。
7. 检查 runtime-artifacts 是否结构清晰。
8. 检查 docs/memory/POLYPULSE_MEMORY.md 是否记录了关键设计和残余风险。
9. 检查 deploy 文档是否能让轻量级服务器部署。

输出：
- docs/FINAL_ACCEPTANCE.md
- docs/KNOWN_LIMITATIONS.md
- docs/ROADMAP.md

FINAL_ACCEPTANCE.md 必须包含：
- 已完成能力
- 未完成能力
- 测试结果
- paper demo 结果
- live 安全门禁结果
- 部署验证结果
- 关键命令
- 关键 artifact 路径
- 仍需人工确认的事项

屏幕只输出：
[stage] final-acceptance | [status] ok/warn/fail | [artifact] docs/FINAL_ACCEPTANCE.md


