# PolyPulse

PolyPulse 是一个面向 Polymarket 的预测市场自主交易 Agent 框架。当前 README 只保留两条运行路径：

- `live simulated`：读取当前 Polymarket 真实市场，走 live preflight、RiskEngine、artifact 和 broker 接口，但不连接真实钱包、不提交真实订单。
- `live real`：读取当前 Polymarket 真实市场，连接真实钱包，并在风控允许后提交真实订单。

所有测试、验收和部署命令都必须使用 `.env`，并读取当前 Polymarket 真实市场。

## 项目概览

核心链路：抓取当前 Polymarket 市场话题，收集证据，调用配置的 AI provider 估算事件真实发生概率，按 Predict-Raven `pulse-direct` 口径计算 fee、net edge、quarter Kelly sizing 和 monthly return，再通过 `RiskEngine`、live preflight、余额检查和 `OrderExecutor` 决定是否执行。

Codex / Claude Code runtime 只允许输出 `ProbabilityEstimate`，不能直接输出 broker 参数、token 改写、交易金额或可执行订单。AI 只负责概率和证据判断；fee、net edge、quarter Kelly、monthly return、排序、batch cap 和执行风控都由代码计算。

主要 artifact 写入 `runtime-artifacts/`，包括 markets、predictions、runs、monitor、account、test-runs 和 provider runtime 日志。所有 artifact 写入前会做 secret redaction。不要把真实 `.env`、私钥、助记词、API key、cookie 或 session token 写入仓库、日志、memory 或测试快照。

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
find runtime-artifacts -type f | sort | tail -n 30
```

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

Codex 提示词版本：

```text
1. 请检查 .env、provider、真实市场读取和 confirm LIVE。
2. 如果是 live simulated，请启动 monitor，并确认它读取当前 Polymarket 真实市场但不连接真实钱包、不提交真实订单。
3. 如果是 live real，请先运行 account balance 和 account audit，并只在我明确确认真实交易风险且 audit 无阻断后启动 monitor。
4. 启动后请汇总 monitor 状态、风控状态、artifact 和日志位置。
```

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
