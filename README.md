# PolyPulse

PolyPulse 是一个面向 Polymarket 的预测市场自主交易 Agent 框架。核心链路是：抓取市场话题，收集证据，估算事件真实发生概率，计算市场隐含概率和 edge，再通过服务层硬风控决定是否 paper / live 下单。

默认运行模式是 `paper`。任何 live 路径都必须显式 `--mode live --confirm LIVE`，并通过 env preflight、余额检查和 `RiskEngine`。

## 项目概览

当前能力：Polymarket 市场扫描、EvidenceCrawler、ProbabilityEstimator、DecisionEngine、RiskEngine、paper/live broker、one-shot、monitor 常驻运行和 systemd 部署。默认运行模式是 `paper`；任何 live 路径都必须显式 `--mode live --confirm LIVE`，并通过 env preflight、余额检查和 `RiskEngine`。

Codex runtime 只允许输出 `ProbabilityEstimate`，不能直接输出 broker 参数、token 改写、交易金额或可执行订单。默认策略是 `PULSE_STRATEGY=pulse-direct`：话题筛选、fee / net edge、quarter Kelly sizing、monthly return 排序和 batch cap 口径与 Predict-Raven 的 pulse-direct 对齐；所有交易仍必须经过 `DecisionEngine`、`RiskEngine` 和 `OrderExecutor`。

PolyPulse 也支持把概率估算 provider 切换为 Claude Code（`claude` CLI）。设置 `AI_PROVIDER=claude-code` 和 `AGENT_RUNTIME_PROVIDER=claude-code` 后，runtime 会以 `claude --print --bare` 非交互模式调用 Claude Code，并通过 `--allowedTools` 和 `--permission-mode` 限制为只读访问。Claude Code 与 Codex 一样只能输出 `ProbabilityEstimate`，下游 `DecisionEngine`、`RiskEngine`、`OrderExecutor` 仍生效，CODEX_* 配置保持不变可随时切回 Codex。

主要 artifact 写入 `runtime-artifacts/`，包括 markets、predictions、runs、monitor、account、test-runs 和 codex-runtime。所有 artifact 写入前会做 secret redaction。不要把真实 `.env`、私钥、助记词、API key、cookie 或 session token 写入仓库、日志、memory 或测试快照。

服务器部署默认目录是 `/home/PolyPulse`，运行时文件默认在 `/home/PolyPulse/.env`、`/home/PolyPulse/runtime-artifacts`、`/home/PolyPulse/runtime-artifacts/state` 和 `/home/PolyPulse/logs`。`.env` 权限必须是 `600`，真实 secret 只放服务器本地。

部署相关文件：`deploy/env.example` 是服务器 `.env` 模板，`deploy/systemd/polypulse-monitor.service` 是 systemd 常驻 monitor 服务，`deploy/scripts/*.sh` 覆盖安装、启动、停止、状态和健康检查。

## 使用方法

每个命令块后面的 `Codex 提示词版本` 可以直接复制到 Codex 中执行；提示词与上方命令或配置步骤按编号一一对应，由 Codex 负责运行同等测试、检查结果并汇总失败原因。

推荐、预测和交易决策链路的 AI 调用边界：`predict`、`trade once`、`monitor run` 都会进入 `ProbabilityEstimator`。当 `.env` 中 `AI_PROVIDER=codex` 且 `AGENT_RUNTIME_PROVIDER=codex`，或 `AI_PROVIDER=claude-code` 且 `AGENT_RUNTIME_PROVIDER=claude-code` 时，底层会调用对应 AI CLI 生成 `ProbabilityEstimate`；AI 只负责概率和证据判断，代码按 Predict-Raven pulse-direct 口径计算 fee、net edge、quarter Kelly、monthly return、排序和风控。`--source mock` 只表示市场数据用 mock，不表示概率估算用 mock；只要命令带 `--env-file .env` 且 `agent:check` 通过，使用方法里的推荐/预测同样会调用配置的 AI provider。只有明确设置 `AI_PROVIDER=local` / `AGENT_RUNTIME_PROVIDER=none`，或运行 `npm run smoke` 这种离线测试脚本时，才会使用本地启发式 fallback 而不调用外部 AI。

### 与 Predict-Raven 快速开始第 3、4 步的对应关系

Predict-Raven README 的 `### 3. 获取推荐，不下单` 对应 `pnpm pulse:recommend` / `scripts/pulse-live.ts --recommend-only`：它会跑 Pulse 候选池、生成多笔推荐和 `recommendation.json`，但不会发送真实订单。

PolyPulse 已将核心策略口径对齐到 Predict-Raven 的 `pulse-direct`：`market topics` 默认使用 Pulse 候选池规则（最小流动性 5000、必须有 CLOB token、移除 7 天内短期价格市场、维度元数据为 `volume24hr/liquidity/startDate/competitive`）；`predict` 对单个市场执行“市场快照 -> 证据收集 -> 配置的 AI provider 概率估算 -> Predict-Raven fee / net edge / quarter Kelly / monthly return 计算 -> `action=predict-only`”，并写入 `runtime-artifacts/predictions/`。它不会调用 `OrderExecutor`，也不会提交 paper 或 live 订单。当前 PolyPulse 的 CLI 仍是单市场 `predict`，要做多市场推荐，需要先 `market topics`，再对选出的市场逐个 `predict` 或通过 monitor 批量评估。

Predict-Raven README 的 `### 4. 实盘交易` 对应 `pnpm pulse:live`：默认按 Pulse 推荐进入真实执行路径。PolyPulse 包含 live once 和 live monitor，但不是同款默认实盘 Pulse：所有 live 路径必须显式 `--mode live --confirm LIVE`，并通过 `.env` preflight、余额检查和 `RiskEngine`；`.env` 设为 `POLYPULSE_LIVE_WALLET_MODE=simulated` 时只演练 live 流程，不连接真实钱包、不提交真实订单，设为 `real` 时才可能真实下单。

底层策略逻辑已对齐到 Predict-Raven 的核心公式和 AI 分工：

- 话题筛选：Pulse-compatible 候选池默认最小流动性 5000，过滤缺失 CLOB token 的市场，移除 7 天内短期价格预测市场，并记录 Pulse 维度元数据。
- AI 使用方式：Codex / Claude Code 只输出 `ProbabilityEstimate`；fee、net edge、quarter Kelly、monthly return、排序、batch cap 和执行风控都由代码计算。
- Edge / sizing：`DecisionEngine` 使用 Predict-Raven 的 category fee、`netEdge = grossEdge - entryFeePct`、`quarterKellyPct = ((aiProb - marketProb) / (1 - marketProb)) / 4`、`monthlyReturn = netEdge / monthsToResolution`。
- 风控：`RiskEngine` 继续做 token 必须来自市场快照、active/tradable/closed、单笔上限、总敞口、事件敞口、流动性上限、最小金额、最大持仓数、drawdown halt、live confirm、env preflight 和 live balance。pulse-direct 默认把证据不足/低置信度作为警告而不是硬阻断；如需恢复硬阻断，设置 `PULSE_REQUIRE_EVIDENCE_GUARD=true`。

Predict-Raven 第 3、4 步在 PolyPulse 中的安全对照测试命令：

```bash
# 0. 先确认 .env 启用了 Codex provider；如果使用 Claude Code，把 expect 改成 claude-code。
npm run agent:check -- --env-file .env --expect codex

# 1. 推荐不下单：用 mock 市场数据跑单市场 predict，底层仍调用 .env 配置的 AI provider，输出 action=predict-only。
node ./bin/polypulse.js predict --env-file .env --source mock --market market-001

# 2. 推荐不下单：用真实 .env 抓市场 topic，手动选择返回的 marketId 或 marketSlug。
node ./bin/polypulse.js market topics --env-file .env --limit 20

# 3. 推荐不下单：对真实市场做单市场 predict，不调用 OrderExecutor。
node ./bin/polypulse.js predict --env-file .env --market <market-id-or-slug>

# 4. 检查推荐不下单 artifact。
find runtime-artifacts/predictions -type f | sort | tail -n 20

# 5. live 保护路径：不带 --confirm LIVE，验证会调用 AI 生成估算，但不会真实下单。
node ./bin/polypulse.js trade once --env-file .env --source mock --mode live --market market-001 --max-amount 1

# 6. simulated live：.env 使用 POLYPULSE_LIVE_WALLET_MODE=simulated，演练 live once 但不连接真实钱包、不提交真实订单。
node ./bin/polypulse.js trade once --mode live --env-file .env --market <market-id-or-slug> --max-amount 1 --confirm LIVE

# 7. real live：.env 使用 POLYPULSE_LIVE_WALLET_MODE=real，会在风控允许后真实提交订单。
node ./bin/polypulse.js trade once --mode live --env-file .env --market <market-id-or-slug> --max-amount 1 --confirm LIVE
```

Codex 提示词版本（逐条对应上面的 0-7 条命令）：

```text
0. 请先检查 .env 是否启用了 Codex provider；如果我指定 Claude Code，就改为检查 claude-code provider。
1. 请用 mock 市场数据 market-001 跑一次 predict，但概率估算必须走 .env 配置的 AI provider；确认输出 provider、effectiveProvider、action=predict-only 和 artifact 路径，不调用 OrderExecutor，不提交任何订单。
2. 请用 .env 抓取 20 个真实市场 topic，并告诉我可用于后续 predict 的 marketId 或 marketSlug。
3. 请对选出的真实市场运行 predict，确认底层 provider 不是 local，输出 action=predict-only，并汇总概率、隐含概率、edge 和 artifact 路径。
4. 请列出 runtime-artifacts/predictions 下最近 20 个文件，确认推荐不下单的 evidence、estimate 和 decision 已落盘。
5. 请用 mock 市场跑 live trade once 但不要带 confirm LIVE，确认概率估算走 AI provider，同时 live 保护路径会阻止真实下单。
6. 请只在 .env 明确使用 POLYPULSE_LIVE_WALLET_MODE=simulated 时，跑一次带 confirm LIVE 的 live once 演练，并确认不会连接真实钱包或提交真实订单。
7. 请只在我明确确认 .env 使用 real wallet 且接受真实资金风险时，跑一次真实 live once；如果缺少确认或前置检查失败，请停止并说明原因。
```

### 本地与服务器通用说明

以下命令在 macOS 和 Ubuntu 都适用，先进入项目根目录再执行；服务器部署到 `/home/PolyPulse` 时，项目根目录就是 `/home/PolyPulse`。

### 基础测试

在项目根目录执行，用于确认单元测试、离线 smoke、CLI 帮助、Codex agent 配置和 mock 交易链路都能跑通；这组命令不依赖真实 Polymarket 下单。`npm run smoke` 是离线 smoke，会强制 local fallback；下面单独列出的 `predict` / `trade once` / `monitor run` 命令带 `--env-file .env`，在 `agent:check` 通过后会调用配置的 AI provider。

```bash
# 跑完整 Node.js 测试套件。
npm test

# 跑离线 smoke 测试，确认 CLI 主链路可用。
npm run smoke

# 查看 CLI 支持的命令。
node ./bin/polypulse.js --help

# 检查 .env 是否真的启用了 Codex provider。
npm run agent:check -- --env-file .env --expect codex

# 用 mock 数据抓取市场话题，不访问真实 Polymarket。
node ./bin/polypulse.js market topics --source mock --limit 20

# 用 mock 市场跑一次预测；mock 只替代市场数据，概率估算仍走 .env 的 AI provider。
node ./bin/polypulse.js predict --env-file .env --source mock --market market-001

# 用 mock 市场跑一次 paper 下单链路；概率估算走 .env 的 AI provider，不提交真实订单。
node ./bin/polypulse.js trade once --env-file .env --source mock --mode paper --market market-001 --max-amount 1

# 用 mock 市场跑一轮 monitor；概率估算走 .env 的 AI provider，不进入无限循环。
node ./bin/polypulse.js monitor run --env-file .env --source mock --mode paper --rounds 1 --limit 2 --max-amount 1
```

Codex 提示词版本（逐条对应上面的 8 条命令）：

```text
1. 请在项目根目录运行完整 Node.js 测试套件，并在结束后告诉我是否通过、失败用例和测试 artifact 路径。
2. 请在项目根目录运行离线 smoke 测试，确认 CLI 主链路可用，并汇总结果。
3. 请查看 PolyPulse CLI 帮助，列出支持的主要命令和子命令。
4. 请检查 .env 是否启用了 Codex provider，并说明 agent:check 的 ok、provider 和 skill 配置结果。
5. 请用 mock 数据抓取 20 个市场话题，不访问真实 Polymarket，并汇总返回的 marketId 和 marketSlug。
6. 请用 mock 市场 market-001 跑一次预测，mock 只替代市场数据，概率估算必须走 .env 配置的 AI provider；检查 provider、evidence、estimate、decision 是否生成。
7. 请用 mock 市场 market-001 跑一次 paper trade once，概率估算走 .env 的 AI provider，最大金额 1，不提交真实订单，并汇总风控和下单结果。
8. 请用 mock 市场跑一轮 paper monitor，概率估算走 .env 的 AI provider，rounds=1、limit=2、max-amount=1，不进入无限循环，并汇总运行结果。
```

### 部署脚本和健康检查

在项目根目录执行，用于确认部署脚本语法、健康检查和 Codex agent 配置都正常；`agent:check` 输出 `ok=true` 后再持久化运行 monitor。

```bash
# 检查安装脚本语法。
bash -n deploy/scripts/install.sh

# 检查启动脚本语法。
bash -n deploy/scripts/start.sh

# 检查健康检查脚本语法。
bash -n deploy/scripts/healthcheck.sh

# 执行项目健康检查。
deploy/scripts/healthcheck.sh

# 检查 .env 是否真的启用了 Codex provider。
npm run agent:check -- --env-file .env --expect codex
```

Codex 提示词版本（逐条对应上面的 5 条命令）：

```text
1. 请检查 deploy/scripts/install.sh 的 bash 语法，发现语法错误时定位到行号。
2. 请检查 deploy/scripts/start.sh 的 bash 语法，发现语法错误时定位到行号。
3. 请检查 deploy/scripts/healthcheck.sh 的 bash 语法，发现语法错误时定位到行号。
4. 请执行项目部署健康检查脚本，汇总通过项、失败项和需要我处理的配置缺口。
5. 请检查 .env 是否启用了 Codex provider；只有 agent:check 返回 ok=true 后，才建议继续持久化运行 monitor。
```

### Agent Provider 配置检查

`agent:check` 用于确认 `AI_PROVIDER=codex`、`AGENT_RUNTIME_PROVIDER=codex` 是否真的选中了 Codex provider，并检查 `CODEX_SKILL_ROOT_DIR` / `CODEX_SKILLS`。如果没有配置 `CODEX_COMMAND`，它还会检查当前机器上 `codex --version` 是否可用。

把 `--expect codex` 换成 `--expect claude-code` 即可校验 Claude Code provider：要求 `.env` 中 `AI_PROVIDER=claude-code`、`AGENT_RUNTIME_PROVIDER=claude-code`，并能解析 `CLAUDE_CODE_SKILL_ROOT_DIR` / `CLAUDE_CODE_SKILLS`。没有配置 `CLAUDE_CODE_COMMAND` 时，agent:check 会调用 `claude --version` 验证 Claude Code CLI 是否安装。

```bash
# 校验当前 .env 是否成功启用 Claude Code provider。
npm run agent:check -- --env-file .env --expect claude-code
```

Codex 提示词版本（对应上面的 1 条命令）：

```text
1. 请检查当前 .env 是否成功启用 Claude Code provider，并说明 CLAUDE_CODE_* skill 配置和 claude CLI 可用性检查结果。
```

### Codex / Claude Code 完整功能链路测试

用于逐项验证“Pulse-compatible 市场话题抓取 -> 证据收集 -> 概率估算 -> Predict-Raven fee / net edge / quarter Kelly / monthly return 计算 -> RiskEngine 决定 paper/live 下单”。市场话题抓取是市场数据阶段，不调用 provider；`predict` 和 `trade once` 会先收集证据，再调用 provider 产出 `ProbabilityEstimate`。下面命令默认走 `.env` 里配置的 provider；要切换 provider，把 `.env` 里的 `AI_PROVIDER` / `AGENT_RUNTIME_PROVIDER` 改成 `codex` 或 `claude-code` 即可，命令本身保持不变。

```bash
# 0. 确认当前 env 已启用 Codex provider。
npm run agent:check -- --env-file .env --expect codex

# 1. 抓取市场话题；从返回的 topics[] 复制 marketId 或 marketSlug。
node ./bin/polypulse.js market topics --env-file .env --limit 20

# 2. 收集证据，并调用 Codex 估算事件真实发生概率。
# 3. 同一步会计算 market_implied_probability 和 edge，输出 action=predict-only。
node ./bin/polypulse.js predict --env-file .env --market <market-id-or-slug>

# 4. 检查 evidence、estimate、decision 和 Codex runtime artifact 是否落盘。
find runtime-artifacts/predictions runtime-artifacts/codex-runtime -type f | sort | tail -n 20

# 5. 走服务层硬风控和 PaperBroker，验证 paper 下单决策。
node ./bin/polypulse.js trade once --mode paper --env-file .env --market <market-id-or-slug> --max-amount 1

# 6. 走 live 风控保护路径；没有 --confirm LIVE 时不会真实下单。
node ./bin/polypulse.js trade once --mode live --env-file .env --market <market-id-or-slug> --max-amount 1

# 7. 模拟 live 一次性验收；.env 使用 POLYPULSE_LIVE_WALLET_MODE=simulated，不连接真实钱包、不提交真实订单。
node ./bin/polypulse.js trade once --mode live --env-file .env --market <market-id-or-slug> --max-amount 1 --confirm LIVE

# 8. 真实 live 一次性小额下单验收；.env 使用 POLYPULSE_LIVE_WALLET_MODE=real，会真实提交订单。
node ./bin/polypulse.js trade once --mode live --env-file .env --market <market-id-or-slug> --max-amount 1 --confirm LIVE
```

Codex 提示词版本（逐条对应上面的 0-8 步）：

```text
0. 请先检查 .env 是否启用了 Codex provider，并汇总 agent:check 的 ok、provider、runtime provider 和 skill 配置结果。
1. 请用 .env 配置抓取 20 个真实市场话题；从 topics[] 中挑出后续测试可用的 marketId 或 marketSlug。
2. 请使用上一步选出的 marketId 或 marketSlug 跑一次 predict，收集证据并调用当前 provider 估算事件真实发生概率。
3. 请在同一次 predict 结果中检查 market_implied_probability、edge 和 action=predict-only 是否存在，并说明含义。
4. 请检查 runtime-artifacts/predictions 和 runtime-artifacts/codex-runtime 中最近 20 个文件，确认 evidence、estimate、decision 和 runtime artifact 已落盘。
5. 请用同一个市场跑一次 paper trade once，max-amount=1，验证 DecisionEngine、RiskEngine 和 PaperBroker 链路，不提交真实订单。
6. 请用同一个市场跑一次 live trade once 但不要带 confirm LIVE，验证 live 风控保护路径会阻止真实下单。
7. 请在 .env 使用 POLYPULSE_LIVE_WALLET_MODE=simulated 时，用同一个市场跑一次带 confirm LIVE 的 simulated live 验收，确认不会连接真实钱包或提交真实订单。
8. 请只在我已明确确认 .env 使用 real wallet 且接受真实下单风险时，用同一个市场跑一次真实 live 小额验收；如果缺少确认或前置条件不满足，请停止并说明原因。
```

### 手动预测、余额和 Artifact 检查

用于手动验证市场扫描、单市场预测、当前模式余额读取和运行产物落盘；`--market` 要替换成上一行 `market topics` 返回的真实 `marketId` 或 `marketSlug`。

```bash
# 抓取市场话题；从返回的 topics[] 复制 marketId 或 marketSlug。
node ./bin/polypulse.js market topics --env-file .env --limit 20

# 对单个市场收集证据、估算概率、计算隐含概率和 edge。
node ./bin/polypulse.js predict --env-file .env --market <market-id-or-slug>

# 查看当前模式下的账户余额；paper 模式读取本地 paper state。
node ./bin/polypulse.js account balance --env-file .env

# 查看最近生成的 artifact 文件。
find runtime-artifacts -type f | sort | tail -n 30
```

Codex 提示词版本（逐条对应上面的 4 条命令）：

```text
1. 请用 .env 配置抓取 20 个市场话题，并告诉我可用于后续测试的 marketId 或 marketSlug。
2. 请对我指定或你刚选出的 marketId/marketSlug 运行 predict，汇总 evidence、概率估算、隐含概率和 edge。
3. 请查看当前模式下的账户余额；如果是 paper 模式，请说明余额来源是本地 paper state。
4. 请列出 runtime-artifacts 下最近 30 个 artifact 文件，并按类别说明哪些是本次测试产生的。
```

`--market <market-id-or-slug>` 来自 `market topics` 返回的 `topics[].marketId` 或 `topics[].marketSlug`。例如 mock 源同一市场可以用 `market-001` 或 `fed-cut-before-july`。

### 查看真实钱包余额

用于确认 live real wallet 能连接 Polymarket CLOB 并读取 collateral balance；`.env` 中必须是 `POLYPULSE_LIVE_WALLET_MODE=real` 且已配置真实 `PRIVATE_KEY`、`FUNDER_ADDRESS`、`SIGNATURE_TYPE`。

```bash
# 先检查 live real wallet 所需 env 是否齐全。
node ./bin/polypulse.js env check --mode live --env-file .env

# 查询真实 Polymarket CLOB collateral balance。
node ./bin/polypulse.js account balance --mode live --env-file .env
```

Codex 提示词版本（逐条对应上面的 2 条命令）：

```text
1. 请先检查 live real wallet 所需 env 是否齐全，尤其是 PRIVATE_KEY、FUNDER_ADDRESS、SIGNATURE_TYPE、CHAIN_ID 和 POLYMARKET_HOST。
2. 请在确认 .env 使用 POLYPULSE_LIVE_WALLET_MODE=real 后查询 live collateral balance；如果实际读到 paper-state，请停止并指出配置不是真实钱包。
```

如果输出里是 `executionMode=paper` 或 `collateral.source=paper-state`，表示查到的是本地 paper 账户，不是真实 Polymarket 余额。

### Paper Monitor 持久化运行

用于默认安全模式的持续扫描和 paper 交易；适合先观察策略、artifact 和风控表现，不会提交真实订单。

```bash
# 持续运行 paper monitor；只做 paper 交易，不提交真实订单。
node ./bin/polypulse.js monitor run --mode paper --env-file .env --loop
```

Codex 提示词版本（对应上面的 1 条命令）：

```text
1. 请用 .env 持续运行 paper monitor，只做 paper 交易、不提交真实订单，并持续观察 artifact、风控和错误日志。
```

### 真实 Live Monitor 持久化运行

用于真实钱包持续交易。运行前需要 `.env` 中设置 `POLYPULSE_EXECUTION_MODE=live`、`POLYPULSE_LIVE_CONFIRM=LIVE`、`POLYPULSE_LIVE_WALLET_MODE=real`，并配置真实 `PRIVATE_KEY`、`FUNDER_ADDRESS`、`SIGNATURE_TYPE`、`CHAIN_ID=137`、`POLYMARKET_HOST=https://clob.polymarket.com`。

```bash
# 持续运行真实 live monitor；会在风控允许后提交真实订单。
node ./bin/polypulse.js monitor run --mode live --env-file .env --confirm LIVE --loop
```

Codex 提示词版本（对应上面的 1 条命令）：

```text
1. 请只在我已明确确认真实钱包和真实交易风险后，使用 .env 启动 live monitor 持久化运行；启动前检查 live env、余额和 confirm LIVE，启动后汇总服务状态、风控状态和日志位置。
```

### 模拟 Live 钱包持久化运行

用于演练 live preflight、RiskEngine、artifact 和 broker 接口，不连接真实钱包、不提交真实订单。需要 `.env` 中设置 `POLYPULSE_EXECUTION_MODE=live`、`POLYPULSE_LIVE_CONFIRM=LIVE`、`POLYPULSE_LIVE_WALLET_MODE=simulated`、`SIMULATED_WALLET_BALANCE_USD=100`。

```bash
# 持续运行 simulated live monitor；走 live 流程但不连接真实钱包。
node ./bin/polypulse.js monitor run --mode live --env-file .env --confirm LIVE --loop
```

Codex 提示词版本（对应上面的 1 条命令）：

```text
1. 请在 .env 使用 simulated live wallet 时启动 live monitor 持久化演练，确认走 live preflight、RiskEngine、artifact 和 broker 接口，但不连接真实钱包、不提交真实订单。
```

### 停止和恢复 Monitor

用于维护窗口或风险暂停后恢复持续运行状态；live 模式恢复后再次启动仍需要按 live 启动要求带确认参数。

```bash
# 写入 monitor stop 状态，用于暂停持续运行。
node ./bin/polypulse.js monitor stop --env-file .env --reason manual_stop

# 清除 stop 状态，允许 monitor 再次运行。
node ./bin/polypulse.js monitor resume --env-file .env

# 恢复后重新启动 paper monitor。
node ./bin/polypulse.js monitor run --mode paper --env-file .env --loop
```

Codex 提示词版本（逐条对应上面的 3 条命令）：

```text
1. 请写入 monitor stop 状态，reason=manual_stop，用于暂停持续运行。
2. 请清除 monitor stop 状态，让 monitor 允许再次运行。
3. 请在恢复后重新启动 paper monitor 持久化运行，并确认仍然不会提交真实订单。
```

### 查看 Monitor 和风险状态

用于确认当前运行状态、最近错误、暂停/停止状态和系统级风控状态。

```bash
# 查看 monitor 状态、最近运行和最近错误。
node ./bin/polypulse.js monitor status --env-file .env

# 查看系统级风控状态。
node ./bin/polypulse.js risk status --env-file .env
```

Codex 提示词版本（逐条对应上面的 2 条命令）：

```text
1. 请查看 monitor 状态，汇总最近运行、最近错误、暂停状态和 stop/resume 状态。
2. 请查看系统级风控状态，说明当前是否允许继续运行以及阻断原因。
```

### 同步项目到服务器

在 macOS 本机把当前项目文件复制到 `/home/PolyPulse`，同时排除本地 secret、运行产物、依赖目录和 git 元数据。

```bash
# 从本机同步项目文件到服务器 /home/PolyPulse。
rsync -az --delete \
  --exclude '.git' \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude 'runtime-artifacts' \
  --exclude 'node_modules' \
  /Users/jianingyu/PolyPulse/ \
  root@43.165.166.171:/home/PolyPulse/
```

Codex 提示词版本（对应上面的 1 条命令）：

```text
1. 请在我的 macOS 本机把当前 PolyPulse 项目同步到 root@43.165.166.171:/home/PolyPulse/，同步时排除 .git、.env、.env.*、runtime-artifacts 和 node_modules，并汇总传输结果。
```

### 服务器安装

登陆 Ubuntu 服务器后安装：进入服务器目录、赋予部署脚本执行权限，并安装 systemd unit、运行目录、日志轮转和基础 smoke。

```bash
# 登录服务器。
ssh root@43.165.166.171

# 进入服务器上的项目目录。
cd /home/PolyPulse

# 确保部署脚本可执行。
chmod +x deploy/scripts/*.sh

# 安装 systemd unit、运行目录、日志轮转并执行基础 smoke。
deploy/scripts/install.sh
```

Codex 提示词版本（逐条对应上面的 4 条命令）：

```text
1. 请登录 root@43.165.166.171 这台 Ubuntu 服务器，后续命令都在服务器上执行。
2. 请进入服务器上的 /home/PolyPulse 项目目录，并确认当前目录正确。
3. 请确保 deploy/scripts/*.sh 都有可执行权限。
4. 请运行部署安装脚本，安装 systemd unit、运行目录和日志轮转，并执行基础 smoke；结束后汇总安装和 smoke 结果。
```

### 检查配置后启动服务

`install.sh` 会创建 `/home/PolyPulse/.env`，默认是 paper 模式；启动前先编辑 `.env` 并强制权限为 `600`。

```bash
# 进入服务器上的项目目录。
cd /home/PolyPulse

# 编辑服务器本地 .env，真实 secret 只放这里。
vim /home/PolyPulse/.env

# 强制 .env 只有当前用户可读写。
chmod 600 /home/PolyPulse/.env

# 启动 systemd monitor 服务。
deploy/scripts/start.sh

# 查看服务和 monitor 状态。
deploy/scripts/status.sh

# 执行部署健康检查。
deploy/scripts/healthcheck.sh
```

Codex 提示词版本（逐条对应上面的 6 条命令）：

```text
1. 请进入服务器上的 /home/PolyPulse 项目目录，并确认当前目录正确。
2. 请帮助我编辑 /home/PolyPulse/.env；不要在输出中展示真实 secret，编辑后检查必需配置是否齐全。
3. 请把 /home/PolyPulse/.env 权限强制设置为 600，并确认权限结果。
4. 请启动 systemd monitor 服务，并说明启动命令是否成功。
5. 请查看服务和 PolyPulse monitor 状态，汇总 active 状态、最近运行和最近错误。
6. 请执行部署健康检查，汇总通过项、失败项和需要处理的配置问题。
```

### 部署后验证

确认 systemd 服务 active，健康检查通过，并能看到最近 journal 和文件日志。

```bash
# 进入服务器上的项目目录。
cd /home/PolyPulse

# 确认 systemd 服务处于 active。
systemctl is-active polypulse-monitor.service

# 查看 PolyPulse 聚合状态。
deploy/scripts/status.sh

# 再跑一次部署健康检查。
deploy/scripts/healthcheck.sh

# 查看最近 systemd journal。
journalctl -u polypulse-monitor.service -n 100 --no-pager

# 查看最近文件日志。
tail -n 100 /home/PolyPulse/logs/polypulse-monitor.log
```

Codex 提示词版本（逐条对应上面的 6 条命令）：

```text
1. 请进入服务器上的 /home/PolyPulse 项目目录，并确认当前目录正确。
2. 请确认 polypulse-monitor.service 是否处于 active 状态。
3. 请查看 PolyPulse 聚合状态，汇总服务、monitor 和风险状态。
4. 请再跑一次部署健康检查，确认部署后状态仍然通过。
5. 请查看 polypulse-monitor.service 最近 100 行 systemd journal，并提取错误、警告和关键启动信息。
6. 请查看 /home/PolyPulse/logs/polypulse-monitor.log 最近 100 行，并提取错误、警告和最近交易/monitor 事件。
```

### 切换概率估算 Provider

PolyPulse 同时支持两个本地非交互 provider：Codex（`codex exec`）和 Claude Code（`claude --print`）。两者输出格式完全一致，`DecisionEngine`、`RiskEngine` 和 `OrderExecutor` 不感知 provider 切换。

只用其中一个或两个都不启用，由 `.env` 里这两行决定：

```bash
# 启用 Codex provider。需要本机有 codex CLI。
AI_PROVIDER=codex
AGENT_RUNTIME_PROVIDER=codex

# 启用 Claude Code provider。需要本机有 claude CLI（Claude Code）。
AI_PROVIDER=claude-code
AGENT_RUNTIME_PROVIDER=claude-code

# 走本地启发式估算，不调用任何外部 CLI。
AI_PROVIDER=local
AGENT_RUNTIME_PROVIDER=none
```

Codex 提示词版本（逐条对应上面的 3 组配置）：

```text
1. 请把 .env 切换为 Codex provider：设置 AI_PROVIDER=codex、AGENT_RUNTIME_PROVIDER=codex，然后运行 agent:check 验证配置。
2. 请把 .env 切换为 Claude Code provider：设置 AI_PROVIDER=claude-code、AGENT_RUNTIME_PROVIDER=claude-code，然后运行 agent:check 验证配置。
3. 请把 .env 切换为本地启发式估算：设置 AI_PROVIDER=local、AGENT_RUNTIME_PROVIDER=none，然后说明这个模式不会调用外部 CLI。
```

Claude Code provider 相关 env 变量都在 `.env.example` 的 `CLAUDE_CODE_*` 段落：

- `CLAUDE_CODE_COMMAND`：可选。提供模板化命令，覆盖默认的 `claude --print` 调用。需包含 `{{output_file}}` 占位符。
- `CLAUDE_CODE_MODEL`：可选 model alias 或全名（例如 `sonnet`、`opus`、`claude-sonnet-4-6`）。
- `CLAUDE_CODE_SKILL_ROOT_DIR` / `CLAUDE_CODE_SKILL_LOCALE` / `CLAUDE_CODE_SKILLS`：与 Codex 一致的 skill 目录/语言/skill id。
- `CLAUDE_CODE_PERMISSION_MODE`：默认 `bypassPermissions`，配合下面的工具白名单使用；也可改为 `plan`、`default` 等。
- `CLAUDE_CODE_ALLOWED_TOOLS`：默认 `Read,Glob,Grep`，限制 Claude Code 只能做只读访问。
- `CLAUDE_CODE_EXTRA_ARGS`：追加给 `claude` CLI 的额外参数（按 shell 规则解析）。
- `CLAUDE_CODE_MAX_BUDGET_USD`：可选预算上限，传给 `--max-budget-usd`。

切换到 Claude Code 后再跑一次 `agent:check` 与 README 中其他 `predict` / `trade once` / `monitor run` 命令即可。CODEX_* 段落保持不变，可以随时切回 Codex provider。

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
