# PolyPulse Memory

> 记录原则：本文件只保存可复用的源码阅读、设计权衡、接口推断、失败原因和验证观察。不要写入私钥、助记词、API key、cookie、session token 或真实 `.env` 内容。

## 2026-04-30 · 阶段 1：学习 Predict-Raven，生成 PolyPulse skill

### 阶段边界

- 本阶段只做源码阅读和文档/skill 沉淀，不实现交易逻辑。
- 目标仓库：`/Users/jianingyu/PolyPulse`。
- 源参考仓库：`/Users/jianingyu/predict-raven`。
- 未修改真实 env，未读取 `.env.live-test`，未运行任何 live 命令。
- 只从 `.env.example` 和 `deploy/hostinger/stack.env.example` 提取环境变量名称，不记录变量值。

### 已阅读的关键路径

- 根文档：`README.md`、`AGENTS.md`、`claude.md`、`.env.example`。
- Skill：`skills/daily-pulse/SKILL.md`、`skills/daily-pulse/agents/openai.yaml`。
- 设计与风控：`docs/diagrams/dev-reference.md`、`docs/risk-controls.md`。
- Orchestrator：`services/orchestrator/src/config.ts`、`src/jobs/daily-pulse-core.ts`、`src/jobs/agent-cycle.ts`、`src/pulse/*`、`src/runtime/*`、`src/review/position-review.ts`、`src/lib/risk.ts`、`src/lib/execution-planning.ts`、`src/lib/fees.ts`、`src/lib/artifacts.ts`、`src/ops/trial-*`、`src/ops/paper-trading.ts`。
- Executor：`services/executor/src/config.ts`、`src/lib/polymarket.ts`、`src/lib/risk.ts`、`src/workers/queue-worker.ts`。
- Contracts / DB：`packages/contracts/src/index.ts`、`packages/db/src/schema.ts`、`packages/db/src/local-state.ts`。
- Scripts / deploy：`package.json`、`scripts/daily-pulse.ts`、`scripts/pulse-live.ts`、`scripts/live-test.ts`、`scripts/live-test-helpers.ts`、`scripts/poly-cli.ts`、`scripts/live-run-common.ts`、`deploy/docker-compose.yml`、`deploy/hostinger/docker-compose.yml`、`deploy/hostinger/stack.env.example`。

### Predict-Raven 核心功能链路

Predict-Raven 是一个围绕 Polymarket 自主交易的 Agent 框架，主链路可以概括为：

1. Market Pulse 抓取 Polymarket 市场宇宙。
   - `services/orchestrator/src/pulse/market-pulse.ts` 调用 vendor 中的 `fetch_markets.py`，参数来自 `PULSE_PAGES`、`PULSE_EVENTS_PER_PAGE`、`PULSE_MIN_FETCHED_MARKETS`、`PULSE_MIN_LIQUIDITY_USD` 等。
   - 原始市场被转换为 `PulseCandidate`，包含 question、event/market slug、url、liquidity、volume、outcomes、outcomePrices、clobTokenIds、endDate、bid/ask/spread、category/tags、negRisk、feeSchedule 等字段。
   - 候选先剔除短期价格预测市场，再应用用户过滤器，如 category、tag、概率区间、min-liquidity，最后随机抽样到 `PULSE_MAX_CANDIDATES`。

2. Full Pulse 研究与报告归档。
   - `services/orchestrator/src/pulse/full-pulse.ts` 对候选做深度研究选择，排序依据是流动性、24h 成交和 spread 的 `priorityScore`。
   - 可选 `PULSE_AI_PRESCREEN=true` 时，先让 provider 快速判定候选是否适合 AI 形成 edge；失败时回退到普通选择，不阻塞。
   - 深度研究会读取市场上下文、规则、评论、订单簿，并把研究上下文写成 JSON。
   - full pulse provider 必须渲染完整 Markdown 报告；当前代码注释明确不再 fallback：如果 AI provider 不能渲染可用报告，本轮失败，不应在缺少完整分析时开新仓。
   - 产物写到 `runtime-artifacts/reports/pulse/YYYY/MM/DD/`，同时生成 Markdown 与 JSON。

3. 决策运行时。
   - 默认主策略是 `AGENT_DECISION_STRATEGY=pulse-direct`。
   - `pulse-direct` 不再依赖外部 LLM 子进程输出交易 JSON，而是由代码解析 Pulse Markdown 的推荐段落，构造 `PulseEntryPlan`，再用独立 Position Review 复审已有仓位，最后用 Decision Composer 合并。
   - `provider-runtime` 是 legacy 对照路径，会 spawn Codex / Claude Code / OpenClaw 等 CLI，要求输出合法 `TradeDecisionSet` JSON，再由服务层 schema 和风控处理。

4. 执行计划与风控裁剪。
   - `buildExecutionPlan()` 只处理 `open`、`close`、`reduce`。
   - open 必须读取 order book，有可执行 best ask，否则跳过。
   - open 的初始金额来自代码重算的 1/4 Kelly，不信任 Markdown 中的建议仓位。
   - 再依次受单笔上限、总敞口、单事件敞口、最大持仓数、流动性上限、内部最小单、Polymarket 最小单、slippage cap 约束。
   - close/reduce 必须能从真实或 paper 持仓推断可卖份额，并检查交易所最小 shares。

5. 执行路径。
   - `pulse:live` 是直接执行路径：preflight -> auto-redeem -> 拉远端持仓/余额 -> Pulse -> runtime -> execution plan -> 直接下单 -> summary。
   - `live:test` 是 stateful worker 路径：preflight -> 初始化 DB 状态 -> BullMQ 队列 -> executor worker -> sync -> summary。
   - `trial:recommend` / `trial:approve` 是 paper 路径：先保存 awaiting-approval 推荐，再显式 approve 更新本地 paper state。

6. 状态、归档与 UI。
   - DB schema 记录 agent runs、decisions、execution events、positions、portfolio snapshots、risk events、resolution checks、tracked sources、artifacts、system state。
   - paper 模式使用 file-backed local state，默认路径是 `runtime-artifacts/local/paper-state.json`。
   - 所有关键运行产物都落盘，失败也写 `error.json`、checkpoint 或 run-summary，便于断点续跑和复盘。

### 关键命令

构建与校验：

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

数据库：

```bash
pnpm db:generate
pnpm db:migrate
pnpm db:seed
```

Paper / trial：

```bash
AUTOPOLY_EXECUTION_MODE=paper pnpm trial:recommend
AUTOPOLY_EXECUTION_MODE=paper pnpm trial:approve -- --latest
AUTOPOLY_EXECUTION_MODE=paper pnpm trial:reset-paper
```

Pulse / live：

```bash
ENV_FILE=.env.live-test pnpm pulse:live -- --recommend-only
ENV_FILE=.env.live-test pnpm pulse:live -- --json
ENV_FILE=.env.live-test pnpm pulse:live
ENV_FILE=.env.live-test pnpm live:test
pnpm daily:pulse
pnpm pulse:recommend
```

Executor ops / Polymarket 辅助：

```bash
pnpm --filter @autopoly/executor ops:check
pnpm --filter @autopoly/executor ops:check -- --slug <market-slug>
pnpm --filter @autopoly/executor ops:trade -- --slug <market-slug> --max-usd 1
pnpm poly:cache-order-limits
```

部署与依赖：

```bash
pnpm vendor:sync
docker compose -f deploy/docker-compose.yml up -d postgres redis
pnpm dev
```

注意：Predict-Raven 的 `pnpm daily:pulse` / `pnpm pulse:live` 默认可走真钱 live 下单。PolyPulse 不应继承这种默认行为；默认必须 recommend-only 或 paper。

### 关键环境变量

基础设施与模式：

- `NODE_ENV`
- `ENV_FILE`
- `DATABASE_URL`
- `DATABASE_READONLY_URL`
- `REDIS_URL`
- `APP_URL`
- `AUTOPOLY_EXECUTION_MODE`
- `AUTOPOLY_LOCAL_STATE_FILE`
- `ARTIFACT_STORAGE_ROOT`

鉴权与内部调用：

- `ADMIN_PASSWORD`
- `ORCHESTRATOR_INTERNAL_URL`
- `ORCHESTRATOR_INTERNAL_TOKEN`

钱包与 Polymarket：

- `PRIVATE_KEY`
- `FUNDER_ADDRESS`
- `SIGNATURE_TYPE`
- `POLYMARKET_HOST`
- `CHAIN_ID`
- `DEFAULT_ORDER_TYPE`
- `POLYGON_PUSD_CONTRACT`
- `POLY_CLI_ENABLED`
- `POLY_CLI_COMMAND`
- `POLY_CLI_STRICT`

调度与风控：

- `AGENT_POLL_CRON`
- `SYNC_INTERVAL_SECONDS`
- `BACKTEST_CRON`
- `RESOLUTION_BASE_INTERVAL_MINUTES`
- `RESOLUTION_URGENT_INTERVAL_MINUTES`
- `DRAWDOWN_STOP_PCT`
- `POSITION_STOP_LOSS_PCT`
- `MAX_TOTAL_EXPOSURE_PCT`
- `MAX_EVENT_EXPOSURE_PCT`
- `MAX_POSITIONS`
- `MAX_TRADE_PCT`
- `MIN_TRADE_USD`
- `INITIAL_BANKROLL_USD`

Agent / Pulse：

- `AGENT_RUNTIME_PROVIDER`
- `AGENT_DECISION_STRATEGY`
- `PROVIDER_TIMEOUT_SECONDS`
- `PULSE_TIMEOUT_MODE`
- `PULSE_SOURCE_REPO`
- `PULSE_SOURCE_REPO_DIR`
- `PULSE_FETCH_TIMEOUT_SECONDS`
- `PULSE_PAGES`
- `PULSE_EVENTS_PER_PAGE`
- `PULSE_MIN_FETCHED_MARKETS`
- `PULSE_MIN_LIQUIDITY_USD`
- `PULSE_MAX_CANDIDATES`
- `PULSE_REPORT_CANDIDATES`
- `PULSE_REPORT_COMMENT_LIMIT`
- `PULSE_REPORT_TIMEOUT_SECONDS`
- `PULSE_DIRECT_RENDER_TIMEOUT_SECONDS`
- `PULSE_MIN_TRADEABLE_CANDIDATES`
- `PULSE_MAX_AGE_MINUTES`
- `PULSE_MAX_MARKDOWN_CHARS`
- `PULSE_AI_PRESCREEN`

Provider：

- `CODEX_COMMAND`
- `CODEX_MODEL`
- `CODEX_SKILL_ROOT_DIR`
- `CODEX_SKILL_LOCALE`
- `CODEX_SKILLS`
- `OPENCLAW_COMMAND`
- `OPENCLAW_MODEL`
- `OPENCLAW_SKILL_ROOT_DIR`
- `OPENCLAW_SKILL_LOCALE`
- `OPENCLAW_SKILLS`
- 代码也支持 `CLAUDE_CODE_*` 系列配置。

Rough-loop 相关不是交易主链路，但存在于仓库：

- `ROUGH_LOOP_PROVIDER`
- `ROUGH_LOOP_FILE`
- `ROUGH_LOOP_POLL_SECONDS`
- `ROUGH_LOOP_MAX_RETRIES`
- `ROUGH_LOOP_TASK_TIMEOUT_MINUTES`
- `ROUGH_LOOP_REQUIRE_CLEAN_TREE`
- `ROUGH_LOOP_RELAX_GUARDRAILS`
- `ROUGH_LOOP_AUTO_COMMIT`
- `ROUGH_LOOP_AUTO_PUSH`
- `ROUGH_LOOP_PAUSE_FILE`

### 关键数据结构

`PulseCandidate`：

- 字段：`question`、`eventSlug`、`marketSlug`、`url`、`liquidityUsd`、`volume24hUsd`、`outcomes`、`outcomePrices`、`clobTokenIds`、`endDate`、`bestBid`、`bestAsk`、`spread`、`categorySlug`、`categoryLabel`、`categorySource`、`tags`、`negRisk`、`feesEnabled`、`feeSchedule`。
- PolyPulse 应保留这个结构的概念，但字段名可以按自身语言/栈重新定义；核心是把市场、赔率、流动性、token、费用和证据上下文解耦清楚。

`PulseSnapshot`：

- 字段：`id`、`generatedAtUtc`、`title`、`relativeMarkdownPath`、`absoluteMarkdownPath`、`relativeJsonPath`、`absoluteJsonPath`、`markdown`、`totalFetched`、`totalFiltered`、`selectedCandidates`、`minLiquidityUsd`、`fetchConfig`、`categoryStats`、`tagStats`、`candidates`、`riskFlags`、`tradeable`。
- 设计重点：snapshot 是运行时事实源之一，必须有生成时间、候选集、风险标记、产物路径。

`TradeDecisionSet`：

- 顶层：`run_id`、`runtime`、`generated_at_utc`、`bankroll_usd`、`mode`、`decisions`、`artifacts`。
- `mode` 限定为 `review`、`scan`、`full`。
- `decision.action`：`open`、`close`、`reduce`、`hold`、`skip`。
- `decision.side`：`BUY`、`SELL`。
- `decision.order_type`：`FOK`、`GTC`。
- 核心概率字段：`ai_prob`、`market_prob`、`edge`、`confidence`。
- 审计字段：`thesis_md`、`sources`、`artifacts`。
- 风控/执行字段：`notional_usd`、`full_kelly_pct`、`quarter_kelly_pct`、`reported_suggested_pct`、`liquidity_cap_usd`、`position_value_usd`、`execution_amount`、`execution_unit`、`stop_loss_pct`、`resolution_track_required`。

`PublicPosition`：

- 字段：`id`、`event_slug`、`market_slug`、`token_id`、`side`、`outcome_label`、`size`、`avg_cost`、`current_price`、`current_value_usd`、`unrealized_pnl_pct`、`stop_loss_pct`、`opened_at`、`updated_at`。

DB 表：

- `agent_runs`、`agent_decisions`、`execution_events`、`positions`、`portfolio_snapshots`、`risk_events`、`resolution_checks`、`tracked_sources`、`artifacts`、`system_state`。
- PolyPulse 可以先定义接口与事件模型，不必立即复制 Drizzle/Postgres 实现。

### 风控规则

系统级：

- `pause` 和 `halted` 是 fail-closed 状态。
- drawdown 超阈值后禁止新开仓，只能管理员 resume。
- README 与 `docs/risk-controls.md` 对系统级回撤阈值存在不一致：README 写 30%，风险文档写 20%，代码默认 `services/orchestrator/src/config.ts` 为 30%，executor config 默认为 20%。PolyPulse 后续必须统一单一事实源，不能让文档、orchestrator 和 executor 分叉。

仓位级：

- 单仓止损默认 30%。
- 止损高于普通策略动作。
- `hold`、`close`、`reduce` 只能引用当前真实持仓里的 token。
- Position Review 中的重要阈值：`STRONG_EDGE_THRESHOLD=0.05`、`NEGATIVE_EDGE_CLOSE_THRESHOLD=-0.05`、`NEAR_STOP_LOSS_RATIO=0.7`。
- 无反向证据时默认 hold，但会标记 human review；接近止损且无新支持时 reduce；突破止损直接 close。

Pulse 级：

- 不使用 mock pulse fallback。
- Pulse 必须来自真实抓取。
- Pulse 过期、候选不足、候选缺少 `clobTokenIds` 都是风险状态。
- 有风险标记时禁止任何新的 open。
- open 的 token 必须来自 pulse candidates。
- 代码要重算 1/4 Kelly，不能直接信任报告里的建议仓位。

执行级：

- Orchestrator 默认：`MAX_TRADE_PCT=0.15`、`MAX_TOTAL_EXPOSURE_PCT=0.8`、`MAX_EVENT_EXPOSURE_PCT=0.3`、`MAX_POSITIONS=22`、`MIN_TRADE_USD=5`、`POSITION_STOP_LOSS_PCT=0.3`。
- 风险文档中的旧值与代码默认也存在不一致：风险文档写总敞口 50%、单笔 5%、最多 10 仓；代码默认是总敞口 80%、单笔 15%、最多 22 仓。PolyPulse 应优先建立测试覆盖，确保文档与代码一致。
- `applyTradeGuardsDetailed()` 只向下裁剪，不为了凑交易所最小单反向加仓。
- `DEFAULT_MAX_SLIPPAGE_PCT=0.04`，超过 slippage ceiling 的 notional 会压缩；压缩后低于交易所最小单则跳过。
- GTC 默认关闭，除非 `ENABLE_GTC_ORDERS=true`；close/reduce、fee-free、wide spread 都用 FOK；`MAX_SPREAD_FOR_GTC=0.05`。
- live smoke trade 必须显式开启并限制金额；专用测试钱包与 allowlist 是必要保护。

费用与 edge：

- Fee 默认按 category 静态估算，negRisk 且未显式 fee-enabled 时可视为 0 fee。
- `calculateNetEdge()` 会扣除 entry fee，默认假设 hold to settlement。
- 执行前会尝试查 CLOB fee-rate 做 mismatch 诊断，差异写 `fee-discrepancies.jsonl`，不阻塞交易。

### 运行产物目录

- `runtime-artifacts/reports/pulse/YYYY/MM/DD/`：Pulse Markdown 与 JSON。
- `runtime-artifacts/reports/review/YYYY/MM/DD/`：组合 review 报告。
- `runtime-artifacts/reports/monitor/YYYY/MM/DD/`：monitor 报告。
- `runtime-artifacts/reports/rebalance/YYYY/MM/DD/`：rebalance 报告。
- `runtime-artifacts/reports/runtime-log/YYYY/MM/DD/`：runtime 决策日志。
- `runtime-artifacts/pulse-live/<timestamp>-<runId>/`：pulse live 直接执行归档，包含 `preflight.json`、`recommendation.json`、`execution-summary.json`、`error.json`、`run-summary.md`、`run-summary.en.md` 等。
- `runtime-artifacts/live-test/<timestamp>-<runId>/`：stateful live test 归档。
- `runtime-artifacts/checkpoints/trial-recommend/`：paper recommendation checkpoint、latest、error artifact。
- `runtime-artifacts/local/paper-state.json`：paper 默认本地状态。
- `run-error/<timestamp>-<reason>/`：AGENTS 文档要求的失败归档约定。

### Paper / live 模式差异

Paper / trial：

- `AUTOPOLY_EXECUTION_MODE=paper` 时默认使用 local state file。
- `trial:recommend` 生成推荐并保存为 `awaiting-approval`，不会立刻更新持仓。
- `trial:approve` 才执行 paper fill，更新 cash、positions、trades、equity curve，并检查 drawdown halt。
- 失败时保存 checkpoint 和 error artifact，可以 `--resume-run-id` 或 `--resume-latest` 续跑。
- paper 路径仍复用 `buildExecutionPlan()`，保证和 live 一样经过核心 guardrails 与交易所门槛检查。

Live direct (`pulse:live`)：

- 强制 preflight：execution mode 必须 live、必须加载 env file、必须有钱包字段、collateral 对 execute 模式是阻塞检查。
- `--recommend-only` 仍跑 preflight、Pulse、runtime、execution plan 和归档，但不调用真实下单；零 collateral 在 recommend-only 下可继续。
- 非 recommend-only 会调用 `executeMarketOrder()` 真实下单，失败写 error artifact 和 run-summary。
- 会拉远端持仓与余额，并在运行结束追加 equity snapshot。

Live stateful (`live:test`)：

- 需要 Postgres、Redis、CLOB 初始化、专用 env、空远端持仓、空本地状态、固定小 bankroll、严格 trade cap。
- 通过 BullMQ 把交易交给 executor worker，再 sync portfolio。
- 失败可 halt system，保留 `error.json` 与 run summary。

PolyPulse 安全结论：

- 默认模式应与 Predict-Raven 相反：默认 `recommend-only` 或 `paper`，所有 live 命令必须显式 `preflight` + `dry-run`/`recommend-only` + 人类确认。
- 不允许任何 skill 或 CLI 默认使用 live 真实下单。

### provider-runtime / pulse-direct 思路

`pulse-direct`：

- 优点：可测试、可审计、稳定，不依赖外部 LLM 直接输出交易 JSON；关键 sizing、排序、风控在代码里。
- 入口计划来自 Pulse Markdown：解析推荐段落、提取方向、概率、流动性上限、置信度、推理文本。
- 排序：按 `monthlyReturn = netEdge / monthsToResolution`，缺失 endDate 时 fallback 180 天。
- 默认最多取 top 4，再套 20% batch cap。
- 与 Position Review 合并时，已有同 token 持仓可在 hold 且同方向时 merge add-on；冲突或重复会跳过并记录原因。

`provider-runtime`：

- 优点：适合作为多 provider 对照、复杂人工推理或早期探索。
- 风险：外部进程可能超时、输出非法、扫描范围失控、产生不可控字段。
- Predict-Raven 用 schema、read-only sandbox、限定 prompt、runtime heartbeat、temp dir、output schema 来收敛风险。
- PolyPulse 可以借鉴 provider abstraction，但默认不应让 provider 输出直接控制 live execution。

### 可以借鉴但不应直接照搬的点

可以借鉴：

- 四层架构：Pulse/Research -> Decision/Runtime -> Execution/Risk -> State/Archive/UI。
- 服务层硬风控，而不是 prompt 风控。
- `TradeDecisionSet` 这类强 schema 契约。
- 所有运行有 preflight、artifact、run summary、error artifact。
- paper 与 live 共享 execution planning，减少两套逻辑漂移。
- `pulse-direct` 的 deterministic decision runtime 思路。
- Position Review 与新开仓推荐分离。
- `recommend-only` 和 `awaiting-approval` 作为 live 前置状态。
- 失败时保留 provider temp、prompt、schema、partial output 的诊断思路。
- `tracked_sources` / `resolution_checks` 的可追溯设计。

不应直接照搬：

- 不照搬 `daily:pulse` 默认真钱 live 的行为；PolyPulse 默认必须 safe。
- 不照搬 `.env.pizza`、真实钱包默认文件名或任何账户习惯。
- 不照搬 `@autopoly/*` 命名、产品品牌、Web UI 文案或公开地址。
- 不照搬当前文档与代码不一致的阈值；PolyPulse 应先建单一配置事实源。
- 不过早绑定 pnpm monorepo、Drizzle、BullMQ、Vercel、Hostinger；只有在 PolyPulse 自身需求确认后再选型。
- 不把 vendor 仓库作为不可替换核心；应定义 evidence collector / market data provider / execution adapter 接口。
- 不复制 fallback 交易启发式；缺少完整证据时宁可 no-trade。
- 不让 provider CLI 有过宽文件访问；输入范围必须最小化。

### 接口推断：PolyPulse 后续应先定义的边界

Market data：

- `MarketScanner.scan(filters) -> MarketSnapshot`
- `OrderBookReader.read(tokenId) -> OrderBookSnapshot`
- `BalanceReader.read(accountRef) -> BalanceSnapshot`

Evidence：

- `EvidenceCollector.collect(market) -> EvidenceBundle`
- `EvidenceBundle` 至少包含 market rules、resolution source、external evidence、retrieved_at、source confidence、diagnostic gaps。

Prediction：

- `ProbabilityEstimator.estimate(market, evidence) -> ProbabilityEstimate`
- 输出必须区分 `market_prob`、`ai_prob`、`edge`、`confidence`、`reasoning`、`sources`。

Decision：

- `DecisionPlanner.plan(snapshot, estimates, portfolio) -> TradeDecisionSet`
- `PositionReviewer.review(portfolio, estimates) -> PositionReview[]`
- `RiskEngine.apply(decisions, portfolio, orderbooks, balances) -> ExecutionPlan`

Execution：

- `ExecutionAdapter.preflight() -> PreflightReport`
- `ExecutionAdapter.dryRun(plan) -> DryRunReport`
- `ExecutionAdapter.execute(plan, liveConfirmation) -> ExecutionResult`
- live adapter 必须 require explicit confirmation token/run id。

Archive：

- `ArtifactStore.write(kind, runId, content) -> ArtifactRef`
- 所有阶段必须写 input summary、decision summary、risk summary、failure diagnostics。

### 失败原因与测试观察

- 未运行 Predict-Raven 测试，因为本阶段是目标仓库文档沉淀，不修改源仓库。
- 源仓库阅读发现风控阈值存在文档/代码漂移，应在 PolyPulse 的第一批测试中覆盖配置默认值与文档生成。
- Full Pulse 的当前代码选择了无 fallback，符合安全优先；旧 deterministic fallback 代码仍在文件中，但 catch 中明确 throw。后续迁移时要看实际调用分支，不能只看历史函数存在。
- `poly-cli` 是 read fallback 与 execute wrapper 的混合入口；PolyPulse 应把 read-only 查询与 trade execution 明确拆成不同接口，避免工具名掩盖风险等级。
- `recommend-only` 在 Predict-Raven 中仍要求 live env 与 wallet 字段，但允许零 collateral；PolyPulse 可以更进一步支持无钱包扫描/预测模式，把 wallet preflight 仅放到 execution 前。

### 本阶段创建/修改的关键文件

- `docs/memory/POLYPULSE_MEMORY.md`
- `skills/polypulse-market-agent/SKILL.md`
- `docs/learned-from-predict-raven.md`

### 本阶段验证命令

已执行：

```bash
git diff --check -- docs/memory/POLYPULSE_MEMORY.md skills/polypulse-market-agent/SKILL.md docs/learned-from-predict-raven.md
test -s docs/memory/POLYPULSE_MEMORY.md
test -s skills/polypulse-market-agent/SKILL.md
test -s docs/learned-from-predict-raven.md
```

附加验证：

```bash
rg -n "(PRIVATE_KEY|API_KEY|SECRET|TOKEN|COOKIE|SESSION)[[:space:]]*[:=]" docs/memory/POLYPULSE_MEMORY.md skills/polypulse-market-agent/SKILL.md docs/learned-from-predict-raven.md
rg -n "[[:blank:]]+$" docs/memory/POLYPULSE_MEMORY.md skills/polypulse-market-agent/SKILL.md docs/learned-from-predict-raven.md
git status --short
```

观察：第一次 secret 扫描使用了过窄的 `NAME=` 模式，命中了本文件里的验证命令本身；已改为可复用的分隔符模式，避免自匹配。复验未发现 secret 赋值模式，未发现行尾空白。`git status --short` 显示本阶段新增 `docs/` 与 `skills/`。

建议下一阶段继续执行：

```bash
git status --short
rg -n "(PRIVATE_KEY|API_KEY|SECRET|TOKEN|COOKIE|SESSION)[[:space:]]*[:=]" docs/memory/POLYPULSE_MEMORY.md skills/polypulse-market-agent/SKILL.md docs/learned-from-predict-raven.md
rg -n "[[:blank:]]+$" docs/memory/POLYPULSE_MEMORY.md skills/polypulse-market-agent/SKILL.md docs/learned-from-predict-raven.md
```

## 2026-04-30 · 阶段 2：产品需求与架构规格

### 阶段边界

- 本阶段只写规格，不实现核心交易逻辑。
- 目标是把上一阶段从 Predict-Raven 学到的原则转成 PolyPulse 自己的产品需求、架构边界、风控规格和测试计划。
- 未修改真实 env，未运行 live 命令，未引入具体技术栈绑定。

### 规格文件

- `docs/specs/product-requirements.md`：产品目标、用户场景、功能需求、性能目标、安全要求和 MVP 验收顺序。
- `docs/specs/architecture.md`：模块图、接口定义、核心数据模型、运行流程、并发限流、幂等、部署形态和安全边界。
- `docs/specs/risk-controls.md`：默认安全模式、secret/env 规则、AI 输出边界、市场/证据/交易风控、live 确认、monitor 风控、去重和 artifact 治理。
- `docs/specs/testing-plan.md`：单元、契约、集成、端到端、性能、安全、恢复测试矩阵。

### 产品需求分析

PolyPulse 的产品核心不是“下单脚本”，而是一个证据驱动的预测市场决策系统。必须覆盖从账户读取、市场扫描、证据抓取、概率估算、edge 计算、流动性过滤到 paper/live 执行和长期监控的完整链路。

关键产品选择：

- 默认 paper，不默认 live。这与 Predict-Raven 当前 `daily:pulse` 默认 live 行为不同，是 PolyPulse 的核心安全差异。
- 用户可以无钱包运行 scan / evidence / probability / recommend-only；真实钱包 preflight 只在 live execution 前成为必需。
- paper once 和 paper monitor 是优先验证路径；live once 在显式确认后开放；live monitor 是最后阶段，并且默认 recommend-only。
- no-trade 是一等结果。证据不足、概率不稳、流动性不足、重复锁失败或风控裁剪后低于最小单，都应该产出可复盘的 skip，而不是静默失败。

### 架构权衡

本阶段按接口定义系统，不限定技术栈：

- `MarketSource` 负责市场、订单簿、账户余额和持仓读取。它屏蔽 Polymarket API 细节，必须支持分页和大量市场扫描。
- `EvidenceCrawler` 负责外部证据，必须可并发、可限流、可缓存，并记录 evidence gaps。
- `ProbabilityEstimator` 负责 AI 概率估计，但只输出结构化建议，不具备下单权限。
- `DecisionEngine` 汇总 AI 概率、市场隐含概率、edge、费用、流动性和持仓上下文。
- `RiskEngine` 是 broker 前强制边界，所有 paper/live order 都必须通过。
- `Broker` 抽象执行；`PaperBroker` 更新模拟状态；`LiveBroker` 连接真实 Polymarket，必须验证 live confirmation。
- `StateStore` 保存 run stage、checkpoint、cursor、dedupe lock、order id 和 portfolio，用于 crash recovery。
- `ArtifactWriter` 做归档、脱敏、索引、保留和清理，避免 runtime artifacts 无限膨胀。
- `Scheduler` 做一次性运行和持久 monitor，负责并发、心跳、重试和恢复。
- `Reporter` 输出短状态或告警，长分析写 artifact / memory。

### 性能目标分析

PolyPulse 必须按大量市场设计：

- Market scan 支持数千到数万市场的分页扫描，不能把整个系统写成几十个固定市场的循环。
- scan、evidence、probability estimate 可以并发，但每类外部依赖都有独立 rate limit、timeout 和 retry。
- Broker submit 对同账户应串行化或受强锁保护，避免 nonce/order state 问题。
- 高频 monitor 必须有 market snapshot hash、evidence TTL、source content hash 和 decision dedupe key，避免重复抓取与重复下单。
- artifact 与 memory 要有 retention policy：近期保留原始材料，历史材料压缩或摘要化，但保留 run summary、risk result、execution result 索引。

### 风控设计分析

安全要求被拆成几层：

- Secret 层：不落盘、不打印、不进 artifact、不进 memory、不进测试快照。
- Env 层：live preflight 缺字段、格式错、env 文件不可读、关键配置不匹配时 fail-fast。
- AI 层：AI 输出只能是建议，必须 schema 校验，不能越过 RiskEngine。
- Market / evidence 层：缺 token、缺规则、价格异常、证据 stale 或 evidence gaps 都要影响 confidence 或进入 no-trade。
- Trade 层：RiskEngine 统一执行 bankroll、单笔、总敞口、单事件敞口、持仓数、最小单、slippage、dedupe 和 live confirmation 检查。
- Recovery 层：broker submit 后 crash 必须先查 broker order id；状态未知进入 manual review，不重复提交。

### 测试策略分析

测试计划优先覆盖高风险不变量：

- 默认 paper。
- live 未确认永远 blocked。
- env 校验失败 fail-fast。
- AI 越权输出被 schema 或 RiskEngine 拒绝。
- 低流动性与最小单场景只会向下裁剪或 skip。
- 大量市场扫描不会导致系统内存或 artifact 不受控增长。
- 高频轮询命中 cache，不重复抓取未变化证据。
- 同一 market/event/outcome/side/action/timeWindow 的 dedupe lock 能阻止重复误下单。
- crash 后不重复 live submit。

### 失败原因与验证观察

- 本阶段没有业务代码，因此没有运行单元测试或集成测试。
- 规格中写了后续实现阶段建议命令，但这些命令目前可能尚未存在；这是有意的接口/产品目标，不代表当前已实现。
- 为避免误导，文档中所有 CLI 都以未来意图或验证建议表达，不声称已可运行。
- 设计文件没有写入 secret 赋值模式。

### 本阶段创建/修改的关键文件

- `docs/specs/product-requirements.md`
- `docs/specs/architecture.md`
- `docs/specs/risk-controls.md`
- `docs/specs/testing-plan.md`
- `docs/memory/POLYPULSE_MEMORY.md`

### 本阶段验证命令

已执行：

```bash
git diff --check -- docs/specs/product-requirements.md docs/specs/architecture.md docs/specs/risk-controls.md docs/specs/testing-plan.md docs/memory/POLYPULSE_MEMORY.md
test -s docs/specs/product-requirements.md
test -s docs/specs/architecture.md
test -s docs/specs/risk-controls.md
test -s docs/specs/testing-plan.md
rg -n "(PRIVATE_KEY|API_KEY|SECRET|TOKEN|COOKIE|SESSION)[[:space:]]*[:=]" docs/specs docs/memory/POLYPULSE_MEMORY.md
rg -n "[[:blank:]]+$" docs/specs docs/memory/POLYPULSE_MEMORY.md
```
