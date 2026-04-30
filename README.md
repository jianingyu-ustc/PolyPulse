# PolyPulse

PolyPulse 是一个面向 Polymarket 的预测市场自主交易 Agent 框架。核心链路是：抓取市场话题，收集证据，估算事件真实发生概率，计算市场隐含概率和 edge，再通过服务层硬风控决定是否 paper / live 下单。

默认运行模式是 `paper`。任何 live 路径都必须显式 `--mode live --confirm LIVE`，并通过 env preflight、余额检查和 `RiskEngine`。

## 项目概览

当前能力：Polymarket 市场扫描、EvidenceCrawler、ProbabilityEstimator、DecisionEngine、RiskEngine、paper/live broker、one-shot、monitor 常驻运行和 systemd 部署。默认运行模式是 `paper`；任何 live 路径都必须显式 `--mode live --confirm LIVE`，并通过 env preflight、余额检查和 `RiskEngine`。

Codex runtime 只允许输出 `ProbabilityEstimate`，不能直接输出 broker 参数、token 改写、交易金额或可执行订单。所有交易仍必须经过 `DecisionEngine`、`RiskEngine` 和 `OrderExecutor`。

主要 artifact 写入 `runtime-artifacts/`，包括 markets、predictions、runs、monitor、account、test-runs 和 codex-runtime。所有 artifact 写入前会做 secret redaction。不要把真实 `.env`、私钥、助记词、API key、cookie 或 session token 写入仓库、日志、memory 或测试快照。

服务器部署默认目录是 `/home/PolyPulse`，运行时文件默认在 `/home/PolyPulse/.env`、`/home/PolyPulse/runtime-artifacts`、`/home/PolyPulse/runtime-artifacts/state` 和 `/home/PolyPulse/logs`。`.env` 权限必须是 `600`，真实 secret 只放服务器本地。

部署相关文件：`deploy/env.example` 是服务器 `.env` 模板，`deploy/systemd/polypulse-monitor.service` 是 systemd 常驻 monitor 服务，`deploy/scripts/*.sh` 覆盖安装、启动、停止、状态和健康检查。

## 指令案例

### macOS、Ubuntu 服务器的测试、持久化运行命令

以下命令在 macOS 和 Ubuntu 都适用，先进入项目根目录再执行；服务器部署到 `/home/PolyPulse` 时，项目根目录就是 `/home/PolyPulse`。

基础测试：在项目根目录执行，用于确认单元测试、离线 smoke、CLI 帮助、Codex agent 配置和 mock 交易链路都能跑通；这组命令不依赖真实 Polymarket 下单。

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

# 用 mock 市场跑一次预测。
node ./bin/polypulse.js predict --source mock --market market-001

# 用 mock 市场跑一次 paper 下单链路，不提交真实订单。
node ./bin/polypulse.js trade once --source mock --mode paper --market market-001 --max-amount 1

# 用 mock 市场跑一轮 monitor，不进入无限循环。
node ./bin/polypulse.js monitor run --source mock --mode paper --rounds 1 --limit 2 --max-amount 1
```

部署脚本和健康检查：在项目根目录执行，用于确认部署脚本语法、健康检查和 Codex agent 配置都正常；`agent:check` 输出 `ok=true` 后再持久化运行 monitor。

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

`agent:check` 用于确认 `AI_PROVIDER=codex`、`AGENT_RUNTIME_PROVIDER=codex` 是否真的选中了 Codex provider，并检查 `CODEX_SKILL_ROOT_DIR` / `CODEX_SKILLS`。如果没有配置 `CODEX_COMMAND`，它还会检查当前机器上 `codex --version` 是否可用。

Codex 完整功能链路测试：用于逐项验证“市场话题抓取 -> 证据收集 -> Codex 概率估算 -> 隐含概率和 edge 计算 -> RiskEngine 决定 paper/live 下单”。市场话题抓取是市场数据阶段，不调用 Codex；`predict` 和 `trade once` 会先收集证据，再调用 Codex 产出 `ProbabilityEstimate`。

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

手动预测、余额和 artifact 检查：用于手动验证市场扫描、单市场预测、当前模式余额读取和运行产物落盘；`--market` 要替换成上一行 `market topics` 返回的真实 `marketId` 或 `marketSlug`。

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

`--market <market-id-or-slug>` 来自 `market topics` 返回的 `topics[].marketId` 或 `topics[].marketSlug`。例如 mock 源同一市场可以用 `market-001` 或 `fed-cut-before-july`。

查看真实钱包余额：用于确认 live real wallet 能连接 Polymarket CLOB 并读取 collateral balance；`.env` 中必须是 `POLYPULSE_LIVE_WALLET_MODE=real` 且已配置真实 `PRIVATE_KEY`、`FUNDER_ADDRESS`、`SIGNATURE_TYPE`。

```bash
# 先检查 live real wallet 所需 env 是否齐全。
node ./bin/polypulse.js env check --mode live --env-file .env

# 查询真实 Polymarket CLOB collateral balance。
node ./bin/polypulse.js account balance --mode live --env-file .env
```

如果输出里是 `executionMode=paper` 或 `collateral.source=paper-state`，表示查到的是本地 paper 账户，不是真实 Polymarket 余额。

Paper monitor 持久化运行：用于默认安全模式的持续扫描和 paper 交易；适合先观察策略、artifact 和风控表现，不会提交真实订单。

```bash
# 持续运行 paper monitor；只做 paper 交易，不提交真实订单。
node ./bin/polypulse.js monitor run --mode paper --env-file .env --loop
```

真实 live monitor 持久化运行：用于真实钱包持续交易。运行前需要 `.env` 中设置 `POLYPULSE_EXECUTION_MODE=live`、`POLYPULSE_LIVE_CONFIRM=LIVE`、`POLYPULSE_LIVE_WALLET_MODE=real`，并配置真实 `PRIVATE_KEY`、`FUNDER_ADDRESS`、`SIGNATURE_TYPE`、`CHAIN_ID=137`、`POLYMARKET_HOST=https://clob.polymarket.com`。

```bash
# 持续运行真实 live monitor；会在风控允许后提交真实订单。
node ./bin/polypulse.js monitor run --mode live --env-file .env --confirm LIVE --loop
```

模拟 live 钱包持久化运行：用于演练 live preflight、RiskEngine、artifact 和 broker 接口，不连接真实钱包、不提交真实订单。需要 `.env` 中设置 `POLYPULSE_EXECUTION_MODE=live`、`POLYPULSE_LIVE_CONFIRM=LIVE`、`POLYPULSE_LIVE_WALLET_MODE=simulated`、`SIMULATED_WALLET_BALANCE_USD=100`。

```bash
# 持续运行 simulated live monitor；走 live 流程但不连接真实钱包。
node ./bin/polypulse.js monitor run --mode live --env-file .env --confirm LIVE --loop
```

停止和恢复 monitor：用于维护窗口或风险暂停后恢复持续运行状态；live 模式恢复后再次启动仍需要按 live 启动要求带确认参数。

```bash
# 写入 monitor stop 状态，用于暂停持续运行。
node ./bin/polypulse.js monitor stop --env-file .env --reason manual_stop

# 清除 stop 状态，允许 monitor 再次运行。
node ./bin/polypulse.js monitor resume --env-file .env

# 恢复后重新启动 paper monitor。
node ./bin/polypulse.js monitor run --mode paper --env-file .env --loop
```

查看 monitor 和风险状态：用于确认当前运行状态、最近错误、暂停/停止状态和系统级风控状态。

```bash
# 查看 monitor 状态、最近运行和最近错误。
node ./bin/polypulse.js monitor status --env-file .env

# 查看系统级风控状态。
node ./bin/polypulse.js risk status --env-file .env
```

### 将项目部署到服务器的命令

在 macOS 本机同步仓库到服务器：把当前项目文件复制到 `/home/PolyPulse`，同时排除本地 secret、运行产物、依赖目录和 git 元数据。

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

检查配置后启动：`install.sh` 会创建 `/home/PolyPulse/.env`，默认是 paper 模式；启动前先编辑 `.env` 并强制权限为 `600`。

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

部署后验证：确认 systemd 服务 active，健康检查通过，并能看到最近 journal 和文件日志。

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
