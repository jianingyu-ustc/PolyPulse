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

## 2026-04-30 · 阶段 3：初始化工程骨架和统一命令

### 阶段边界

- 本阶段实现最小可运行工程骨架，不接入真实 Polymarket 下单，不实现完整生产交易逻辑。
- 选择最少依赖方案：Node.js ESM + 内置 `node:test`，不引入第三方包，不绑定 pnpm workspace / 数据库 / 队列。
- CLI 通过 `bin/polypulse.js` 暴露；`package.json` 配置 `bin.polypulse` 和 `npm run polypulse`。
- LiveBroker 是 fail-closed scaffold：即使传入 `--confirm LIVE`，如果 live env preflight 不通过，也只产出 blocked risk，不会下单。

### 目录结构

新增结构按 `docs/specs/architecture.md` 的接口边界组织：

- `bin/polypulse.js`：统一 CLI 入口。
- `src/cli.js`：命令解析与 orchestration。
- `src/config/env.js`：无依赖 env file parser、配置默认值、live/paper preflight、secret redaction。
- `src/domain/types.js`：JSDoc domain types：Market、Outcome、Evidence、ProbabilityEstimate、TradeCandidate、TradeDecision、RiskDecision、OrderRequest、OrderResult、PortfolioSnapshot、RunArtifact。
- `src/domain/schemas.js`：最小运行时 schema validator。
- `src/ports/interfaces.js`：架构端口清单：MarketSource、EvidenceCrawler、ProbabilityEstimator、DecisionEngine、RiskEngine、Broker、PaperBroker、LiveBroker、StateStore、ArtifactWriter、Scheduler、Reporter。
- `src/adapters/mock-market-source.js`：Mock Polymarket MarketSource，用于 smoke 和离线开发。
- `src/adapters/evidence-crawler.js`：EvidenceCrawler scaffold，生成占位 evidence bundle 和 evidence gaps。
- `src/core/probability-estimator.js`：本地 deterministic ProbabilityEstimator scaffold。
- `src/core/decision-engine.js`：DecisionEngine scaffold，计算 gross/net edge 并输出 open/skip。
- `src/core/risk-engine.js`：RiskEngine scaffold，强制 amount、exposure、token、live confirmation 和 live preflight 检查。
- `src/brokers/paper-broker.js`：PaperBroker，更新本地模拟现金和持仓。
- `src/brokers/live-broker.js`：LiveBroker fail-closed scaffold。
- `src/state/file-state-store.js`：文件 StateStore，保存 paper portfolio、orders、runs、dedupe locks。
- `src/artifacts/artifact-writer.js`：ArtifactWriter，写 redacted JSON artifact 到 `runtime-artifacts/runs/<date>/<runId>/`。
- `src/scheduler/scheduler.js`：最小 Scheduler，支持 runOnce 和 monitorRun。
- `src/reporters/console-reporter.js`：Reporter scaffold，支持短状态输出。
- `test/smoke.test.js`：Node 内置测试。

### 统一 CLI 语义

已实现以下命令语义：

```bash
node ./bin/polypulse.js env check
node ./bin/polypulse.js account balance --env-file .env.example
node ./bin/polypulse.js market topics --limit 20
node ./bin/polypulse.js predict --market market-001
node ./bin/polypulse.js trade once --mode paper --market market-001 --side yes --amount 1
node ./bin/polypulse.js trade once --mode live --market market-001 --side yes --amount 1 --confirm LIVE
node ./bin/polypulse.js monitor run --mode paper
node ./bin/polypulse.js monitor run --mode live --confirm LIVE
```

`package.json` 也配置了：

```bash
npm run polypulse -- env check
npm test
npm run smoke
```

### 配置设计

`.env.example` 只包含 PolyPulse 当前需要的最小配置：

- `POLYPULSE_EXECUTION_MODE=paper`
- live 凭据字段名：`PRIVATE_KEY`、`FUNDER_ADDRESS`、`SIGNATURE_TYPE`、`CHAIN_ID`、`POLYMARKET_HOST`
- 本地状态：`STATE_DIR`、`ARTIFACT_DIR`
- 风控：`MAX_TRADE_PCT`、`MAX_TOTAL_EXPOSURE_PCT`、`MAX_EVENT_EXPOSURE_PCT`、`MIN_TRADE_USD`
- 扫描和监控：`MARKET_SCAN_LIMIT`、`MONITOR_INTERVAL_SECONDS`
- AI hook：`AI_PROVIDER`、`AI_MODEL`、`AI_COMMAND`

设计取舍：

- 没有照抄 Predict-Raven 的 DB、Redis、provider、rough-loop、deployment 全量变量。
- `.env.example` 不含真实值；live secret 字段留空。
- paper 模式不需要 private key。
- live 模式 env check 会要求 env file、private key、funder、signature type、chain id 和 host；缺失时 fail-fast。

### 骨架行为

- `market topics` 使用 mock market source 返回 3 个固定示例市场，可按 `--limit` 截断。
- `predict` 先生成 placeholder evidence，再用 deterministic estimator 输出概率；当前不调用外部 AI。
- `trade once --mode paper` 会跑 evidence -> estimate -> decision -> risk -> PaperBroker，并写 artifact。
- `trade once --mode live --confirm LIVE` 会跑到 RiskEngine；由于 `.env.example` 缺 live secrets，RiskEngine 返回 `live_preflight_failed`，不会调用真实下单。
- `monitor run --mode paper` 获取 monitor dedupe lock，然后执行一次 runOnce。
- `monitor run --mode live --confirm LIVE` 同样因 live preflight 缺失而 blocked。

### 安全观察

- Live path 现在有两层保护：RiskEngine 检查 `confirmation === "LIVE"` 和 live env preflight；LiveBroker 也再次 preflight 并默认 scaffold-only blocked。
- ArtifactWriter 在写 JSON 前调用 `redactSecrets()`，会按 key 和字符串模式脱敏常见 secret。
- `.gitignore` 忽略 `.env`、`.env.*`、`runtime-artifacts/`、`state/`、`node_modules/`，但显式允许 `.env.example`。
- CLI 输出包含 artifact 路径和脱敏账户，不输出 private key。

### 测试观察

已运行：

```bash
npm test
npm run smoke
node ./bin/polypulse.js env check
node ./bin/polypulse.js account balance --env-file .env.example
node ./bin/polypulse.js market topics --limit 2
node ./bin/polypulse.js predict --market market-001
node ./bin/polypulse.js trade once --mode paper --market market-001 --side yes --amount 1
node ./bin/polypulse.js trade once --mode live --market market-001 --side yes --amount 1 --confirm LIVE
node ./bin/polypulse.js monitor run --mode paper
node ./bin/polypulse.js monitor run --mode live --confirm LIVE
```

结果：

- `npm test` 通过 5 个 smoke tests。
- `npm run smoke` 通过，依次完成 env check、market topics、paper trade once。
- paper trade once 产出 filled paper order，并更新本地 paper state。
- live trade once with confirm 没有真实执行，RiskEngine 返回 `live_preflight_failed`。
- monitor paper 可以执行一次 run；monitor live with confirm 仍被 live preflight 阻断。

### 失败与修正

- 初版 DecisionEngine 把两个 outcome 的相同 evidence ids 直接 flatMap 到 decision sources，导致重复 source id；已改为 `Set` 去重。
- 初版 RiskEngine 只检查 live confirmation，没有在 risk 层检查 live env preflight；已补上 `validateEnvConfig(..., mode: "live")`，让 live path 在 RiskEngine 阶段 fail-fast。

### 本阶段创建/修改的关键文件

- `package.json`
- `.gitignore`
- `.env.example`
- `bin/polypulse.js`
- `src/cli.js`
- `src/config/env.js`
- `src/domain/types.js`
- `src/domain/schemas.js`
- `src/ports/interfaces.js`
- `src/adapters/mock-market-source.js`
- `src/adapters/evidence-crawler.js`
- `src/core/probability-estimator.js`
- `src/core/decision-engine.js`
- `src/core/risk-engine.js`
- `src/brokers/paper-broker.js`
- `src/brokers/live-broker.js`
- `src/state/file-state-store.js`
- `src/artifacts/artifact-writer.js`
- `src/scheduler/scheduler.js`
- `src/reporters/console-reporter.js`
- `test/smoke.test.js`
- `docs/memory/POLYPULSE_MEMORY.md`

### 本阶段最终验证命令

```bash
npm test
npm run smoke
node ./bin/polypulse.js env check
node ./bin/polypulse.js account balance --env-file .env.example
node ./bin/polypulse.js market topics --limit 2
node ./bin/polypulse.js predict --market market-001
node ./bin/polypulse.js trade once --mode paper --market market-001 --side yes --amount 1
node ./bin/polypulse.js trade once --mode live --market market-001 --side yes --amount 1 --confirm LIVE
node ./bin/polypulse.js monitor run --mode paper
node ./bin/polypulse.js monitor run --mode live --confirm LIVE
git diff --check
rg -n "(PRIVATE_KEY|API_KEY|SECRET|TOKEN|COOKIE|SESSION)[[:space:]]*[:=]" . --glob '!runtime-artifacts/**' --glob '!node_modules/**' --glob '!.git/**'
```

### 本阶段补充验证观察

- `git diff --check` 通过，没有 whitespace error。
- `npm test` 通过 5 个 tests。
- `npm run smoke` 通过；该脚本依次执行 env check、market topics、paper trade once，并只生成本地 `runtime-artifacts/`。
- secret scan 命中仅为 `.env.example` 的空 `PRIVATE_KEY=` 占位符和 `src/config/env.js` 的空默认值；未发现非空 secret 赋值。
- `git status --short` 显示本阶段新增 scaffold 文件和 memory 修改；`runtime-artifacts/` 未出现在 status 中，说明已被 `.gitignore` 忽略。

## 2026-04-30 Stage 4 - Polymarket 市场话题抓取

### 目标与边界

本阶段实现 MarketSource 的真实 Polymarket Gamma 市场抓取能力，不实现交易执行、不抓外部证据、不改变 live 下单路径。默认交易安全姿态仍由 RiskEngine 和 Broker 保持；市场抓取只读 Polymarket public market data。

### 设计权衡

- 保持 Node.js ESM + built-in APIs，不引入 SDK 或第三方 HTTP/cache 依赖。
- CLI 支持 `POLYPULSE_MARKET_SOURCE=polymarket|mock` 和 `--source` 覆盖。真实市场抓取通过 `PolymarketMarketSource`，离线测试和无网络 smoke 可使用 mock。
- `POLYMARKET_HOST` 保留给 CLOB/live 相关路径；市场话题抓取新增 `POLYMARKET_GAMMA_HOST`，默认指向 Gamma public API。
- 大量扫描采用 offset pagination，按 `MARKET_PAGE_SIZE` 分页，最多 `MARKET_MAX_PAGES` 页，直到达到 limit 或无更多结果。
- 高频监控缓存使用 state dir 下本地 JSON cache，cache 命中必须在 scan result 中标记 `fromCache=true`；stale fallback 必须打 `fallback=true` 和 risk flags，避免把失败伪装成真实新鲜数据。
- Gamma 返回字段可能是 camelCase、snake_case、JSON string 或数组；normalizer 必须兼容多种形态，并输出统一 Market/Outcome schema。
- 扫描 artifact 单独写入 `runtime-artifacts/markets/<timestamp>/markets.json` 与 `summary.md`，与 run artifacts 分开，方便市场宇宙快照归档和清理。

### 源码阅读与接口推断

- predict-raven executor 曾使用 `https://gamma-api.polymarket.com/markets?limit=<n>&offset=<n>&active=true&closed=false&order=liquidity&ascending=false` 抓取 active markets。
- predict-raven 的 market pulse normalizer 重点读取 `outcomes`、`outcome_prices`、`clob_token_ids`、`liquidity`、`volume_24hr`、`category_slug`、`tags`、`end_date`。
- PolyPulse 不照搬其 provider-runtime 或 skill runtime；只借鉴分页、字段兼容、缺 token/缺价格风险标记和 active/closed filter 思路。

### 计划修改

- 扩展 env config：market source、Gamma host、cache TTL、page size、max pages、timeout、retry、rate limit、min fetched 风险阈值。
- 新增 `src/adapters/market-normalizer.js`：Polymarket raw row -> standard Market。
- 新增 `src/adapters/market-filters.js`：最小流动性、最小成交量、分类关键词、结束时间范围、tradable/active/closed filter。
- 新增 `src/adapters/polymarket-market-source.js`：分页抓取、限流、重试、timeout、cache、risk flags。
- 扩展 `ArtifactWriter` 支持 market scan artifacts。
- CLI `market topics` 增加 filter flags，并输出 market artifacts 路径。
- 补充 mock API、schema、filter、CLI smoke tests。

### 实现结果

- `src/adapters/polymarket-market-source.js`
  - 使用 Gamma `/markets` endpoint，默认 query：`limit`、`offset`、`active`、`closed`、`order=liquidity`、`ascending=false`。
  - 按 `MARKET_PAGE_SIZE` 和 `MARKET_MAX_PAGES` 分页，直到达到 request limit、返回短页或遇到错误。
  - `fetchJson()` 实现 per-request timeout、retry 和 429/5xx retry 判定；`rateLimit()` 通过 `MARKET_RATE_LIMIT_MS` 控制请求间隔。
  - cache 文件位于 `STATE_DIR/market-cache.json`；fresh cache 返回 `source=polymarket-gamma-cache`、`fromCache=true`、`riskFlags` 包含 `market_scan_cache_hit`。
  - fetch failed 且无 fresh data 时返回 `source=polymarket-gamma-error`、`fallback=true`、空 markets、`market_source_fetch_failed` 和 `market_scan_empty`，不会伪装成真实市场数据。
  - stale cache fallback 会标记 `stale_market_cache_used` 和 `market_source_fetch_failed`。

- `src/adapters/market-normalizer.js`
  - 兼容 camelCase、snake_case、数组、JSON string 数组字段。
  - 输出统一 Market：`marketId`、`eventId`、`marketSlug`、`eventSlug`、`question`、`title`、`marketUrl`、`outcomes`、`liquidityUsd`、`volumeUsd`、`volume24hUsd`、`endDate`、`category`、`tags`、`active`、`closed`、`tradable`、`source`、`riskFlags`、`fetchedAt`。
  - Outcome 包含 `id`、`label`、`tokenId`、`bestBid`、`bestAsk`、`lastPrice`、`impliedProbability`。
  - 缺 market id、slug、question、outcomes、token ids、price、liquidity、resolution rules 时进入 row-level risk flags。

- `src/adapters/market-filters.js`
  - 支持 `minLiquidityUsd`、`minVolumeUsd`、`categoryKeyword`、`endsAfter`、`endsBefore`、`tradableOnly`、`activeOnly`、`closedOnly`。
  - category keyword 会匹配 category、market slug、event slug、question、tags。

- `src/artifacts/artifact-writer.js`
  - 新增 `writeMarketScan(scan)`。
  - 写入 `runtime-artifacts/markets/<timestamp>/markets.json` 和 `runtime-artifacts/markets/<timestamp>/summary.md`。
  - 写入前复用 `redactSecrets()`，避免 artifacts 泄露 secret。

- `src/cli.js`
  - `createContext()` 支持 `--source mock|polymarket`。
  - `market topics` 支持 `--limit`、`--min-liquidity`、`--min-volume`、`--category`、`--ends-after`、`--ends-before`、`--tradable`、`--active`、`--closed`。
  - 输出包含 `source`、`totalFetched`、`totalReturned`、`riskFlags`、`artifacts.markets`、`artifacts.summary`。

- `.env.example` / `src/config/env.js`
  - 新增 `POLYPULSE_MARKET_SOURCE=polymarket`、`POLYMARKET_GAMMA_HOST=https://gamma-api.polymarket.com`。
  - 新增 scan knobs：`MARKET_PAGE_SIZE`、`MARKET_MAX_PAGES`、`MARKET_CACHE_TTL_SECONDS`、`MARKET_REQUEST_TIMEOUT_MS`、`MARKET_REQUEST_RETRIES`、`MARKET_RATE_LIMIT_MS`、`MARKET_MIN_FETCHED`。

### 测试与失败观察

已运行：

```bash
npm test
npm run smoke
node ./bin/polypulse.js market topics --limit 20
node ./bin/polypulse.js market topics --source mock --limit 20 --min-liquidity 15000 --min-volume 1000 --category ai --tradable true
git diff --check
rg -n "(PRIVATE_KEY|API_KEY|SECRET|TOKEN|COOKIE|SESSION)[[:space:]]*[:=]" . --glob '!runtime-artifacts/**' --glob '!node_modules/**' --glob '!.git/**'
```

结果：

- `npm test` 通过 8 个 tests：mock API pagination/cache、schema、filter、insufficient result risk flags、CLI smoke、paper trade、live confirmation block。
- `npm run smoke` 通过，使用 `--source mock` 避免依赖外部网络。
- `node ./bin/polypulse.js market topics --limit 20` 在当前受限网络环境下没有伪造数据，返回 `source=polymarket-gamma-error`、空 topics、risk flags：`market_source_fetch_failed`、`market_scan_empty`，并写入 market artifacts。
- filter smoke 返回 mock AI 市场 1 条，验证流动性、成交量、category、tradable filter 可用。
- `git diff --check` 通过。
- secret scan 只命中 `.env.example` 空 `PRIVATE_KEY=`、`src/config/env.js` 空默认值和本 memory 中对该观察的文字记录；未发现非空 secret。

失败修正：

- 初版 mock API test 使用本地 HTTP server + Node 25.2.1 `node --test`，触发 Node native assertion；改为注入 mock `fetchImpl`，仍覆盖 API pagination/cache 逻辑，但避免测试 runner 与本地 server/fetch 的 Node 版本问题。
- 初版 floating price 断言受 JS double 精度影响，测试改为保留两位比较。

### 本阶段创建/修改的关键文件

- `src/adapters/polymarket-market-source.js`
- `src/adapters/market-normalizer.js`
- `src/adapters/market-filters.js`
- `src/adapters/mock-market-source.js`
- `src/artifacts/artifact-writer.js`
- `src/config/env.js`
- `src/domain/schemas.js`
- `src/domain/types.js`
- `src/cli.js`
- `.env.example`
- `package.json`
- `test/market-source.test.js`
- `test/smoke.test.js`
- `docs/memory/POLYPULSE_MEMORY.md`

## 2026-04-30 Stage 5 - AI 证据抓取与胜率预测

### 目标与边界

本阶段实现核心分析模块：EvidenceCrawler 主动收集市场相关证据，ProbabilityEstimator 基于证据输出事件真实发生概率，DecisionEngine 将 AI 概率与市场隐含概率比较并生成交易候选或 no-trade reason。本阶段仍不实现真实 live 下单，所有 live 执行路径继续由 preflight、confirm 和 RiskEngine fail-closed 保护。

### 设计权衡

- 继续使用零第三方依赖的 Node.js ESM；AI/搜索能力先通过可替换 adapter/provider 接口表达，默认使用 deterministic local provider，避免为了演示引入不稳定外部依赖。
- EvidenceCrawler 不把搜索/抓取写死在单个函数里，而是使用 adapter contract：`id`、`search({ market })`、`fetch(ref, { market })`。默认 adapter 覆盖 market metadata 与 resolution source/rules。
- EvidenceCrawler 返回标准 `Evidence[]`，每条 evidence 包含 source、title、url/sourceUrl、timestamp/retrievedAt、summary、relevanceScore/relevance_score、status、credibility。
- Evidence cache 使用 `STATE_DIR/evidence-cache.json`，按 market、adapter、source ref 生成 key；cache hit 明确标记 `status=cached`，不会伪装成 fresh crawl。
- ProbabilityEstimator 支持 provider 注入，默认 local heuristic provider 只使用 evidence 摘要、relevance、freshness 和 market implied probability；证据不足时输出低 confidence 和 uncertainty factor，由 DecisionEngine 转成 no-trade。
- CLI `predict` 不打印完整证据和推理，只输出 probability、confidence、edge、expected value、artifact paths。完整复盘材料写入 prediction artifacts。
- DecisionEngine 保留 `decide()` 给交易路径使用，同时新增/强化 `analyze()` 供 predict 使用，输出 suggested side、market implied probability、edge、EV、suggested notional before risk 与 no-trade reason。

### 计划修改

- 扩展 Evidence schema、ProbabilityEstimate schema、TradeCandidate/TradeDecision schema。
- 重写 `src/adapters/evidence-crawler.js` 为 adapter-based crawler，支持 timeout、retry、dedupe、cache。
- 重写 `src/core/probability-estimator.js`，输出 `ai_probability`、confidence、reasoning summary、key/counter evidence、uncertainty factors、freshness score。
- 强化 `src/core/decision-engine.js`，支持正负 edge、no-trade、suggested notional before risk。
- 扩展 `ArtifactWriter`，写入 `runtime-artifacts/predictions/<timestamp>-<market>/evidence.json`、`estimate.json`、`decision.md`。
- 创建 prompt templates：`prompts/probability-estimation.md`、`prompts/evidence-search.md`、`prompts/trade-decision.md`。
- 增加 tests：mock EvidenceCrawler -> ProbabilityEstimator schema、fake AI -> DecisionEngine、positive/negative edge、insufficient evidence no-trade、CLI predict smoke。

### 实现结果

- `src/adapters/evidence-crawler.js`
  - Crawler 以 adapter 为边界，默认 adapter 为 `market-metadata` 和 `resolution-source`。
  - Adapter contract：`search({ market, signal }) -> refs`、`fetch(ref, { market, signal }) -> Evidence-like`。
  - 输出 `Evidence[]`，每条 evidence 包含 `source`、`title`、`sourceUrl/url`、`timestamp/retrievedAt`、`summary`、`relevanceScore/relevance_score`、`status`、`credibility`。
  - 支持 timeout、retry、dedupe 和 cache；cache 位于 `STATE_DIR/evidence-cache.json`，cache hit 明确标记 `status=cached`。
  - fetch 失败只生成 `status=failed` 的诊断 evidence，ProbabilityEstimator 会将其视为低质量/证据不足。

- `src/core/probability-estimator.js`
  - 支持 provider 注入；默认 `LocalHeuristicProbabilityProvider` 为 deterministic scaffold，不调用外部模型。
  - 输入 `Market + Evidence[]`，输出 `ProbabilityEstimate`。
  - 顶层字段包含 `ai_probability`、`confidence`、`reasoning_summary`、`key_evidence`、`counter_evidence`、`uncertainty_factors`、`freshness_score`，同时保留 camelCase mirror 以便内部调用。
  - 估计逻辑使用 market implied probability 作为 baseline，再结合 evidence relevance、credibility、freshness、文本正反信号和 category prior。
  - 证据不足、stale、缺市场价格或 market row risk flags 会进入 uncertainty factors，并通常导致 low confidence。

- `src/core/decision-engine.js`
  - `analyze()` 面向 predict：比较 yes/no 两侧，选择最大 net edge 或输出 no-trade。
  - `decide()` 面向 trade once：按用户指定 side 生成 TradeDecision，RiskEngine 仍是执行前强制门。
  - 计算 `market_implied_probability`、`edge`、`expected_value`、`suggested_side`、`suggested_notional_before_risk`。
  - `confidence=low`、`insufficient_evidence`、freshness 太低或 edge 不足时输出 no-trade reason。

- `src/artifacts/artifact-writer.js`
  - 新增 `writePrediction()`。
  - 写入：
    - `runtime-artifacts/predictions/<timestamp>-<market>/evidence.json`
    - `runtime-artifacts/predictions/<timestamp>-<market>/estimate.json`
    - `runtime-artifacts/predictions/<timestamp>-<market>/decision.md`
  - `decision.md` 记录概率、confidence、edge、EV、建议方向、no-trade reason、reasoning summary、key/counter evidence 和 uncertainty factors。
  - 继续使用 `redactSecrets()`。

- `src/cli.js`
  - `predict` 现在只向屏幕输出 compact summary：`ai_probability`、`confidence`、`market_implied_probability`、`edge`、`expected_value`、`suggested_side`、`action/no_trade_reason`、artifact paths。
  - 完整 evidence、estimate、decision 只写 artifact，不打印到屏幕。

- Prompt templates：
  - `prompts/evidence-search.md`
  - `prompts/probability-estimation.md`
  - `prompts/trade-decision.md`
  - 三个模板都强调必须基于证据、不得编造、证据不足时 no-trade、最终执行必须经过 RiskEngine。

### 测试与失败观察

已运行：

```bash
npm test
npm run smoke
node ./bin/polypulse.js predict --source mock --market market-001
git diff --check
rg -n "(PRIVATE_KEY|API_KEY|SECRET|TOKEN|COOKIE|SESSION)[[:space:]]*[:=]" . --glob '!runtime-artifacts/**' --glob '!node_modules/**' --glob '!.git/**'
```

结果：

- `npm test` 通过 14 个 tests。
- 新增覆盖：
  - mock EvidenceCrawler output -> ProbabilityEstimator schema。
  - EvidenceCrawler adapter dedupe/cache。
  - deterministic fake AI output -> positive edge open。
  - yes side negative edge skip，同时 best side 可切换到 no。
  - insufficient evidence -> no-trade。
  - CLI predict smoke 输出 compact probability 和 prediction artifacts。
- `npm run smoke` 通过：env check、market topics、predict、paper trade once。
- `node ./bin/polypulse.js predict --source mock --market market-001` 输出 compact summary，并写入 `runtime-artifacts/predictions/.../evidence.json`、`estimate.json`、`decision.md`。
- `git diff --check` 通过。
- secret scan 只命中 `.env.example` 空 `PRIVATE_KEY=`、`src/config/env.js` 空默认值和本 memory 中已有文字记录；未发现非空 secret。

### 本阶段创建/修改的关键文件

- `src/adapters/evidence-crawler.js`
- `src/core/probability-estimator.js`
- `src/core/decision-engine.js`
- `src/artifacts/artifact-writer.js`
- `src/cli.js`
- `src/scheduler/scheduler.js`
- `src/config/env.js`
- `src/domain/schemas.js`
- `src/domain/types.js`
- `src/ports/interfaces.js`
- `.env.example`
- `package.json`
- `prompts/evidence-search.md`
- `prompts/probability-estimation.md`
- `prompts/trade-decision.md`
- `test/analysis.test.js`
- `test/smoke.test.js`
- `docs/memory/POLYPULSE_MEMORY.md`

## 2026-04-30 Stage 6 - Account / Broker / OrderExecutor

### 目标与边界

本阶段实现账户余额、paper broker、live broker 安全接入层和统一 OrderExecutor。核心优先级是安全路径：缺 env fail-fast、private key 不打印、不落 artifact、live 默认禁止、真实 live 下单必须同时满足 `--mode live --confirm LIVE`、live preflight、balance check、RiskEngine allow。

### 源码参考

- predict-raven executor config 读取 `PRIVATE_KEY`、`FUNDER_ADDRESS`、`SIGNATURE_TYPE`、`POLYMARKET_HOST`、`CHAIN_ID`，默认 host 为 `https://clob.polymarket.com`、chain id 137。
- predict-raven 使用 `@polymarket/clob-client-v2` + `ethers Wallet` 创建 ClobClient，并通过 `getBalanceAllowance({ asset_type: "COLLATERAL" })` 查询 collateral balance/allowance。
- predict-raven market order 使用 `createAndPostMarketOrder({ tokenID, amount, side, orderType: FOK })`，并从 response 的 `takingAmount`、`makingAmount`、`price/avgPrice` 推导成交金额和均价。
- PolyPulse 不直接复制 predict-raven monorepo 结构；本阶段使用 `LivePolymarketClient` adapter 封装 SDK 调用，测试通过 mock client 注入，不在自动测试中真实下单。

### 设计权衡

- 不新增强依赖安装；`LivePolymarketClient` 通过 dynamic import 可选加载 `@polymarket/clob-client-v2` 和 `ethers`。若运行环境未安装 SDK，preflight 会 fail-closed，并给出 redacted error summary。
- LiveBroker 支持 mock client 注入，便于自动测试 balance/order path，但默认没有显式 live confirm 时拒绝。
- Account balance 使用独立 `AccountService`，paper 模式读取本地 state，live 模式走 `LiveBroker.getBalance()`。余额 artifact 独立写入 `runtime-artifacts/account/<timestamp>/balance.json`。
- OrderExecutor 是唯一 broker submit 入口：输入 `RiskDecision`，若 `risk.allowed !== true` 或 `risk.order` 缺失则直接 blocked，禁止绕过 RiskEngine 下单。
- Paper state 继续写入 `STATE_DIR/state.json`，支持 crash recovery；本阶段扩展 buy/sell 和 mark-to-market。

### 计划修改

- 扩展 env preflight 输出：env file path、chain id、masked funder，不包含 private key。
- 新增 account artifacts 写入方法。
- 新增 `src/account/account-service.js`。
- 新增 `src/brokers/live-polymarket-client.js`，封装 balance 和 market order。
- 强化 `PaperBroker` 和 `FileStateStore` 支持 buy/sell、orders、mark-to-market。
- 强化 `LiveBroker` 支持 preflight、balance check、mockable client、confirm gate、redacted errors。
- 新增 `src/execution/order-executor.js`，强制 RiskDecision gate。
- CLI `account balance` 使用 AccountService；`trade once` 使用 OrderExecutor。
- 增加 broker/account tests。

### 实现结果

- `src/config/env.js`
  - `validateEnvConfig()` live mode 检查 `PRIVATE_KEY`、`FUNDER_ADDRESS`、`SIGNATURE_TYPE`、`CHAIN_ID=137`、`POLYMARKET_HOST`。
  - preflight report 增加 `envFilePath`、`chainId`、masked `funderAddress`、`polymarketHost`，不包含 private key。
  - 新增 `summarizeEnvConfig()` 和 `assertLivePreflight()`。

- `src/account/account-service.js`
  - paper balance 读取 `STATE_DIR/state.json` 的 paper portfolio。
  - live balance 先跑 live env preflight，再通过 LiveBroker 查询 collateral。
  - 输出 execution mode、masked funder/proxy address、collateral balance、positions summary。

- `src/artifacts/artifact-writer.js`
  - 新增 `writeAccountBalance()`。
  - 写入 `runtime-artifacts/account/<timestamp>/balance.json`。
  - 写入前继续 `redactSecrets()`。

- `src/brokers/live-polymarket-client.js`
  - 封装 Polymarket CLOB SDK adapter，支持 `preflight()`、`getCollateralBalance()`、`postMarketOrder()`。
  - 通过 dynamic import 加载 `@polymarket/clob-client-v2` 和 `ethers`；缺 SDK 时 fail-closed。
  - 支持 clientFactory/mock client 注入，自动测试不触达真实 Polymarket。
  - 对 raw response/error summary 做 secret redaction。

- `src/brokers/live-broker.js`
  - 默认无 `confirmation === "LIVE"` 直接 blocked。
  - 有 confirm 后仍必须通过 env preflight、SDK/client preflight、balance check。
  - BUY 下单前校验 collateral balance。
  - 下单失败返回 redacted error summary；成功/失败都转为标准 OrderResult。

- `src/brokers/paper-broker.js` / `src/state/file-state-store.js`
  - paper submit 支持 BUY 和 SELL。
  - BUY 扣 cash、加仓；SELL 减仓、加 cash，仓位不足返回 rejected。
  - `recordOrder()` 记录 orders。
  - 新增 `markToMarket(markets)`，按 token price 更新 currentValueUsd 和 totalEquityUsd。
  - 状态继续写入 `STATE_DIR/state.json`，重启后可恢复。

- `src/execution/order-executor.js`
  - 唯一 broker submit gate。
  - 输入 `RiskDecision`；若 `risk.allowed !== true` 或 `risk.order` 缺失，直接返回 blocked OrderResult。
  - paper/live 共用同一接口，禁止绕过 RiskEngine 直接下单。

- `src/cli.js`
  - `env check` 输出 env summary，不打印 private key。
  - `account balance --env-file <path>` 使用 AccountService，并写 account artifact。
  - `trade once` 改用 OrderExecutor；即使 risk blocked，也写 execution artifact，便于审计。

### 测试与失败观察

已运行：

```bash
npm test
npm run smoke
node ./bin/polypulse.js account balance --env-file .env.example
node ./bin/polypulse.js env check --mode live --env-file .env.example
node ./bin/polypulse.js trade once --source mock --mode live --market market-001 --side yes --amount 1 --confirm LIVE --env-file .env.example
git diff --check
rg -n "(PRIVATE_KEY|API_KEY|SECRET|TOKEN|COOKIE|SESSION)[[:space:]]*[:=]" . --glob '!runtime-artifacts/**' --glob '!node_modules/**' --glob '!.git/**'
```

结果：

- `npm test` 通过 22 个 tests。
- 新增覆盖：
  - live env 缺字段 fail-fast。
  - env check 不打印 private key。
  - account balance 用 mock live broker 查询 collateral。
  - paper once order 支持 buy/sell、mark-to-market、crash recovery。
  - live order 默认拒绝。
  - live order 无 `--confirm LIVE` 拒绝。
  - OrderExecutor 在 RiskDecision 不 allow 时 blocked。
  - live broker 用 mock client 在 confirm 后可执行，未真实下单。
- `npm run smoke` 通过，包含 account balance。
- `account balance --env-file .env.example` 以 paper mode 返回 masked wallet、collateral balance，并写入 `runtime-artifacts/account/.../balance.json`。
- `env check --mode live --env-file .env.example` 返回 `ok=false`，明确缺 `PRIVATE_KEY`、`FUNDER_ADDRESS`、`SIGNATURE_TYPE`、`POLYMARKET_HOST`，未打印 private key。
- `trade once --mode live --confirm LIVE --env-file .env.example` 被 RiskEngine `live_preflight_failed` 阻断，OrderExecutor 返回 blocked execution artifact，没有真实下单。
- `git diff --check` 通过。
- secret scan 只命中 `.env.example` 空 `PRIVATE_KEY=`、`src/config/env.js` 空默认值和 memory 中已有文字记录；未发现非空 secret。

### 本阶段创建/修改的关键文件

- `src/account/account-service.js`
- `src/brokers/live-polymarket-client.js`
- `src/brokers/live-broker.js`
- `src/brokers/paper-broker.js`
- `src/execution/order-executor.js`
- `src/state/file-state-store.js`
- `src/artifacts/artifact-writer.js`
- `src/config/env.js`
- `src/cli.js`
- `src/scheduler/scheduler.js`
- `src/ports/interfaces.js`
- `package.json`
- `test/broker-account.test.js`
- `test/smoke.test.js`
- `docs/memory/POLYPULSE_MEMORY.md`

## 2026-04-30 Stage 7 - 服务层硬风控

### 目标与边界

本阶段将 RiskEngine 升级为代码层强制风控，不依赖 prompt。AI 和 DecisionEngine 只能提出建议，RiskEngine 负责最终 allow/block、金额裁剪、live preflight/balance gate、数据质量 gate、系统 pause/halt gate。本阶段不改变真实下单默认禁用原则。

### 设计权衡

- RiskEngine 改为 async，允许读取/更新 StateStore 中的 riskState：`active|paused|halted`、`highWaterMarkUsd`、`haltedAt`、`haltReason`。
- drawdown 超阈值时 RiskEngine 会调用 StateStore 进入 `halted`；恢复必须走显式 resume API/CLI，RiskEngine 不会因权益恢复自动解除 halted。
- FileStateStore 按 execution mode 隔离状态文件：`paper-state.json` 与 `live-state.json`，避免 paper/live portfolio、orders、riskState 混用。
- 风控金额只向下裁剪。若裁剪后低于 `MIN_TRADE_USD`，直接 blocked，不为了满足最小交易额上调 AI 建议金额。
- RiskDecision 兼容旧字段 `allowed/reasons/approvedUsd/order`，新增需求字段 `allow/adjusted_notional/blocked_reasons/warnings/applied_limits`。
- live balance check 在 RiskEngine 层做：调用传入的 `liveBalance`，若缺失或不足则 blocked；LiveBroker 仍保留二次检查。

### 计划修改

- 扩展 env：`MAX_POSITION_COUNT`、`MAX_POSITION_LOSS_PCT`、`DRAWDOWN_HALT_PCT`、`LIQUIDITY_TRADE_CAP_PCT`、`MARKET_MAX_AGE_SECONDS`、`MIN_AI_CONFIDENCE`。
- 扩展 StateStore：riskState、pause/halt/resume、mode-isolated state file。
- 重写 RiskEngine：系统级、仓位级、交易级、数据级、live 级规则；金额下裁剪与 applied limits。
- CLI/scheduler 改为 await RiskEngine，并传入 evidence/estimate/systemState/liveBalance。
- 增加 `risk status|pause|halt|resume` CLI，作为显式 resume 通道。
- 增加每条规则单测、组合规则、越权 token、stale market、裁剪低于最小额、live 未确认。

### 实现结果

- `src/core/risk-engine.js`
  - RiskEngine 改为 async，输出：
    - `allow` / `allowed`
    - `adjusted_notional` / `adjustedNotional`
    - `blocked_reasons` / `blockedReasons` / `reasons`
    - `warnings`
    - `applied_limits` / `appliedLimits`
    - `approvedUsd`
    - `order`
  - 系统级：
    - `system_paused` 禁止 open。
    - `system_halted_requires_explicit_resume` 禁止 open。
    - drawdown 超过 `DRAWDOWN_HALT_PCT` 返回 `drawdown_halt_threshold_exceeded`，并通过 StateStore 持久化 `status=halted`。
  - 仓位级：
    - 单仓亏损超过 `MAX_POSITION_LOSS_PCT` 产生 `position_loss_limit_triggered:<token>:suggest_reduce_or_close` warning。
    - 新 token 超过 `MAX_POSITION_COUNT` 返回 `above_max_position_count`。
  - 交易级：
    - 依次按 `MAX_TRADE_PCT`、`MAX_TOTAL_EXPOSURE_PCT`、`MAX_EVENT_EXPOSURE_PCT`、`LIQUIDITY_TRADE_CAP_PCT` 向下裁剪 notional。
    - AI/Decision 建议金额只参与向下裁剪：`min(requestedUsd, suggested_notional_before_risk)`。
    - 裁剪后低于 `MIN_TRADE_USD` 返回 `adjusted_notional_below_min_trade_usd`。
    - 初始 requested 低于 `MIN_TRADE_USD` 返回 `below_min_trade_usd`。
  - 数据级：
    - stale market 返回 `market_data_stale`。
    - evidence 不足返回 `insufficient_evidence`。
    - AI confidence 低于 `MIN_AI_CONFIDENCE` 返回 `ai_confidence_below_minimum`。
    - token 不在 market snapshot 返回 `token_not_in_market_snapshot`。
    - closed/inactive/not tradable 分别返回 `market_closed`、`market_inactive`、`market_not_tradable`。
  - live 级：
    - 无 `--confirm LIVE` 返回 `live_requires_confirm_live`。
    - env preflight 不通过返回 `live_preflight_failed`。
    - 缺 live balance 返回 `live_balance_check_missing`；balance 查询失败返回 `live_balance_check_failed`；collateral 不足返回 `insufficient_live_collateral`。

- `src/state/file-state-store.js`
  - 状态文件按 mode 隔离：`paper-state.json`、`live-state.json`。
  - 新增 riskState：`status`、`highWaterMarkUsd`、`haltedAt`、`haltReason`、`pausedAt`、`pauseReason`、`resumedAt`、`updatedAt`。
  - 新增 `getRiskState()`、`pauseRisk()`、`haltRisk()`、`resumeRisk()`。
  - `resumeRisk()` 是 halted/paused 的显式恢复通道，并把 high water mark 重置到当前 equity，避免自动恢复。

- `src/cli.js`
  - `trade once` 现在 await RiskEngine，并传入 evidence、estimate、stateStore、liveBalance/liveBalanceError。
  - live + confirm 会先尝试 AccountService balance check，失败只进入 RiskDecision，不泄露 secret。
  - 新增 `polypulse risk status|pause|halt|resume`。

- `src/scheduler/scheduler.js`
  - monitor run 使用带 StateStore 的 RiskEngine，继承相同硬风控。

- `.env.example` / `src/config/env.js`
  - 新增：`MAX_POSITION_COUNT`、`MAX_POSITION_LOSS_PCT`、`DRAWDOWN_HALT_PCT`、`LIQUIDITY_TRADE_CAP_PCT`、`MARKET_MAX_AGE_SECONDS`、`MIN_AI_CONFIDENCE`。

### 测试与失败观察

已运行：

```bash
npm test
npm run smoke
node ./bin/polypulse.js risk status --source mock
node ./bin/polypulse.js trade once --source mock --mode live --market market-001 --side yes --amount 1 --confirm LIVE --env-file .env.example
git diff --check
rg -n "(PRIVATE_KEY|API_KEY|SECRET|TOKEN|COOKIE|SESSION)[[:space:]]*[:=]" . --glob '!runtime-artifacts/**' --glob '!node_modules/**' --glob '!.git/**'
```

结果：

- `npm test` 通过 31 个 tests。
- 新增 RiskEngine 覆盖：
  - paused/halted block。
  - drawdown 超阈值进入 halted，resume 后才能恢复。
  - 单仓亏损 warning。
  - 最大持仓数量 block。
  - 单笔/总敞口/事件敞口/流动性 cap 裁剪组合。
  - requested 低于 min 和裁剪低于 min block。
  - stale market block。
  - insufficient evidence block。
  - low confidence block。
  - 越权 token block。
  - closed/inactive/not tradable block。
  - live 未确认、env preflight、balance missing、collateral insufficient block。
  - AI suggested notional 只能向下裁剪。
- `npm run smoke` 通过，paper trade 风控输出包含新 RiskDecision 字段。
- `risk status --source mock` 返回 active riskState。
- live trade with `--confirm LIVE --env-file .env.example` 被 `live_preflight_failed` 和 `live_balance_check_failed` 阻断，没有真实下单。
- `git diff --check` 通过。
- secret scan 只命中 `.env.example` 空 `PRIVATE_KEY=`、`src/config/env.js` 空默认值和 memory 中已有文字记录；未发现非空 secret。

### 本阶段创建/修改的关键文件

- `src/core/risk-engine.js`
- `src/state/file-state-store.js`
- `src/cli.js`
- `src/scheduler/scheduler.js`
- `src/config/env.js`
- `src/domain/schemas.js`
- `src/domain/types.js`
- `.env.example`
- `test/risk-engine.test.js`
- `docs/memory/POLYPULSE_MEMORY.md`

## 2026-04-30 Stage 8 - 一次性预测与下单闭环

### 目标与边界

本阶段打通 one-shot flow：market -> evidence -> estimate -> decision -> risk -> order/no-trade ->完整 run artifact。`predict` 仍只预测不下单；`trade once` 支持 paper/live，live 仍必须 `--mode live --confirm LIVE --env-file <path>` 且通过所有 preflight/risk/balance gate。

### 设计权衡

- 新增独立 one-shot runner，避免 CLI 里堆叠流程细节，也方便测试注入 mock live broker。
- `--max-amount` 作为新主参数，旧 `--amount` 只保留兼容；RiskEngine 继续只向下裁剪，不会为了最小额上调。
- 屏幕输出改为 compact summary：mode、market question、AI probability、market probability、edge、action、artifact path。
- 完整复盘写入 `runtime-artifacts/runs/<timestamp>-once/`，不再只写散落的 day/runId JSON。
- `order.json` 即使 no-trade 也写 blocked/no-trade 结果，便于审计闭环完整性。

### 计划修改

- 新增 `src/flows/once-runner.js`，封装 one-shot trade flow，支持 mock broker 注入。
- 扩展 ArtifactWriter：`writeOnceRun()` 写 input、market、evidence、estimate、decision、risk、order、summary.md。
- CLI `trade once` 改用 `--max-amount`，只输出 compact summary。
- CLI `predict` 保持 no-order compact summary。
- 增加 tests：paper one-shot 成功、no-trade、live 缺 confirm、live mock 成功、artifact 完整性。

### 实现结果

- `src/flows/once-runner.js`
  - 新增 `buildPrediction(context, marketId)`：获取 Market、Evidence[]、ProbabilityEstimate。
  - 新增 `runTradeOnce()`：market -> evidence -> estimate -> decision -> live balance/preflight context -> RiskEngine -> OrderExecutor -> once artifact。
  - 支持 dependency injection：tests 可以注入 mock LiveBroker、mock estimator、mock crawler；CLI 默认使用真实实现。
  - 未指定 `--side` 时先用 `DecisionEngine.analyze()` 选择 best suggested side，再生成可执行 TradeDecision。

- `src/artifacts/artifact-writer.js`
  - 新增 `writeOnceRun()`。
  - 写入 `runtime-artifacts/runs/<timestamp>-once/`：
    - `input.json`
    - `market.json`
    - `evidence.json`
    - `estimate.json`
    - `decision.json`
    - `risk.json`
    - `order.json`
    - `summary.md`
  - no-trade 也写 `order.json`，内容为 blocked order result。
  - 所有 JSON 写入前继续 `redactSecrets()`。

- `src/cli.js`
  - `predict --market <id-or-slug>` 只预测，不下单；屏幕输出 compact summary：mode、market question、AI probability、market probability、edge、confidence、action、artifact path。
  - `trade once --mode paper --market <id-or-slug> --max-amount <usd>` 改用 `runTradeOnce()`；屏幕只输出 mode、market question、AI probability、market probability、edge、action、artifact path。
  - `trade once --mode live --market <id-or-slug> --max-amount <usd> --env-file <path> --confirm LIVE` 同一闭环，live 缺 env 或 balance/preflight 失败会 no-trade。
  - `--amount` 仍作为兼容参数；`--max-amount` 是主参数。

- `package.json`
  - smoke 命令改用 `--max-amount`。

### 测试与失败观察

已运行：

```bash
npm test
npm run smoke
node ./bin/polypulse.js predict --source mock --market market-001
node ./bin/polypulse.js trade once --source mock --mode paper --market market-001 --max-amount 1
node ./bin/polypulse.js trade once --source mock --mode live --market market-001 --max-amount 1 --env-file .env.example --confirm LIVE
git diff --check
rg -n "(PRIVATE_KEY|API_KEY|SECRET|TOKEN|COOKIE|SESSION)[[:space:]]*[:=]" . --glob '!runtime-artifacts/**' --glob '!node_modules/**' --glob '!.git/**'
```

结果：

- `npm test` 通过 35 个 tests。
- 新增 one-shot 覆盖：
  - paper one-shot 成功并写完整 run artifacts。
  - no-trade 场景。
  - live 缺 confirm 拒绝。
  - live mock broker 下单成功。
  - artifact 完整性：8 个必需文件均存在，summary.md 可读。
- `npm run smoke` 通过，trade once 输出 compact summary。
- `predict --source mock --market market-001` 输出 `action=predict-only` 和 prediction decision artifact path。
- paper `trade once --max-amount 1` 输出 `action=paper-order` 和 `runtime-artifacts/runs/<timestamp>-once/summary.md`。
- live `trade once --confirm LIVE --env-file .env.example` 因 `.env.example` 缺 live secrets 输出 `action=no-trade`，没有真实下单。
- `find runtime-artifacts/runs -maxdepth 2` 验证 once run 目录包含 input、market、evidence、estimate、decision、risk、order、summary。
- `git diff --check` 通过。
- secret scan 只命中 `.env.example` 空 `PRIVATE_KEY=`、`src/config/env.js` 空默认值和 memory 中已有文字记录；未发现非空 secret。

### 本阶段创建/修改的关键文件

- `src/flows/once-runner.js`
- `src/artifacts/artifact-writer.js`
- `src/cli.js`
- `package.json`
- `test/once-runner.test.js`
- `test/smoke.test.js`
- `docs/memory/POLYPULSE_MEMORY.md`

## 2026-04-30 Stage 9 - 持久化话题监测与自动下单

### 阶段目标

实现 persistent monitor，打通：

- `polypulse monitor run --mode paper`
- `polypulse monitor run --mode live --env-file <path> --confirm LIVE`
- `polypulse monitor status`
- `polypulse monitor stop`
- `polypulse monitor resume`

### 当前代码观察

- `src/scheduler/scheduler.js` 目前只有单市场 `runOnce()` 和一个简单 `monitorRun()` dedupe lock；未实现多市场候选、watchlist/blocklist、每轮交易上限、每日交易额、stop/resume、crash recovery 或 monitor artifact 目录。
- one-shot 闭环已经在 `src/flows/once-runner.js` 中稳定存在，可以复用同一 MarketSource、EvidenceCrawler、ProbabilityEstimator、DecisionEngine、RiskEngine、OrderExecutor 路径，避免 monitor 绕过风控。
- `FileStateStore` 已经提供 paper/live 分离状态、portfolio、riskState、orders、runs、dedupeLocks，可在同一状态文件中扩展 `monitorState` 和 monitor 方法。
- `ArtifactWriter` 已经有 once run artifacts；需要新增 `writeMonitorRun()`，目录应为 `runtime-artifacts/monitor/<date>/<run-id>/`。
- `RiskEngine` 已经强制 live confirm/preflight/balance、市场状态、证据、confidence、限额等规则；monitor 只应提供上下文，不能直接下单。
- `EvidenceCrawler` 已有 cache，market source 已有 scan cache；monitor 需要在状态层增加 per-market trade dedupe，避免 crash 后重复下单。

### 设计取舍

- 先实现可测试的一轮 monitor；CLI 的 `monitor run` 默认只执行一轮，支持 `--loop` 才进入持久循环。这样满足“每轮简短输出”和自动测试可终止，不会让命令在测试中挂住。
- monitor state 持久化在 mode-specific state file，避免 paper/live 混用；关键字段包括 `status`、`lastRunId`、`lastStartedAt`、`lastCompletedAt`、`dailyTradeUsd`、`tradedMarkets`、`inFlightRun`、`watchlist`、`blocklist`。
- 同一市场避免重复下单采用“只在 filled order 后记录 tradedMarkets”的策略；blocked/no-trade 不永久封禁，下一轮仍可重新评估。
- crash recovery 通过 `recoverMonitorRun()` 实现：如果上次 `inFlightRun.status=running`，下一轮开始时先标记 `recovered_after_crash` 并继续新 run。
- 限流/backoff 采用小型 no-dependency worker pool 和 sleep；配置项不绑定技术栈，保持 `Scheduler` 层可替换。
- live monitor 仍 fail-closed：即使 `--confirm LIVE` 出现，也必须通过 `RiskEngine` 的 preflight/balance 和 `LiveBroker` 的 confirm/preflight/balance 才能提交；自动测试只用 mock live broker。

### 计划修改

- 扩展 env 配置和 `.env.example`：
  - `MONITOR_MAX_TRADES_PER_ROUND`
  - `MONITOR_MAX_DAILY_TRADE_USD`
  - `MONITOR_CONCURRENCY`
  - `MONITOR_RUN_TIMEOUT_MS`
  - `MONITOR_BACKOFF_MS`
  - `MONITOR_WATCHLIST`
  - `MONITOR_BLOCKLIST`
  - `ARTIFACT_RETENTION_DAYS`
  - `ARTIFACT_MAX_RUNS`
- 扩展 `FileStateStore`：monitor status/stop/resume、start/complete/fail run、trade dedupe、daily totals、watchlist/blocklist。
- 重写 `Scheduler.monitorRun()` 为多市场 monitor round；保留可注入 crawler/estimator/brokers 以便测试。
- 新增 `ArtifactWriter.writeMonitorRun()`，写完整 monitor artifacts。
- 扩展 CLI：`monitor status|stop|resume`，`monitor run --loop` 支持持久循环。
- 添加 `test/monitor.test.js` 覆盖 paper、live 默认拒绝、live mock、crash recovery、rate limit、artifact、stop/resume、重复下单防护。

### 实现结果

- `src/config/env.js`
  - 新增 monitor 配置：`MONITOR_MAX_TRADES_PER_ROUND`、`MONITOR_MAX_DAILY_TRADE_USD`、`MONITOR_CONCURRENCY`、`MONITOR_RUN_TIMEOUT_MS`、`MONITOR_BACKOFF_MS`、`MONITOR_WATCHLIST`、`MONITOR_BLOCKLIST`。
  - 新增 artifact 清理配置：`ARTIFACT_RETENTION_DAYS`、`ARTIFACT_MAX_RUNS`。
  - `validateEnvConfig()` 增加 monitor/artifact 配置校验，并兼容测试中手写的旧 config shape。

- `.env.example`
  - 增加上述 monitor/artifact 配置项，保持真实 secret 为空占位。

- `src/state/file-state-store.js`
  - 扩展 mode-specific state：新增 `monitorState`。
  - 支持：
    - `getMonitorState()`
    - `stopMonitor()`
    - `resumeMonitor()`
    - `recoverMonitorRun()`
    - `startMonitorRun()`
    - `completeMonitorRun()`
    - `failMonitorRun()`
    - `hasMonitorTradedMarket()`
    - `recordMonitorTrade()`
  - `monitorState` 保存：
    - `status`
    - `lastRunId`
    - `lastStartedAt`
    - `lastCompletedAt`
    - `lastError`
    - `inFlightRun`
    - `dailyTradeUsd`
    - `tradedMarkets`
    - `watchlist`
    - `blocklist`
    - `runHistory`
  - paper/live 状态仍通过 `paper-state.json` / `live-state.json` 隔离。

- `src/scheduler/scheduler.js`
  - 重写为 persistent monitor 调度器。
  - `monitorRun()` 执行一轮可恢复 monitor round：
    1. recovery: 若发现上一轮 `inFlightRun.status=running`，标记 `recovered_after_crash`。
    2. stop gate: `monitor stop` 后直接返回 stopped，不抓取、不交易。
    3. market scan: 调用 MarketSource 批量扫描。
    4. candidate filter: 应用 watchlist、blocklist、monitor dedupe、现有 portfolio position 去重。
    5. concurrent prediction: 对候选市场并发抓 evidence + estimate，受 `MONITOR_CONCURRENCY` 和 `MONITOR_BACKOFF_MS` 控制。
    6. decision + risk + order: 复用 DecisionEngine、RiskEngine、OrderExecutor；paper/live 共用路径。
    7. monitor limits: 强制 `MONITOR_MAX_TRADES_PER_ROUND` 和 `MONITOR_MAX_DAILY_TRADE_USD`。
    8. filled order dedupe: 成交后记录 market/event key，后续轮次不重复下单。
    9. artifact: 每轮写 monitor artifact。
  - live 模式仍 fail-closed：无 `--confirm LIVE` 时 RiskEngine 拒绝；有 confirm 时仍必须通过 live preflight、balance check、RiskEngine 和 LiveBroker。
  - 新增 `monitorLoop()`：支持有限轮数和 `--loop` 持久运行；每轮可由 CLI 打印 compact status。

- `src/artifacts/artifact-writer.js`
  - 新增 `writeMonitorRun()`。
  - 写入：
    - `runtime-artifacts/monitor/<date>/<run-id>/markets.json`
    - `runtime-artifacts/monitor/<date>/<run-id>/candidates.json`
    - `runtime-artifacts/monitor/<date>/<run-id>/predictions/<market>/evidence.json`
    - `runtime-artifacts/monitor/<date>/<run-id>/predictions/<market>/estimate.json`
    - `runtime-artifacts/monitor/<date>/<run-id>/predictions/<market>/decision.json`
    - `runtime-artifacts/monitor/<date>/<run-id>/predictions/<market>/summary.md`
    - `runtime-artifacts/monitor/<date>/<run-id>/decisions.json`
    - `runtime-artifacts/monitor/<date>/<run-id>/risk.json`
    - `runtime-artifacts/monitor/<date>/<run-id>/orders.json`
    - `runtime-artifacts/monitor/<date>/<run-id>/summary.md`
  - 新增 `cleanupArtifacts()`，按 retention days / max runs 清理 monitor artifacts，避免长期运行无限膨胀。
  - 所有 artifacts 继续通过 `redactSecrets()` 写入。

- `src/cli.js`
  - 新增：
    - `polypulse monitor run --mode paper --rounds 1`
    - `polypulse monitor run --mode paper --loop`
    - `polypulse monitor run --mode live --env-file <path> --confirm LIVE --rounds 1`
    - `polypulse monitor status`
    - `polypulse monitor stop`
    - `polypulse monitor resume`
  - `monitor status` 输出 compact state：status、last run、dailyTradeUsd、dedupe key count、watchlist/blocklist、inFlightRun、lastError；不打印完整 tradedMarkets。
  - `monitor run` 输出 compact round summary：mode、runId、markets、candidates、predictions、orders、action、artifact path。

- `package.json`
  - smoke 命令增加 `monitor status` 和 `monitor run --rounds 1`。

- `test/monitor.test.js`
  - 新增 8 个 monitor tests：
    - paper monitor 跑一轮并写完整 artifacts。
    - 多轮不会对同一 market/event 重复下单。
    - live monitor 无 confirm 拒绝。
    - live monitor mock broker 在 confirm 后可执行。
    - crash recovery。
    - concurrency / rate limit。
    - stop/resume 状态。
    - watchlist/blocklist 过滤。

### 失败观察与修复

- 首次 `npm test` 失败 6 项，主要原因是新增 `validateEnvConfig()` 假设所有测试 config 都有 `artifacts` 字段；历史单测使用手写 config shape，触发 `Cannot read properties of undefined (reading 'retentionDays')`。
- 修复：`validateEnvConfig()` 对 `config.monitor` 和 `config.artifacts` 使用 optional fallback。
- 同步观察到 smoke 中 one-shot 已持仓后 monitor 仍可能再次处理同一市场；为避免误重复下单，candidate filter 新增 portfolio position 去重，市场或事件已有持仓则标记 `existing_position_market_or_event` 并跳过。

### 测试与验证

已运行：

```bash
npm test
npm run smoke
git diff --check
rg -n "(PRIVATE_KEY|API_KEY|SECRET|TOKEN|COOKIE|SESSION)[[:space:]]*[:=]" . --glob '!runtime-artifacts/**' --glob '!node_modules/**' --glob '!.git/**'
```

结果：

- `npm test` 通过 43 个 tests。
- `npm run smoke` 通过；包含 `monitor status` 和 `monitor run --rounds 1`。
- `git diff --check` 通过。
- secret scan 只命中 `.env.example` 空 `PRIVATE_KEY=`、`src/config/env.js` 空默认值和 memory 中已有文字记录；未发现非空 secret。
- 没有运行真实 live 命令；live monitor 自动测试只使用 mock broker / mock client。

### 本阶段创建/修改的关键文件

- `.env.example`
- `package.json`
- `src/config/env.js`
- `src/state/file-state-store.js`
- `src/scheduler/scheduler.js`
- `src/artifacts/artifact-writer.js`
- `src/cli.js`
- `test/monitor.test.js`
- `docs/memory/POLYPULSE_MEMORY.md`

## 2026-04-30 Stage 10 - 补齐测试矩阵

### 阶段目标

按 `docs/specs/testing-plan.md` 补齐测试模块，覆盖 env、account、market scan、prediction、paper/live one-shot、paper/live monitor、RiskEngine、性能/稳定性，并提供本地一键测试命令与失败详情归档。

### 当前测试观察

- 已有测试基础较完整：
  - `test/broker-account.test.js` 覆盖 env preflight、private key 不打印、live mock balance、PaperBroker buy/sell、LiveBroker confirm gate、OrderExecutor blocked。
  - `test/market-source.test.js` 覆盖分页、过滤、cache、insufficient scan risk flags。
  - `test/analysis.test.js` 覆盖 EvidenceCrawler cache/dedupe、ProbabilityEstimator schema、DecisionEngine edge/no-trade。
  - `test/risk-engine.test.js` 覆盖系统 pause/halt、drawdown、position loss、position count、notional limits、min trade、stale market、missing token、live gates。
  - `test/once-runner.test.js` 覆盖 paper one-shot、no-trade、live missing confirm、live mock success、artifact 完整性。
  - `test/monitor.test.js` 覆盖 paper/live monitor、dedupe、crash recovery、concurrency、stop/resume、watchlist/blocklist。
- 缺口：
  - `.env.example` 字段完整性测试。
  - unique fake secret 不进入 stdout/artifact/memory 的端到端测试。
  - AccountService / LiveBroker API failure、chain/address 配置错误。
  - stale cache fallback 标记。
  - 大量市场 mock scan。
  - retry / timeout 独立测试。
  - artifact cleanup policy。
  - risk 拒绝后 broker submit 不被调用。
  - live monitor halted 禁止 open。
  - PaperBroker 余额不足应 fail-closed，目前 buy 会让 paper cash 变负，需修复。

### 计划修改

- 新增 `scripts/run-tests.js`，作为 `npm test` 的一键测试入口：运行 `node --test`，写 `runtime-artifacts/test-runs/<timestamp>/`，失败时保留 stdout/stderr/summary。
- 新建 `docs/testing.md`，记录测试矩阵、命令、artifact 路径、CI/local 用法。
- 新增/扩展测试：
  - `test/env-security.test.js`
  - `test/performance-stability.test.js`
  - 扩展 `test/broker-account.test.js`
  - 扩展 `test/market-source.test.js`
  - 扩展 `test/analysis.test.js`
  - 扩展 `test/once-runner.test.js`
  - 扩展 `test/monitor.test.js`
  - 扩展 `test/risk-engine.test.js`
- 修复 PaperBroker buy 余额不足时应 reject，不更新持仓或 cash。

### 实现结果

- `scripts/run-tests.js`
  - 新增一键测试入口，`npm test` 调用该脚本。
  - 脚本执行 `node --test`，并写：
    - `runtime-artifacts/test-runs/<timestamp>/command.txt`
    - `runtime-artifacts/test-runs/<timestamp>/stdout.log`
    - `runtime-artifacts/test-runs/<timestamp>/stderr.log`
    - `runtime-artifacts/test-runs/<timestamp>/summary.json`
  - 屏幕只输出 compact JSON summary；失败时 summary 中包含 artifact dir。

- `scripts/smoke.js`
  - 新增 CLI smoke runner，替代 package script 中的长 shell chain。
  - 执行 7 条 CLI smoke：env check、account balance、market topics、predict、paper trade once、monitor status、monitor run。
  - 每条命令 stdout/stderr 写入 `runtime-artifacts/test-runs/<timestamp>-smoke/`。
  - 屏幕只输出 compact JSON summary。

- `docs/testing.md`
  - 新增测试文档，记录：
    - `npm test`
    - `npm run test:node`
    - `npm run smoke`
    - `git diff --check`
    - secret scan 命令
    - 失败详情 artifact 目录
    - 功能覆盖矩阵
    - live 测试边界

- `package.json`
  - `test` 改为 `node ./scripts/run-tests.js`。
  - 新增 `test:node`。
  - `smoke` 改为 `node ./scripts/smoke.js`。

- `src/state/file-state-store.js`
  - PaperBroker buy 余额不足时现在抛出 `paper_insufficient_cash`，避免 paper cash 变负。

- `src/adapters/evidence-crawler.js`
  - 修复 timeout 实现：原实现只 abort signal，如果 adapter 忽略 signal，仍会等待到 adapter 自然返回。
  - 新实现使用 `Promise.race()`，超时后明确返回 failed evidence fallback。

- `src/config/env.js`
  - live preflight 增加 `FUNDER_ADDRESS_FORMAT` 校验，要求 20-byte hex address。

### 新增/扩展测试覆盖

- `test/env-security.test.js`
  - `.env.example` 字段完整性。
  - 缺 `PRIVATE_KEY` 时 live preflight fail。
  - 构造 fake private value，验证不进入 stdout、artifact、memory。

- `test/broker-account.test.js`
  - Account balance mock client success 已存在。
  - 新增 mock API failure。
  - 新增 chain/address 配置错误。
  - 新增 balance artifact 输出验证。
  - 新增 paper buy 余额不足拒绝且不更新持仓。
  - PaperBroker buy/sell/mark-to-market/crash recovery 已存在。

- `test/market-source.test.js`
  - 分页、过滤、cache 已存在。
  - 新增 stale cache fallback 标记 `stale_market_cache_used`。
  - 新增低流动性过滤后 `market_scan_empty` 标记。

- `test/analysis.test.js`
  - mock evidence、schema、edge/no-trade 已存在。
  - 新增 fake AI response normalization，越界概率被 clamp 后仍符合 schema。
  - 新增 low confidence no-trade。

- `test/once-runner.test.js`
  - paper one-shot 成功、no-trade、live 缺 confirm、live mock success 已存在。
  - 新增 risk 拒绝后不调用 live broker submit。

- `test/monitor.test.js`
  - paper 单轮/多轮去重、crash recovery、stop/resume、live mock success 已存在。
  - 新增 live env incomplete 默认 fail-closed。
  - 新增 live halted 状态禁止 open，并验证不调用 submit。

- `test/risk-engine.test.js`
  - 单笔上限、总敞口、单事件、最大持仓、最小交易额、stale market、token mismatch、live gates 已存在。
  - 新增 AI-proposed token outside market snapshot 被拒绝，作为 AI 越权输出测试。

- `test/performance-stability.test.js`
  - 新增 5,000 market mock scan，验证分页和返回数量。
  - 新增 retryable failure 后重试成功。
  - 新增 EvidenceCrawler timeout -> failed evidence，不挂起。
  - 新增 monitor artifact cleanup policy，`maxRuns=1` 只保留最新 run。

### 测试与验证

已运行：

```bash
npm test
npm run smoke
git diff --check
rg -n "(PRIVATE_KEY|API_KEY|SECRET|TOKEN|COOKIE|SESSION)[[:space:]]*[:=]" . --glob '!runtime-artifacts/**' --glob '!node_modules/**' --glob '!.git/**'
```

结果：

- `npm test` 通过 62 个 tests。
- `npm run smoke` 通过 7 条 CLI smoke commands。
- `git diff --check` 通过。
- secret scan 命中均为预期空占位或文档记录：
  - `.env.example` 空 `PRIVATE_KEY=`
  - `src/config/env.js` 空默认值
  - `test/env-security.test.js` 中空 `PRIVATE_KEY`
  - memory 中对 secret scan 的文字记录
  - 未发现非空 secret 赋值。
- 未运行真实 live 命令；live 测试全部为 mock 或 fail-closed 检查。

### 本阶段创建/修改的关键文件

- `docs/testing.md`
- `scripts/run-tests.js`
- `scripts/smoke.js`
- `package.json`
- `src/state/file-state-store.js`
- `src/adapters/evidence-crawler.js`
- `src/config/env.js`
- `test/env-security.test.js`
- `test/performance-stability.test.js`
- `test/broker-account.test.js`
- `test/market-source.test.js`
- `test/analysis.test.js`
- `test/once-runner.test.js`
- `test/monitor.test.js`
- `test/risk-engine.test.js`
- `docs/memory/POLYPULSE_MEMORY.md`

## 2026-04-30 Stage 11 - 轻量级服务器部署

### 阶段目标

只写部署脚本与 runbook，不连接 `ssh root@43.165.166.171`，不实际部署。目标是在低配 VPS 上以 systemd 长期运行 PolyPulse monitor，默认 paper，live 必须显式 env 配置与启动确认。

### 当前代码观察

- 当前项目是无第三方运行依赖的 Node.js ESM CLI，适合 systemd 方式部署，Docker 不是必须。
- CLI 已有：
  - `polypulse env check`
  - `polypulse account balance`
  - `polypulse predict`
  - `polypulse monitor run --loop`
  - `polypulse monitor status|stop|resume`
- live 安全门已在 CLI/RiskEngine/LiveBroker 侧强制；部署层仍需要二次保护：env 文件权限检查、live confirm gate、systemd `ExecStartPre` preflight。
- runtime artifacts 已通过 `.gitignore` 排除，部署脚本应继续把 `/home/PolyPulse/.env` 作为服务器本地 secret 文件，不纳入 git。

### 设计取舍

- 选择 systemd 作为最简部署方案：不引入 Docker、Redis、数据库或进程管理器依赖。
- systemd service 使用 `/home/PolyPulse/.env`，默认 paper loop。live loop 需要：
  - `.env` 中 `POLYPULSE_EXECUTION_MODE=live`
  - `.env` 中 `POLYPULSE_LIVE_CONFIRM=LIVE`
  - 启动脚本显式传入 `--confirm LIVE`
  - service `ExecStart` 再次把 `--confirm LIVE` 传入 CLI。
- 日志采用 systemd append 到 `/home/PolyPulse/logs/polypulse-monitor.log` 和 `.err.log`，并由 `/etc/logrotate.d/polypulse-monitor` 轮转。
- healthcheck 不做真实下单；paper smoke 使用 mock source 验证 CLI 基本路径。

### 计划修改

- 新建：
  - `deploy/README.md`
  - `deploy/env.example`
  - `deploy/systemd/polypulse-monitor.service`
  - `deploy/scripts/install.sh`
  - `deploy/scripts/start.sh`
  - `deploy/scripts/stop.sh`
  - `deploy/scripts/status.sh`
  - `deploy/scripts/healthcheck.sh`
  - `docs/runbooks/server-deploy.md`
  - `docs/runbooks/live-trading-checklist.md`
- 验证：
  - `bash -n deploy/scripts/*.sh`
  - `npm test`
  - `npm run smoke`
  - `git diff --check`
  - secret scan

### 实现结果

- `deploy/README.md`
  - 中文部署说明，覆盖 `/home/PolyPulse` 目录约定、paper/live 启动、状态检查、健康检查、手动预测、余额查询、artifact 查看、停止和恢复 monitor。

- `deploy/env.example`
  - 服务器 `.env` 模板，默认 `POLYPULSE_EXECUTION_MODE=paper`。
  - `PRIVATE_KEY` 等 live 字段保持空占位。
  - `STATE_DIR=/home/PolyPulse/runtime-artifacts/state`，`ARTIFACT_DIR=/home/PolyPulse/runtime-artifacts`。
  - 低配 VPS 默认降低 monitor 压力：`MARKET_SCAN_LIMIT=500`、`MONITOR_CONCURRENCY=2`、`MONITOR_MAX_TRADES_PER_ROUND=2`。
  - 新增 `POLYPULSE_LIVE_CONFIRM=`，live 常驻必须改为 `LIVE`。

- `deploy/systemd/polypulse-monitor.service`
  - systemd 常驻服务，`WorkingDirectory=/home/PolyPulse`。
  - `EnvironmentFile=/home/PolyPulse/.env`。
  - `ExecStartPre=/home/PolyPulse/deploy/scripts/healthcheck.sh --preflight`。
  - 默认 paper loop：`monitor run --mode paper --env-file /home/PolyPulse/.env --loop`。
  - live loop 必须 env 中 `POLYPULSE_EXECUTION_MODE=live` 且 `POLYPULSE_LIVE_CONFIRM=LIVE`，service 再传 `--confirm LIVE`。
  - `Restart=always`、`RestartSec=15`、`MemoryMax=512M`、`CPUQuota=80%`。
  - 日志 append 到 `/home/PolyPulse/logs/polypulse-monitor.log` 和 `.err.log`。

- `deploy/scripts/install.sh`
  - root-only 安装脚本。
  - 检查 `/home/PolyPulse`、Node.js `>=20`、部署文件存在。
  - 创建 runtime/state/logs 目录并收紧权限。
  - 若 `.env` 不存在，复制 `deploy/env.example` 并 `chmod 600`；若存在，保持并强制 `chmod 600`。
  - 安装 systemd unit 和 `/etc/logrotate.d/polypulse-monitor`。
  - 执行 `healthcheck.sh --paper-smoke`。

- `deploy/scripts/start.sh`
  - 读取 `/home/PolyPulse/.env`。
  - paper 直接 preflight 后启动 systemd。
  - live 必须命令行 `--confirm LIVE` 且 `.env` 中 `POLYPULSE_LIVE_CONFIRM=LIVE`，否则拒绝启动。

- `deploy/scripts/stop.sh`
  - 调用 CLI `monitor stop` 写入 monitor stopped state。
  - 停止 systemd service。

- `deploy/scripts/status.sh`
  - 输出 systemd active/status、CLI monitor status、最近日志。

- `deploy/scripts/healthcheck.sh`
  - 检查 Node.js、env 文件存在和权限。
  - preflight：paper 调 `env check --mode paper`，live 调 `env check --mode live` 并要求 `POLYPULSE_LIVE_CONFIRM=LIVE`。
  - `--paper-smoke` 使用 mock source 跑 env/account/market/predict，不下单。

- `docs/runbooks/server-deploy.md`
  - 中文服务器部署 runbook，包含 rsync 同步、安装、paper 常驻、live 常驻、运维命令、故障排查。

- `docs/runbooks/live-trading-checklist.md`
  - 中文 live checklist，覆盖测试、服务器 secret、live env、风控参数、preflight、paper 最后一轮、live 启动、停止/恢复、事故处理。

### 额外修复

- `src/adapters/evidence-crawler.js`
  - `npm test` 曾出现 monitor 并发写 evidence cache 导致 JSON 文件被并发覆盖，触发解析失败，并让 monitor 测试偶发 0 orders。
  - 修复方式：EvidenceCrawler 内部串行化 cache write，并用临时文件 + `rename()` 原子替换。

- `test/monitor.test.js`
  - 为 monitor 下单相关测试注入 deterministic `openProbabilityEstimator`，避免启发式估算和测试并发造成偶发 no-order。

### 测试与验证

已运行：

```bash
bash -n deploy/scripts/install.sh deploy/scripts/start.sh deploy/scripts/stop.sh deploy/scripts/status.sh deploy/scripts/healthcheck.sh
node --check scripts/run-tests.js
node --check scripts/smoke.js
npm test
npm run smoke
git diff --check
rg -n "(PRIVATE_KEY|API_KEY|SECRET|TOKEN|COOKIE|SESSION)[[:space:]]*[:=]" . --glob '!runtime-artifacts/**' --glob '!node_modules/**' --glob '!.git/**'
```

结果：

- `bash -n` 通过。
- `node --check` 通过。
- `npm test` 通过 62 个 tests。
- `npm run smoke` 通过 7 条 CLI smoke commands。
- `git diff --check` 通过。
- secret scan 命中均为占位或文档示例：
  - `.env.example` / `deploy/env.example` 空 `PRIVATE_KEY=`
  - runbook 和 deploy README 中 `<server-only-secret>` 占位
  - `src/config/env.js` 空默认值
  - `test/env-security.test.js` 空测试 override
  - memory 中对 secret scan 的文字记录
  - 未发现真实 secret。
- 没有执行 ssh、rsync 或 systemd 部署命令；未连接 `43.165.166.171`；未运行真实 live 下单。

### 本阶段创建/修改的关键文件

- `deploy/README.md`
- `deploy/env.example`
- `deploy/systemd/polypulse-monitor.service`
- `deploy/scripts/install.sh`
- `deploy/scripts/start.sh`
- `deploy/scripts/stop.sh`
- `deploy/scripts/status.sh`
- `deploy/scripts/healthcheck.sh`
- `docs/runbooks/server-deploy.md`
- `docs/runbooks/live-trading-checklist.md`
- `src/adapters/evidence-crawler.js`
- `test/monitor.test.js`
- `docs/memory/POLYPULSE_MEMORY.md`

## 2026-04-30 Stage 12 - 最终验收与整理

### 阶段目标

对照 `docs/specs/product-requirements.md` 完成最终验收，运行完整测试、paper one-shot demo、paper monitor demo、live fail-closed 检查、secret 检查、runtime artifacts 结构检查、memory 完整性检查和部署文档检查，并输出：

- `docs/FINAL_ACCEPTANCE.md`
- `docs/KNOWN_LIMITATIONS.md`
- `docs/ROADMAP.md`

### PRD 对照观察

- 已完成：
  - 账户余额查询：paper/live mock，live env 缺失 fail-fast，artifact redaction。
  - 市场抓取：Polymarket Gamma 分页、过滤、cache、retry/timeout、risk flags。
  - 证据抓取接口：EvidenceCrawler adapters、timeout、retry、dedupe、cache、artifact。
  - 概率估计 schema：ProbabilityEstimator 输出 confidence、uncertainty、key/counter evidence。
  - edge/EV/market probability：DecisionEngine 输出 gross/net edge、EV、suggested side/notional。
  - hard risk：RiskEngine 强制系统、数据、仓位、交易、live 门禁。
  - paper once 和 monitor：完整闭环、state、artifact、dedupe、crash recovery。
  - live once 和 monitor：安全脚手架、mock broker 测试、默认拒绝。
  - 部署：systemd、脚本、runbook、healthcheck、logrotate、live double confirm。
- 部分完成 / 残余风险：
  - 默认 AI 仍是本地启发式 provider，真实 LLM / AI command provider 待接入。
  - 外部网页/新闻/官方数据搜索适配器尚未接入。
  - LiveBroker 真实 Polymarket SDK / 钱包路径未实际验证。
  - live confirmation 尚未绑定 run id、market、side、amount 和 env fingerprint。
  - order book 深度成交、multi-outcome/neg-risk、reduce/close CLI 尚未完备。
  - HTTP health endpoint 未实现，当前用命令式 `healthcheck.sh` 替代。

### 执行命令与结果

完整测试：

```bash
npm test
```

结果：

- `62` tests passed。
- artifact：`runtime-artifacts/test-runs/2026-04-30T12-11-40-852Z/summary.json`

Smoke：

```bash
npm run smoke
```

结果：

- `7` commands passed。
- artifact：`runtime-artifacts/test-runs/2026-04-30T12-12-32-586Z-smoke/summary.json`

Paper one-shot demo：

```bash
STATE_DIR=runtime-artifacts/final-acceptance/once-state ARTIFACT_DIR=runtime-artifacts/final-acceptance node ./bin/polypulse.js trade once --source mock --mode paper --market market-001 --max-amount 1
```

结果：

- `action=paper-order`
- `ai_probability=0.4886`
- `market_probability=0.43`
- `edge=0.0586`
- artifact：`runtime-artifacts/final-acceptance/runs/2026-04-30T12-06-05-058Z-once/summary.md`

Paper monitor demo：

```bash
STATE_DIR=runtime-artifacts/final-acceptance/monitor-state ARTIFACT_DIR=runtime-artifacts/final-acceptance MONITOR_CONCURRENCY=1 MONITOR_MAX_TRADES_PER_ROUND=1 node ./bin/polypulse.js monitor run --source mock --mode paper --rounds 1 --limit 2 --max-amount 1
```

结果：

- `markets=2`
- `candidates=2`
- `predictions=2`
- `orders=1`
- `action=paper-orders`
- artifact：`runtime-artifacts/final-acceptance/monitor/2026-04-30/2026-04-30t12-06-05-049z-39dcfc79/summary.md`

Live one-shot 默认拒绝：

```bash
STATE_DIR=runtime-artifacts/final-acceptance/live-state ARTIFACT_DIR=runtime-artifacts/final-acceptance node ./bin/polypulse.js trade once --source mock --mode live --market market-001 --max-amount 1
```

结果：

- `action=no-trade`
- blocked reasons：`live_requires_confirm_live`、`live_preflight_failed`、`live_balance_check_missing`
- artifact：`runtime-artifacts/final-acceptance/runs/2026-04-30T12-06-05-055Z-once/summary.md`

Live monitor 默认拒绝：

```bash
STATE_DIR=runtime-artifacts/final-acceptance/live-monitor-state ARTIFACT_DIR=runtime-artifacts/final-acceptance MONITOR_CONCURRENCY=1 node ./bin/polypulse.js monitor run --source mock --mode live --rounds 1 --limit 1 --max-amount 1
```

结果：

- `action=no-trade`
- `orders=0`
- blocked reasons：`live_requires_confirm_live`、`live_preflight_failed`、`live_balance_check_missing`
- artifact：`runtime-artifacts/final-acceptance/monitor/2026-04-30/2026-04-30t12-06-05-049z-c8d98615/summary.md`

Live env preflight:

```bash
node ./bin/polypulse.js env check --mode live --env-file .env.example
```

结果：

- `ok=false`
- 明确缺 `PRIVATE_KEY`、`FUNDER_ADDRESS`、`SIGNATURE_TYPE`、`POLYMARKET_HOST`
- 未打印 private key。

### Secret 与 artifact 检查

执行：

```bash
rg -n "(PRIVATE_KEY|API_KEY|SECRET|TOKEN|COOKIE|SESSION)[[:space:]]*[:=]" . --glob '!runtime-artifacts/**' --glob '!node_modules/**' --glob '!.git/**'
# 另执行了测试用 fake private-key literal 扫描，范围为 runtime-artifacts 与 docs/memory。
```

结果：

- 未发现真实 secret。
- 命中项为 env 模板空值、runbook 占位符、测试 fake literal 或 memory 检查记录。
- 测试用 fake private-key literal 未出现在 runtime artifacts 或 memory。
- runtime artifacts 中有 `PRIVATE_KEY is required` 这类缺字段说明，但没有 private key 值。

### Runtime artifacts 结构观察

- `runtime-artifacts/final-acceptance/runs/<timestamp>-once/` 包含 `input.json`、`market.json`、`evidence.json`、`estimate.json`、`decision.json`、`risk.json`、`order.json`、`summary.md`。
- `runtime-artifacts/final-acceptance/monitor/<date>/<run-id>/` 包含 `markets.json`、`candidates.json`、`predictions/<market>/`、`decisions.json`、`risk.json`、`orders.json`、`summary.md`。
- `runtime-artifacts/final-acceptance/*-state/` 分离 paper/live 与 once/monitor state。
- 大小：`runtime-artifacts/final-acceptance` 约 212K，`runtime-artifacts/test-runs` 约 176K。

### 部署文档检查

- `deploy/README.md`、`docs/runbooks/server-deploy.md` 和 `docs/runbooks/live-trading-checklist.md` 可指导轻量级 VPS 部署。
- 覆盖 `/home/PolyPulse`、`.env` 权限、STATE_DIR/ARTIFACT_DIR、systemd、logrotate、healthcheck、自动重启、paper smoke、paper/live monitor、手动预测、余额、artifact、停止和恢复。
- live 启动有双确认：`.env` 的 `POLYPULSE_LIVE_CONFIRM=LIVE` 和 `deploy/scripts/start.sh --confirm LIVE`。

### 本阶段创建/修改的关键文件

- `docs/FINAL_ACCEPTANCE.md`
- `docs/KNOWN_LIMITATIONS.md`
- `docs/ROADMAP.md`
- `docs/memory/POLYPULSE_MEMORY.md`
