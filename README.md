# PolyPulse

PolyPulse 是一个面向 Polymarket 的预测市场自主交易 Agent 框架。核心链路是：抓取市场话题，收集证据，估算事件真实发生概率，计算市场隐含概率和 edge，再通过服务层硬风控决定是否 paper / live 下单。

默认运行模式是 `paper`。任何 live 路径都必须显式 `--mode live --confirm LIVE`，并通过 env preflight、余额检查和 `RiskEngine`。

## 当前状态

- Polymarket 市场扫描：分页、过滤、缓存、超时、重试、artifact。
- EvidenceCrawler：适配器接口、去重、缓存、失败标记。
- ProbabilityEstimator：本地启发式 provider + Predict-Raven 风格 Codex runtime。
- DecisionEngine：market probability、AI probability、edge、EV、suggested side。
- RiskEngine：系统级、仓位级、交易级、数据级、live 级硬风控。
- Broker：`PaperBroker`、`LiveBroker`、`simulated-live-wallet`。
- One-shot：预测、风控、paper/live broker 闭环。
- Monitor：持久扫描、候选预测、去重、crash recovery、artifact。
- 部署：轻量 systemd VPS 部署脚本，默认 paper。

## 快速开始

```bash
npm test
npm run smoke
node ./bin/polypulse.js --help
```

离线 mock 示例：

```bash
node ./bin/polypulse.js market topics --source mock --limit 20
node ./bin/polypulse.js predict --source mock --market market-001
node ./bin/polypulse.js trade once --source mock --mode paper --market market-001 --max-amount 1
node ./bin/polypulse.js monitor run --source mock --mode paper --rounds 1 --limit 2 --max-amount 1
```

## 如何填写 `--market`

`--market <market-id-or-slug>` 来自市场扫描输出：

```bash
node ./bin/polypulse.js market topics --env-file /home/PolyPulse/.env --limit 20
```

在返回的 `topics[]` 中复制任意一个：

- `marketId`
- `marketSlug`

例如 mock 源返回的同一市场可以用：

```bash
node ./bin/polypulse.js predict --source mock --market market-001
node ./bin/polypulse.js predict --source mock --market fed-cut-before-july
```

真实 Polymarket 源也同理：先 `market topics`，再把 `topics[].marketId` 或 `topics[].marketSlug` 填入 `predict` / `trade once`。

## 常用命令

```bash
node ./bin/polypulse.js env check --env-file .env.example
node ./bin/polypulse.js account balance --env-file .env.example
node ./bin/polypulse.js market topics --limit 20
node ./bin/polypulse.js predict --market <market-id-or-slug>
```

Paper 下单：

```bash
node ./bin/polypulse.js trade once --mode paper --market <market-id-or-slug> --max-amount 1
node ./bin/polypulse.js monitor run --mode paper --rounds 1
```

Live 下单必须显式确认：

```bash
node ./bin/polypulse.js trade once --mode live --market <market-id-or-slug> --max-amount 1 --env-file /path/to/.env --confirm LIVE
node ./bin/polypulse.js monitor run --mode live --env-file /path/to/.env --confirm LIVE
```

## Codex Runtime

PolyPulse 支持 Predict-Raven 风格的 Codex provider 配置：

```dotenv
AGENT_RUNTIME_PROVIDER=codex
PROVIDER_TIMEOUT_SECONDS=600
CODEX_COMMAND=
CODEX_MODEL=
CODEX_SKILL_ROOT_DIR=skills
CODEX_SKILL_LOCALE=zh
CODEX_SKILLS=polypulse-market-agent
```

默认 Codex 路径会以 read-only sandbox 运行：

```text
codex exec --skip-git-repo-check -C <repoRoot> -s read-only --output-schema <schema> -o <output> --color never [-m model] [-add-dir skillRoot] -
```

也可以用 `CODEX_COMMAND` 自定义命令模板，支持：

```text
{{repo_root}} {{prompt_file}} {{output_file}} {{schema_file}} {{skill_root}} {{market_json}} {{evidence_json}} {{risk_doc}}
```

安全边界：Codex 在 PolyPulse 中只能输出 `ProbabilityEstimate`，不能直接输出 broker 参数、token 改写、交易金额或可执行订单。所有交易仍必须经过 `DecisionEngine`、`RiskEngine` 和 `OrderExecutor`。

## Live 钱包模式

服务器 live 部署支持两种钱包模式：

```dotenv
POLYPULSE_LIVE_WALLET_MODE=real
```

`real` 会连接真实 Polymarket 钱包，必须配置：

```dotenv
PRIVATE_KEY=
FUNDER_ADDRESS=
SIGNATURE_TYPE=
CHAIN_ID=137
POLYMARKET_HOST=https://clob.polymarket.com
```

模拟 live 钱包：

```dotenv
POLYPULSE_LIVE_WALLET_MODE=simulated
SIMULATED_WALLET_ADDRESS=
SIMULATED_WALLET_BALANCE_USD=100
```

`simulated` 用于在服务器上演练 live preflight、RiskEngine、artifact 和 broker 接口，不连接真实钱包、不提交真实订单。它仍然要求 live 双确认：

```bash
deploy/scripts/start.sh --wallet simulated --confirm LIVE
```

真实钱包启动：

```bash
deploy/scripts/start.sh --wallet real --confirm LIVE
```

## 运行产物

主要 artifact 路径：

```text
runtime-artifacts/markets/<timestamp>/
runtime-artifacts/predictions/<timestamp>-<market>/
runtime-artifacts/runs/<timestamp>-once/
runtime-artifacts/monitor/<date>/<run-id>/
runtime-artifacts/account/<timestamp>/
runtime-artifacts/test-runs/<timestamp>/
runtime-artifacts/codex-runtime/<timestamp>/
```

所有 artifact 写入前会做 secret redaction。不要把真实 `.env`、私钥、助记词、API key、cookie 或 session token 写入仓库、日志、memory 或测试快照。

## 轻量服务器部署

PolyPulse 提供 systemd 部署方案。目标服务器登陆方式：

```bash
ssh root@43.165.166.171
```

脚本只负责部署运行环境，不会把本地 secret 写到服务器。真实 `.env` 必须只保存在服务器本地。

### 目录约定

服务器上所有部署文件放在：

```text
/home/PolyPulse
```

运行时文件默认放在：

```text
/home/PolyPulse/.env
/home/PolyPulse/runtime-artifacts
/home/PolyPulse/runtime-artifacts/state
/home/PolyPulse/logs
```

`.env` 权限必须是 `600`，不能提交到 git。

### 部署文件

- `deploy/env.example`：服务器 `.env` 模板，默认 paper。
- `deploy/systemd/polypulse-monitor.service`：systemd 常驻 monitor 服务。
- `deploy/scripts/install.sh`：安装 systemd unit、创建目录、配置日志轮转、执行 paper smoke。
- `deploy/scripts/start.sh`：启动 monitor 服务。
- `deploy/scripts/stop.sh`：停止 monitor 服务并写入 monitor stop 状态。
- `deploy/scripts/status.sh`：查看 systemd、monitor state 和最近日志。
- `deploy/scripts/healthcheck.sh`：检查 Node、env 权限、preflight、paper smoke。

### 初次安装

在本机把仓库同步到服务器：

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

登陆服务器后安装：

```bash
ssh root@43.165.166.171
cd /home/PolyPulse
chmod +x deploy/scripts/*.sh
deploy/scripts/install.sh
```

`install.sh` 会创建 `/home/PolyPulse/.env`。默认是 paper 模式。检查后再启动：

```bash
vim /home/PolyPulse/.env
chmod 600 /home/PolyPulse/.env
deploy/scripts/start.sh
```

### Paper Monitor 常驻

`.env` 保持：

```dotenv
POLYPULSE_EXECUTION_MODE=paper
POLYPULSE_LIVE_CONFIRM=
```

启动：

```bash
cd /home/PolyPulse
deploy/scripts/start.sh
```

### Live Monitor 常驻

live 启动需要两层确认。

真实钱包 `.env`：

```dotenv
POLYPULSE_EXECUTION_MODE=live
POLYPULSE_LIVE_CONFIRM=LIVE
POLYPULSE_LIVE_WALLET_MODE=real
PRIVATE_KEY=<server-only-secret>
FUNDER_ADDRESS=<proxy-or-funder-address>
SIGNATURE_TYPE=<polymarket-signature-type>
CHAIN_ID=137
POLYMARKET_HOST=https://clob.polymarket.com
```

模拟 live 钱包 `.env`，用于演练 live 路径但不连接真实钱包、不发真实订单：

```dotenv
POLYPULSE_EXECUTION_MODE=live
POLYPULSE_LIVE_CONFIRM=LIVE
POLYPULSE_LIVE_WALLET_MODE=simulated
SIMULATED_WALLET_ADDRESS=
SIMULATED_WALLET_BALANCE_USD=100
```

启动真实钱包 live：

```bash
cd /home/PolyPulse
deploy/scripts/start.sh --wallet real --confirm LIVE
```

启动模拟钱包 live：

```bash
cd /home/PolyPulse
deploy/scripts/start.sh --wallet simulated --confirm LIVE
```

没有 `POLYPULSE_LIVE_CONFIRM=LIVE` 或没有 `--confirm LIVE` 时，脚本和 systemd service 都会拒绝 live monitor。

### 服务器常用命令

查看状态：

```bash
cd /home/PolyPulse
deploy/scripts/status.sh
```

健康检查：

```bash
cd /home/PolyPulse
deploy/scripts/healthcheck.sh
```

手动跑一次预测：

```bash
cd /home/PolyPulse
node ./bin/polypulse.js market topics --env-file /home/PolyPulse/.env --limit 20
node ./bin/polypulse.js predict --env-file /home/PolyPulse/.env --market <market-id-or-slug>
```

手动查余额：

```bash
cd /home/PolyPulse
node ./bin/polypulse.js account balance --env-file /home/PolyPulse/.env
```

查看最近 artifact：

```bash
cd /home/PolyPulse
find runtime-artifacts -type f | sort | tail -n 30
```

停止 monitor：

```bash
cd /home/PolyPulse
deploy/scripts/stop.sh
```

恢复 monitor 状态并启动：

```bash
cd /home/PolyPulse
node ./bin/polypulse.js monitor resume --env-file /home/PolyPulse/.env
deploy/scripts/start.sh
```

live 模式恢复后启动仍需：

```bash
deploy/scripts/start.sh --confirm LIVE
```

### 日志轮转

服务日志写入：

```text
/home/PolyPulse/logs/polypulse-monitor.log
/home/PolyPulse/logs/polypulse-monitor.err.log
```

`install.sh` 会安装 `/etc/logrotate.d/polypulse-monitor`，默认保留 14 天压缩日志。

### 部署后验证

```bash
systemctl is-active polypulse-monitor.service
deploy/scripts/status.sh
deploy/scripts/healthcheck.sh
journalctl -u polypulse-monitor.service -n 100 --no-pager
tail -n 100 /home/PolyPulse/logs/polypulse-monitor.log
```

更完整的上线 runbook：

- `docs/runbooks/server-deploy.md`
- `docs/runbooks/live-trading-checklist.md`

## 测试

```bash
npm test
npm run smoke
bash -n deploy/scripts/install.sh
bash -n deploy/scripts/start.sh
bash -n deploy/scripts/healthcheck.sh
git diff --check
```

最近验证：`npm test` 69 pass，`npm run smoke` 7 pass。

## 关键文档

- `docs/specs/product-requirements.md`
- `docs/specs/architecture.md`
- `docs/specs/risk-controls.md`
- `docs/specs/testing-plan.md`
- `docs/testing.md`
- `docs/FINAL_ACCEPTANCE.md`
- `docs/KNOWN_LIMITATIONS.md`
- `docs/ROADMAP.md`
- `docs/memory/POLYPULSE_MEMORY.md`
