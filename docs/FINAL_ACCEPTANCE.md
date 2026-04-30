# PolyPulse 最终验收

验收日期：2026-04-30

## 结论

PolyPulse 已完成预测市场自主交易 Agent 的 MVP 框架：支持 Polymarket 市场扫描、证据抓取接口、概率估算、edge 计算、硬风控、paper/live Broker 抽象、一次性闭环、持久 monitor、运行 artifact、测试矩阵和轻量级 systemd 部署脚本。

默认安全状态为 paper。live 路径在无显式确认、env 缺失、余额检查缺失或 RiskEngine 拒绝时均 fail-closed。

## 已完成能力

| PRD 能力 | 验收状态 | 说明 |
| --- | --- | --- |
| Polymarket 账户余额查询 | 已完成 | `account balance` 支持 paper 与 live mock，live 缺 env fail-fast，输出脱敏地址和 artifact。 |
| 当前市场话题抓取 | 已完成 | `PolymarketMarketSource` 支持 Gamma 分页、过滤、cache、retry、timeout、风险标记和 market scan artifact。 |
| AI 证据抓取 | 部分完成 | `EvidenceCrawler` 支持适配器、超时、重试、去重、cache 和 artifact；外部搜索适配器仍待接入。 |
| AI 胜率/概率估算 | 部分完成 | `ProbabilityEstimator` 有 schema、证据引用、置信度、uncertainty；当前默认是本地启发式 provider，真实 AI provider 待接入。 |
| 市场隐含概率计算 | 已完成 | `DecisionEngine` 使用可执行价格优先口径，输出 market probability、edge、EV。 |
| Edge 计算 | 已完成 | 输出 gross edge、net edge、expected value、suggested notional。 |
| 流动性过滤 | 已完成 | scan 过滤低 liquidity/volume，RiskEngine 使用 liquidity cap 并只向下裁剪。 |
| Paper 一次性下单 | 已完成 | `trade once --mode paper` 完成 market -> evidence -> estimate -> decision -> risk -> PaperBroker -> artifacts。 |
| Live 一次性下单 | 安全脚手架完成 | `trade once --mode live --confirm LIVE` 进入 live broker；真实下单未执行，自动测试只用 mock broker。 |
| Paper 持久监测与下单 | 已完成 | `monitor run --mode paper` 支持单轮/loop、状态、去重、crash recovery、artifact。 |
| Live 持久监测与下单 | 安全脚手架完成 | `monitor run --mode live --confirm LIVE` 支持 mock live broker；默认拒绝，无真实 live 验证。 |
| 交易决策归档 | 已完成 | one-shot 和 monitor 均写 market/evidence/estimate/decision/risk/order/summary。 |
| 可恢复运行状态 | 已完成 | JSON StateStore 支持 paper/live 隔离、portfolio、orders、risk state、monitor state、in-flight recovery。 |
| 轻量级服务器部署 | 已完成脚本 | 提供 systemd、install/start/stop/status/healthcheck、logrotate、runbook；未实际部署。 |

## 未完成能力

- 真实外部网页/新闻/官方数据搜索适配器尚未接入；当前 evidence 默认来自市场元数据与 resolution source。
- 默认 ProbabilityEstimator 是本地启发式，尚未接入真实 LLM / AI command provider。
- LiveBroker 真实 Polymarket SDK 路径未在真实钱包上验证；目前仅 mock client 测试。
- live confirmation 尚未绑定 run id、market、side、amount、env fingerprint；当前安全门是 `--confirm LIVE` + env preflight + balance + RiskEngine。
- CLI 尚未提供完整 reduce/close 命令；PaperBroker 层支持 sell，one-shot CLI 主要覆盖 outcome buy。
- HTTP health endpoint 未实现；轻量部署使用 `deploy/scripts/healthcheck.sh` 作为等价命令式 healthcheck。
- 多 outcome / neg-risk / 深度加权成交概率仍为简化口径。

## 测试结果

完整测试：

```bash
npm test
```

结果：

- `tests`: 62
- `pass`: 62
- `fail`: 0
- artifact: `runtime-artifacts/test-runs/2026-04-30T12-11-40-852Z/summary.json`

Smoke：

```bash
npm run smoke
```

结果：

- `commands`: 7
- `pass`: 7
- `fail`: 0
- artifact: `runtime-artifacts/test-runs/2026-04-30T12-12-32-586Z-smoke/summary.json`

脚本与格式检查：

```bash
bash -n deploy/scripts/install.sh deploy/scripts/start.sh deploy/scripts/stop.sh deploy/scripts/status.sh deploy/scripts/healthcheck.sh
node --check scripts/run-tests.js
node --check scripts/smoke.js
git diff --check
```

结果：均通过。

## Paper Demo 结果

Paper one-shot demo：

```bash
STATE_DIR=runtime-artifacts/final-acceptance/once-state \
ARTIFACT_DIR=runtime-artifacts/final-acceptance \
node ./bin/polypulse.js trade once --source mock --mode paper --market market-001 --max-amount 1
```

结果：

- market: `Will the Fed cut rates before July 2026?`
- AI probability: `0.4886`
- market probability: `0.43`
- edge: `0.0586`
- action: `paper-order`
- artifact: `runtime-artifacts/final-acceptance/runs/2026-04-30T12-06-05-058Z-once/summary.md`

Paper monitor demo：

```bash
STATE_DIR=runtime-artifacts/final-acceptance/monitor-state \
ARTIFACT_DIR=runtime-artifacts/final-acceptance \
MONITOR_CONCURRENCY=1 \
MONITOR_MAX_TRADES_PER_ROUND=1 \
node ./bin/polypulse.js monitor run --source mock --mode paper --rounds 1 --limit 2 --max-amount 1
```

结果：

- markets: `2`
- candidates: `2`
- predictions: `2`
- filled orders: `1`
- action: `paper-orders`
- artifact: `runtime-artifacts/final-acceptance/monitor/2026-04-30/2026-04-30t12-06-05-049z-39dcfc79/summary.md`

## Live 安全门禁结果

Live one-shot 默认拒绝：

```bash
STATE_DIR=runtime-artifacts/final-acceptance/live-state \
ARTIFACT_DIR=runtime-artifacts/final-acceptance \
node ./bin/polypulse.js trade once --source mock --mode live --market market-001 --max-amount 1
```

结果：

- action: `no-trade`
- blocked reasons: `live_requires_confirm_live`, `live_preflight_failed`, `live_balance_check_missing`
- artifact: `runtime-artifacts/final-acceptance/runs/2026-04-30T12-06-05-055Z-once/summary.md`

Live monitor 默认拒绝：

```bash
STATE_DIR=runtime-artifacts/final-acceptance/live-monitor-state \
ARTIFACT_DIR=runtime-artifacts/final-acceptance \
MONITOR_CONCURRENCY=1 \
node ./bin/polypulse.js monitor run --source mock --mode live --rounds 1 --limit 1 --max-amount 1
```

结果：

- action: `no-trade`
- orders: `0`
- blocked reasons: `live_requires_confirm_live`, `live_preflight_failed`, `live_balance_check_missing`
- artifact: `runtime-artifacts/final-acceptance/monitor/2026-04-30/2026-04-30t12-06-05-049z-c8d98615/summary.md`

Live env check with `.env.example`：

```bash
node ./bin/polypulse.js env check --mode live --env-file .env.example
```

结果：`ok=false`，缺少 `PRIVATE_KEY`、`FUNDER_ADDRESS`、`SIGNATURE_TYPE`、`POLYMARKET_HOST`，未打印 private key。

## Secret 检查

执行：

```bash
rg -n "(PRIVATE_KEY|API_KEY|SECRET|TOKEN|COOKIE|SESSION)[[:space:]]*[:=]" . --glob '!runtime-artifacts/**' --glob '!node_modules/**' --glob '!.git/**'
# 另执行了测试用 fake private-key literal 扫描，范围为 runtime-artifacts 与 docs/memory。
```

结论：

- 未发现真实 secret。
- 命中项为 env 模板空值、runbook 占位符、测试 fake literal 或 memory 中的检查记录。
- runtime artifacts 中只记录缺失字段名和 fail-closed reason，不包含 private key 值。

## Runtime Artifacts 结构

最终验收产物目录：

```text
runtime-artifacts/final-acceptance/
  runs/<timestamp>-once/
    input.json
    market.json
    evidence.json
    estimate.json
    decision.json
    risk.json
    order.json
    summary.md
  monitor/<date>/<run-id>/
    markets.json
    candidates.json
    predictions/<market>/
    decisions.json
    risk.json
    orders.json
    summary.md
  once-state/
  monitor-state/
  live-state/
  live-monitor-state/
```

大小检查：

- `runtime-artifacts/final-acceptance`: 约 `212K`
- `runtime-artifacts/test-runs`: 约 `176K`

## 部署验证结果

部署文件已创建：

- `README.md`
- `deploy/env.example`
- `deploy/systemd/polypulse-monitor.service`
- `deploy/scripts/install.sh`
- `deploy/scripts/start.sh`
- `deploy/scripts/stop.sh`
- `deploy/scripts/status.sh`
- `deploy/scripts/healthcheck.sh`
- `docs/runbooks/server-deploy.md`
- `docs/runbooks/live-trading-checklist.md`

验证：

- `bash -n deploy/scripts/*.sh` 通过。
- `deploy/scripts/healthcheck.sh` 包含 env 权限检查、preflight、paper smoke。
- systemd service 默认 paper，live 需要 `.env` 中 `POLYPULSE_LIVE_CONFIRM=LIVE` 且启动命令 `--confirm LIVE`。
- 部署文档覆盖 `/home/PolyPulse`、logrotate、自动重启、healthcheck、paper/live monitor、手动预测、余额、artifact、停止和恢复。

未执行：

- 未连接 `ssh root@43.165.166.171`。
- 未 rsync。
- 未安装 systemd unit。
- 未运行真实 live 下单。

## 关键命令

```bash
npm test
npm run smoke
node ./bin/polypulse.js env check --mode live --env-file .env.example
node ./bin/polypulse.js market topics --source mock --limit 20
node ./bin/polypulse.js predict --source mock --market market-001
node ./bin/polypulse.js trade once --source mock --mode paper --market market-001 --max-amount 1
node ./bin/polypulse.js monitor run --source mock --mode paper --rounds 1 --limit 2 --max-amount 1
node ./bin/polypulse.js monitor status --source mock
```

服务器部署命令：

```bash
rsync -az --delete --exclude '.git' --exclude '.env' --exclude '.env.*' --exclude 'runtime-artifacts' --exclude 'node_modules' /Users/jianingyu/PolyPulse/ root@43.165.166.171:/home/PolyPulse/
ssh root@43.165.166.171
cd /home/PolyPulse
chmod +x deploy/scripts/*.sh
deploy/scripts/install.sh
deploy/scripts/start.sh
deploy/scripts/status.sh
```

## 关键 Artifact 路径

- Full test summary: `runtime-artifacts/test-runs/2026-04-30T12-11-40-852Z/summary.json`
- Smoke summary: `runtime-artifacts/test-runs/2026-04-30T12-12-32-586Z-smoke/summary.json`
- Paper one-shot summary: `runtime-artifacts/final-acceptance/runs/2026-04-30T12-06-05-058Z-once/summary.md`
- Paper monitor summary: `runtime-artifacts/final-acceptance/monitor/2026-04-30/2026-04-30t12-06-05-049z-39dcfc79/summary.md`
- Live one-shot blocked summary: `runtime-artifacts/final-acceptance/runs/2026-04-30T12-06-05-055Z-once/summary.md`
- Live monitor blocked summary: `runtime-artifacts/final-acceptance/monitor/2026-04-30/2026-04-30t12-06-05-049z-c8d98615/summary.md`

## 仍需人工确认的事项

- 真实 Polymarket 凭据、代理钱包、signature type 和 allowance。
- 真实 LiveBroker SDK / client 行为。
- live 下单前的极小金额试运行计划。
- 生产 watchlist/blocklist 和风险阈值。
- 是否接入真实 AI provider 与外部证据搜索。
- 是否需要 HTTP health server、通知器或远程 artifact index。
