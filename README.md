# PolyPulse

PolyPulse 是一个面向 Polymarket 的预测市场自主交易 Agent 框架。当前 README 只保留两条运行路径：

- `live simulated`：读取当前 Polymarket 真实市场，走 live preflight、AI provider、RiskEngine 和模拟执行；持续 monitor 使用内存 paper-trading 账本，只追加人类可读日志，不连接真实钱包、不提交真实订单。
- `live real`：读取当前 Polymarket 真实市场，连接真实钱包，并在风控允许后提交真实订单。

所有测试、验收和部署命令都必须使用 `.env`，并读取当前 Polymarket 真实市场。

## 项目概览

核心链路：抓取当前 Polymarket 市场话题，收集证据，调用配置的 AI provider 估算事件真实发生概率，按 Predict-Raven `pulse-direct` 口径计算 fee、net edge、quarter Kelly sizing 和 monthly return，再通过 `RiskEngine`、live preflight、余额检查和 `OrderExecutor` 决定是否执行。

Codex / Claude Code runtime 只允许输出 `ProbabilityEstimate`，不能直接输出 broker 参数、token 改写、交易金额或可执行订单。AI 只负责概率和证据判断；fee、net edge、quarter Kelly、monthly return、排序、batch cap 和执行风控都由代码计算。

主要 artifact 写入 `runtime-artifacts/`，包括 markets、predictions、runs、monitor、account、test-runs 和 provider runtime 日志。`live simulated` 的执行路径是例外：`trade once` 和 `monitor run` 都使用进程内 paper-trading 账本，程序退出后只保留 `SIMULATED_MONITOR_LOG_PATH` 指向的人类可读日志。所有 artifact 和日志写入前会做 secret redaction。不要把真实 `.env`、私钥、助记词、API key、cookie 或 session token 写入仓库、日志、memory 或测试快照。

服务器部署默认目录是 `/home/PolyPulse`，运行时文件默认在 `/home/PolyPulse/.env`、`/home/PolyPulse/runtime-artifacts`、`/home/PolyPulse/runtime-artifacts/state` 和 `/home/PolyPulse/logs`。`.env` 权限必须是 `600`，真实 secret 只放服务器本地。

部署相关文件：`deploy/env.example` 是服务器 `.env` 模板，`deploy/systemd/polypulse-monitor.service` 是 systemd 常驻 monitor 服务，`deploy/scripts/*.sh` 覆盖安装、启动、停止、状态和健康检查。

## 使用方法

只保留必要配置和命令；所有命令都使用 `.env`，并读取当前 Polymarket 真实市场。每个关键流程保留 `Codex 提示词版本`，可直接交给 Codex 代跑；`live real` 必须先确认真实资金风险。

### 必需运行模式

`.env` 必须明确选择以下两种模式之一。

`live simulated` 用于真实市场演练：

```bash
POLYPULSE_EXECUTION_MODE=live
POLYPULSE_LIVE_WALLET_MODE=simulated
SIMULATED_WALLET_BALANCE_USD=100
SIMULATED_MONITOR_LOG_PATH=/home/PolyPulse/logs/polypulse-simulated-monitor.log
POLYPULSE_MARKET_SOURCE=polymarket
POLYMARKET_GAMMA_HOST=https://gamma-api.polymarket.com
```

`live real` 用于真实钱包交易：

```bash
POLYPULSE_EXECUTION_MODE=live
POLYPULSE_LIVE_WALLET_MODE=real
PRIVATE_KEY=<server-local-secret>
FUNDER_ADDRESS=<0x...>
SIGNATURE_TYPE=<signature-type>
CHAIN_ID=137
POLYMARKET_HOST=https://clob.polymarket.com
POLYPULSE_MARKET_SOURCE=polymarket
POLYMARKET_GAMMA_HOST=https://gamma-api.polymarket.com
```

`live real` 下单前还必须完成真实钱包检查：

```bash
# 1. 检查 live real env、secret 必填项和 Polymarket CLOB client。
node ./bin/polypulse.js env check --mode live --env-file .env

# 2. 查询真实 Polymarket CLOB collateral balance 和 allowance。
node ./bin/polypulse.js account balance --mode live --env-file .env

# 3. 一次性审计真实账户仓位、历史成交、撤单/拒单、本地记录、胜率和收益质量。
node ./bin/polypulse.js account audit --mode live --env-file .env

# 4. 确认仍在读取当前 Polymarket 真实市场；quick 只做轻量实时可读性检查。
node ./bin/polypulse.js market topics --env-file .env --limit 20 --quick

# 5. 如果 allowance 不足，只能在明确接受真实授权风险后执行。
node ./bin/polypulse.js account approve --mode live --env-file .env --confirm APPROVE
```

真实钱包交易必须确认：

- `POLYPULSE_LIVE_WALLET_MODE=real`。
- `PRIVATE_KEY`、`FUNDER_ADDRESS`、`SIGNATURE_TYPE`、`CHAIN_ID=137`、`POLYMARKET_HOST=https://clob.polymarket.com` 已配置。
- `FUNDER_ADDRESS` 是预期真实资金地址；不要在日志、README、issue 或提示词中输出 secret。
- `account balance` 返回的 CLOB collateral balance 足以覆盖计划下单金额，allowance 不为 0 且满足下单需要；allowance 不足时先停止下单，再决定是否手动运行 `account approve --confirm APPROVE`。
- `account audit` 必须返回 `ok=true`，并能核对已有仓位：market、outcome、token、size、avg cost、current value、unrealized PnL、到期/结算状态；如有未知仓位或风险暴露超限，停止真实下单。
- `account audit` 必须核对历史交易记录：最近成交、撤单/拒单、买入/卖出方向、成交均价、费用估算、realized PnL，并与 `runtime-artifacts` 中的 runs、monitor、account artifact 交叉检查。
- `account audit` 必须统计真实账户胜率和收益质量：已结算/已平仓交易的 wins、losses、win rate、平均盈利、平均亏损、净收益率、最大回撤；胜率或净收益异常时暂停真实下单并复盘预测和风控。
- `market topics --quick` 能读取当前 Polymarket 真实市场；如果市场源、余额、allowance、真实账户审计或 env preflight 任一失败，停止真实下单。

Codex 提示词版本：

```text
1. 请检查 .env 是否是 live simulated 或 live real，并确认 POLYPULSE_MARKET_SOURCE=polymarket、POLYMARKET_GAMMA_HOST 指向真实 Gamma API。
2. 如果是 live simulated，请确认它会读取真实 Polymarket 市场，但不会连接真实钱包或提交真实订单。
3. 如果是 live real，请一次性完成真实账户检查：确认 PRIVATE_KEY、FUNDER_ADDRESS、SIGNATURE_TYPE、CHAIN_ID 和 POLYMARKET_HOST；运行 env check、account balance、account audit 和 market topics --quick；不要输出真实 secret；汇总 funder 地址、collateral balance、allowance、真实市场读取结果、已有仓位（market、outcome、size、avg cost、current value、unrealized PnL、到期/结算状态）、历史交易（最近成交、撤单/拒单、费用、realized PnL）和胜率收益质量（wins、losses、win rate、平均盈利、平均亏损、净收益率、最大回撤）；如果真实余额不足、allowance 不足、已有仓位风险暴露超限、历史交易/胜率无法核对、CLOB client/preflight 失败或无法读取当前 Polymarket 真实市场，请停止真实下单。只有我明确要求授权时，才可以运行 account approve --confirm APPROVE。
```

### Predict-Raven Pulse 策略配置

默认 `.env` 使用 Predict-Raven `pulse-direct` 兼容口径：

```bash
PULSE_STRATEGY=pulse-direct
PULSE_MIN_LIQUIDITY_USD=5000
PULSE_MAX_CANDIDATES=20
PULSE_REPORT_CANDIDATES=4
PULSE_BATCH_CAP_PCT=0.2
PULSE_FETCH_DIMENSIONS=volume24hr,liquidity,startDate,competitive
PULSE_REQUIRE_EVIDENCE_GUARD=false
```

这些配置的含义：

- `market topics` 默认按 Pulse-compatible 候选池筛选：最小流动性 5000、必须有 CLOB token、过滤 7 天内短期价格预测市场，并在输出里返回 `pulse.strategy`、`pulse.dimensions`、`pulse.removed` 等诊断信息。
- `predict`、`trade once` 和 `monitor run` 输出会包含 `edge`、`net_edge`、`entry_fee_pct`、`quarter_kelly_pct`、`monthly_return` 和 `suggested_notional_before_risk`，用于检查是否走 Predict-Raven fee / Kelly / monthly return 口径。
- `PULSE_REQUIRE_EVIDENCE_GUARD=false` 与 Predict-Raven pulse-direct 的服务层分工一致：证据不足或低置信度会进入 warning，不默认硬阻断；`live real` 仍必须通过 confirm、env preflight、余额检查和 `RiskEngine`。

Codex 提示词版本：

```text
1. 请检查 .env 的 PULSE_* 配置是否与 Predict-Raven pulse-direct 兼容口径一致。
2. 请说明 market topics、predict、trade once 和 monitor run 会如何使用这些 PULSE_* 配置。
```

### 切换概率估算 Provider

只保留真实 AI provider 路径。启用 Codex：

```bash
AI_PROVIDER=codex
AGENT_RUNTIME_PROVIDER=codex
CODEX_SKILL_ROOT_DIR=skills
CODEX_SKILL_LOCALE=zh
CODEX_SKILLS=polypulse-market-agent
```

启用 Claude Code：

```bash
AI_PROVIDER=claude-code
AGENT_RUNTIME_PROVIDER=claude-code
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

#### Codex live runtime 提示词

当前代码中真正启动 `codex` 进程的地方只有两类：

| 调用点 | 命令 | 是否有 prompt | 用途 |
| --- | --- | --- | --- |
| `scripts/check-agent-config.js` | `codex --version` | 否 | 只检查 Codex CLI 是否可用，不传入 prompt。 |
| `src/runtime/codex-runtime.js` | `codex exec ... -` | 是 | 在 `predict`、`trade once`、`monitor run` 的预测阶段估算概率。 |

除 skill 文件本身外，所有传给 Codex 的 runtime prompt 都由 `src/runtime/codex-runtime.js#buildPrompt` 动态生成。`prompts/probability-estimation.md` 是概率估算口径参考，不是当前 `codex exec` 直接读取的 stdin prompt。

当 `AI_PROVIDER=codex` 且 `AGENT_RUNTIME_PROVIDER=codex` 时，`predict`、`trade once` 和 `monitor run` 会在每个候选市场预测阶段调用真实 Codex CLI。实际命令形态是：

```bash
codex exec \
  --skip-git-repo-check \
  -C <repoRoot> \
  -s read-only \
  --output-schema <tempDir>/probability-estimate.schema.json \
  -o <tempDir>/provider-output.json \
  --color never \
  [-m <CODEX_MODEL>] \
  -
```

最后的 `-` 表示 prompt 通过 stdin 传入。运行时会把当前 market snapshot、evidence list 和 JSON schema 写到临时目录；Codex 的输出必须写成 `ProbabilityEstimate` JSON，并由代码解析、校验和归一化。Codex 不生成订单、不选择 broker 参数、不直接改写 token 或下单金额；交易方向、fee、net edge、quarter Kelly、monthly return、排序、batch cap 和最终风控都由代码计算。

当前默认 `CODEX_SKILL_LOCALE=zh` 时，传给 Codex 的提示词模板如下；其中 `<...>` 是运行时动态填入的路径或 JSON：

```text
你是 PolyPulse 的 Polymarket 概率估算运行时。
当前 provider：codex
必须先阅读这些 skill 文件，再做概率估算：
- <skill id>: <skill SKILL.md path>

必须先阅读这份风险控制文档：
- <repoRoot>/docs/specs/risk-controls.md

只允许阅读上面列出的 skill 文件、这份风险文档、输入 JSON 文件和下面给出的结构化上下文。
不要扫描无关仓库文件，不要运行测试，不要做代码修改，不要尝试下单。

输入文件：
- Market JSON: <tempDir>/market.json
- Evidence JSON: <tempDir>/evidence.json

市场快照：
<JSON: marketId, marketSlug, eventId, eventSlug, question, outcomes,
endDate, liquidityUsd, volumeUsd, volume24hUsd, category, tags,
active, closed, tradable, riskFlags>

证据摘要：
<JSON array: evidenceId, source, title, sourceUrl, timestamp,
relevanceScore, credibility, status, summary>

硬规则：
1. 只能输出合法 JSON，不要输出 markdown 代码块。
2. 不允许编造证据；所有 key_evidence 和 counter_evidence 必须来自输入 Evidence JSON。
3. 证据不足、来源陈旧、结算规则不清或市场不可交易时，confidence 必须为 low，并把 uncertainty_factors 写清楚。
4. ai_probability 必须是该事件 Yes outcome 发生概率，范围 0 到 1。
5. 按 predict-raven pulse-direct 的分工处理：你只给概率和证据判断；fee、net edge、quarter Kelly、monthly return、排序和风控由代码计算。
6. 不允许输出交易指令、token 改写、仓位金额或 broker 参数。

输出字段必须匹配 ProbabilityEstimate provider schema：
- ai_probability
- confidence: low | medium | high
- reasoning_summary
- key_evidence
- counter_evidence
- uncertainty_factors
- freshness_score
只输出最终 JSON。
```

如果把 `CODEX_SKILL_LOCALE` 改为 `en`，同一结构会使用英文模板。`CODEX_SKILLS` 决定 prompt 中列出的 skill 文件，默认是 `polypulse-market-agent`；`CODEX_MODEL` 为空时使用 Codex CLI 默认模型；`PROVIDER_TIMEOUT_SECONDS=0` 表示 Codex provider 子进程不设置单独超时，只受外层 monitor run timeout 约束。

英文 locale 的完整 runtime prompt 模板如下：

```text
You are the probability estimation runtime for PolyPulse, a Polymarket analysis system.
Active provider: codex
Read these selected skill files before estimating:
- <skill id>: <skill SKILL.md path>

Read this risk control document before estimating:
- <repoRoot>/docs/specs/risk-controls.md

Only inspect the listed skill files, this risk document, the input JSON files, and the structured context below.
Do not scan unrelated repository files, do not run tests, do not modify code, and do not place orders.

Input files:
- Market JSON: <tempDir>/market.json
- Evidence JSON: <tempDir>/evidence.json

Market snapshot:
<JSON: marketId, marketSlug, eventId, eventSlug, question, outcomes,
endDate, liquidityUsd, volumeUsd, volume24hUsd, category, tags,
active, closed, tradable, riskFlags>

Evidence summary:
<JSON array: evidenceId, source, title, sourceUrl, timestamp,
relevanceScore, credibility, status, summary>

Hard rules:
1. Output valid JSON only. Do not wrap it in markdown fences.
2. Do not fabricate evidence; key_evidence and counter_evidence must come from the input Evidence JSON.
3. If evidence is insufficient, stale, ambiguous, or the market is not tradable, confidence must be low and uncertainty_factors must explain why.
4. ai_probability is the probability that the Yes outcome resolves true, from 0 to 1.
5. Follow the predict-raven pulse-direct separation of duties: provide probability and evidence judgment only; code computes fees, net edge, quarter Kelly, monthly return, ranking, and risk controls.
6. Do not output trade instructions, token rewrites, sizing, or broker parameters.

The output must match the ProbabilityEstimate provider schema:
- ai_probability
- confidence: low | medium | high
- reasoning_summary
- key_evidence
- counter_evidence
- uncertainty_factors
- freshness_score
Output final JSON only.
```

Codex 提示词版本：

```text
1. 请检查 .env 是否启用了 Codex 或 Claude Code provider，并确认会调用配置的真实 AI provider。
2. 请运行 agent:check 验证当前 provider、runtime provider 和 skill 配置。
```

### 一次性验收

先检查 `.env`、抓取当前 Polymarket 真实市场，并对选定市场做预测：

```bash
node ./bin/polypulse.js env check --mode live --env-file .env
node ./bin/polypulse.js market topics --env-file .env --limit 20 --quick
node ./bin/polypulse.js predict --env-file .env --market <market-id-or-slug>
```

`live simulated` 不连接真实钱包、不提交真实订单：

```bash
node ./bin/polypulse.js trade once --mode live --env-file .env --market <market-id-or-slug> --max-amount 1 --confirm LIVE
tail -n 80 /home/PolyPulse/logs/polypulse-simulated-monitor.log
```

`live simulated trade once` 和 `live simulated monitor` 使用同一套进程内模拟账本逻辑：初始资金都来自 `SIMULATED_WALLET_BALANCE_USD`，每次进程启动都会写同样的 session header，执行过程都追加到 `SIMULATED_MONITOR_LOG_PATH`，并使用同样的 `round.start`、`topics.fetched`、`candidate`、`prediction`、`risk`、`open.filled`、`mark_to_market`、`round.end` 日志格式。区别是 `trade once` 只针对指定市场执行一轮，进程结束后模拟仓位丢失；`monitor run --loop` 在同一进程内跨轮保留模拟仓位，并按间隔继续 mark-to-market、复核和平仓。

`live real` 会连接真实钱包，并可能在风控允许后提交真实订单：

```bash
node ./bin/polypulse.js account balance --mode live --env-file .env
node ./bin/polypulse.js account audit --mode live --env-file .env
node ./bin/polypulse.js trade once --mode live --env-file .env --market <market-id-or-slug> --max-amount 1 --confirm LIVE
```

Codex 提示词版本：

```text
1. 请检查 live env，并确认当前 .env 是 live simulated 或 live real，且读取当前 Polymarket 真实市场。
2. 请用 market topics --quick 抓取 20 个当前 Polymarket 真实市场 topic，并挑选可用于验收的 marketId 或 marketSlug。
3. 请对选出的真实市场运行 predict，汇总 provider、概率、隐含概率、edge、net_edge、quarter_kelly_pct、monthly_return 和 artifact 路径。
4. 如果是 live simulated，请运行 trade once 验收，并确认不连接真实钱包、不提交真实订单。
5. 如果是 live real，请先运行 account balance 和 account audit；只在我明确确认接受真实资金风险且 audit 无阻断后运行 trade once。
```

### 持续 Monitor

同一个命令用于 `live simulated` 和 `live real`；区别由 `.env` 的 `POLYPULSE_LIVE_WALLET_MODE` 决定。`live real` 会连接真实钱包，并可能提交真实订单。

```bash
node ./bin/polypulse.js monitor run --mode live --env-file .env --confirm LIVE --loop
```

`live simulated monitor` 的行为：

- 每轮自动抓取当前 Polymarket topic，按 pulse-compatible 口径筛选候选。
- 对候选市场调用配置的真实 AI provider 预测胜率，并由代码计算 implied probability、edge、net edge、quarter Kelly 和 monthly return。
- 用 `RiskEngine` 做金额、流动性、仓位、回撤、证据和置信度检查。
- 风控允许时在内存 paper-trading 账本开仓；已有仓位每轮 mark-to-market，并在市场关闭、接近 0/1、触发止损或预测 edge 反转时自动平仓。
- 每一步都会追加到 `SIMULATED_MONITOR_LOG_PATH`：抓取 topic、候选过滤、预测、风控、开仓、平仓、现金、权益、realized/unrealized PnL、wins/losses、win rate 和最大回撤。
- `trade once` 和 `monitor run` 在 live simulated 下共用同一套初始资金、日志格式和执行逻辑；`trade once` 是指定市场的一轮执行，`monitor run --loop` 是按间隔重复执行并在同一进程中保留模拟仓位。
- 程序退出后不保留模拟仓位、现金、交易状态或 JSON execution artifact；只保留日志。需要停止 simulated monitor 时，使用 `systemctl stop polypulse-monitor.service` 或结束进程，而不是依赖 `monitor stop` 的持久状态。

Codex 提示词版本：

```text
1. 请检查 .env、provider、真实市场读取和 confirm LIVE。
2. 如果是 live simulated，请启动 monitor，并确认它读取当前 Polymarket 真实市场、调用真实 AI provider、使用内存模拟账本自动开仓/平仓，但不连接真实钱包、不提交真实订单；程序退出后只保留人类可读 log。
3. 如果是 live real，请先运行 account balance 和 account audit，并只在我明确确认真实交易风险且 audit 无阻断后启动 monitor。
4. 启动后请汇总 monitor 状态、风控状态、artifact 或 simulated log 位置。
```

#### Simulated Monitor Log 格式

`SIMULATED_MONITOR_LOG_PATH` 是人类可读追加日志，不是稳定的机器解析协议。每次启动 live simulated `trade once` 或 `monitor run` 都会先写入 session header：

```text
================================================================================
[2026-05-06T15:26:35.807Z] simulated live monitor session started
initial_cash_usd=100
wallet_mode=simulated
market_source=polymarket
gamma=https://gamma-api.polymarket.com
================================================================================
```

header 字段含义：

| 字段 | 含义 |
| --- | --- |
| `initial_cash_usd` | 本次进程内模拟账本的初始现金，来自 `SIMULATED_WALLET_BALANCE_USD`。 |
| `wallet_mode` | 钱包模式；simulated monitor 应始终是 `simulated`。 |
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
| `candidate` | `reasons` | 未选中原因，例如 `watchlist_not_matched`、`blocklisted`、`already_traded_market_or_event`、`existing_position_market_or_event`；`none` 表示进入候选。 |
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

### Monitor 管理

```bash
# 写入 monitor stop 状态，用于暂停持续运行。
node ./bin/polypulse.js monitor stop --env-file .env --reason manual_stop

# 清除 stop 状态，允许 monitor 再次运行。
node ./bin/polypulse.js monitor resume --env-file .env

# 查看 monitor 状态、最近运行和最近错误。
node ./bin/polypulse.js monitor status --env-file .env

# 查看系统级风控状态。
node ./bin/polypulse.js risk status --env-file .env
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

`install.sh` 会创建 `/home/PolyPulse/.env`；启动前必须编辑为 `live simulated` 或 `live real`，并强制权限为 `600`：

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
node ./bin/polypulse.js account audit --mode live --env-file .env
```

Codex 提示词版本：

```text
1. 请在我的 macOS 本机把当前 PolyPulse 项目同步到 root@43.165.166.171:/home/PolyPulse/，同步时排除 .git、.env、.env.*、runtime-artifacts 和 node_modules。
2. 请登录 root@43.165.166.171，在 /home/PolyPulse 运行部署安装脚本，并确认 systemd unit、运行目录和日志轮转安装成功。
3. 请检查 /home/PolyPulse/.env；不要输出真实 secret，必须配置为 live simulated 或 live real，并确认读取当前 Polymarket 真实市场。
4. 请把 /home/PolyPulse/.env 权限设置为 600，启动 systemd monitor 服务，并执行 status 和 healthcheck。
5. 请查看 systemd journal、/home/PolyPulse/logs/polypulse-monitor.log、account audit 和 market topics --quick 输出，确认部署后仍读取当前 Polymarket 真实市场且真实账户检查通过。
```

## todo

以下只保留直接影响预测成功率、概率校准和净收益率的待办项；所有项保持 live-only，并读取当前 Polymarket 真实市场。

- [ ] 建立预测效果评估报表：按 category、tag、到期时间、流动性分桶统计 hit rate、Brier score、calibration、edge 误差、真实结算收益率和年化/月化收益率。
- [ ] 将扫描结果升级为收益导向的 pulse snapshot：记录 `totalFetched`、`selectedCandidates`、category/tag 统计、过滤原因、risk flags、快照年龄，用于追踪哪些筛选条件提升命中率和收益率。
- [ ] 扩展证据抓取以提高概率质量：补 resolution source、官方链接、外部公开证据、Polymarket 事件详情和评论，并为每条证据记录 freshness、relevance、source quality。
- [ ] 增加概率校准层：按市场类型、时间跨度、流动性和证据质量对 AI 概率做校准，输出 raw probability、calibrated probability、confidence 和校准原因。
- [ ] 优化候选筛选：用流动性、24h volume、spread、结束时间、category/tag、证据新鲜度和历史命中率过滤低质量市场，并记录每个过滤维度对收益率的贡献。
- [ ] 改进收益排序：先生成全轮推荐，再按 calibrated edge、fee、slippage、quarter Kelly、monthly return、days-to-resolution 和 downside risk 排序，而不是逐候选即时执行。
- [ ] 把 order book 深度、fee-rate、spread 和滑点纳入 expected return，避免正 edge 被交易成本吃掉；低于净收益阈值的机会应标记为 skip。
- [ ] 增加已有仓位收益复核：基于 avg cost、best bid、unrealized PnL、stop-loss 距离和刷新后的 calibrated edge，决定 hold/reduce/close，以提升实际收益率和降低回撤。
- [ ] 增加收益归因 artifact：区分预测误差、市场价格变化、fee、slippage、仓位大小、持仓时间和退出决策对最终收益的影响。
- [ ] 用历史真实结算市场和已产生 artifact 做回放评估，比较不同 provider、PULSE_* 参数、筛选条件和排序规则对命中率、净收益率、最大回撤的影响。

## 关键文档

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
