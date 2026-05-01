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

每个命令块后面的 `Codex 提示词版本` 可以直接复制到 Codex 中执行；提示词与上方命令或配置步骤按编号一一对应，由 Codex 负责运行同等检查、真实市场测试和失败原因汇总。

### 必需运行模式

`.env` 必须明确选择以下两种模式之一。

`live simulated` 用于真实市场演练：

```bash
POLYPULSE_EXECUTION_MODE=live
POLYPULSE_LIVE_CONFIRM=LIVE
POLYPULSE_LIVE_WALLET_MODE=simulated
SIMULATED_WALLET_BALANCE_USD=100
POLYPULSE_MARKET_SOURCE=polymarket
POLYMARKET_GAMMA_HOST=https://gamma-api.polymarket.com
```

`live real` 用于真实钱包交易：

```bash
POLYPULSE_EXECUTION_MODE=live
POLYPULSE_LIVE_CONFIRM=LIVE
POLYPULSE_LIVE_WALLET_MODE=real
PRIVATE_KEY=<server-local-secret>
FUNDER_ADDRESS=<0x...>
SIGNATURE_TYPE=<signature-type>
CHAIN_ID=137
POLYMARKET_HOST=https://clob.polymarket.com
POLYPULSE_MARKET_SOURCE=polymarket
POLYMARKET_GAMMA_HOST=https://gamma-api.polymarket.com
```

Codex 提示词版本：

```text
1. 请检查 .env 是否是 live simulated 或 live real，并确认 POLYPULSE_MARKET_SOURCE=polymarket、POLYMARKET_GAMMA_HOST 指向真实 Gamma API。
2. 如果是 live simulated，请确认它会读取真实 Polymarket 市场，但不会连接真实钱包或提交真实订单。
3. 如果是 live real，请确认 PRIVATE_KEY、FUNDER_ADDRESS、SIGNATURE_TYPE、CHAIN_ID 和 POLYMARKET_HOST 已配置，并提醒这是会触发真实资金路径的配置。
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

Codex 提示词版本：

```text
1. 请检查 .env 是否启用了 Codex 或 Claude Code provider，并确认会调用配置的真实 AI provider。
2. 请运行 agent:check 验证当前 provider、runtime provider 和 skill 配置。
```

### Live Simulated 验收

以下命令全部读取当前 Polymarket 真实市场；`.env` 必须是 `POLYPULSE_LIVE_WALLET_MODE=simulated`。

```bash
# 0. 检查 provider 配置；如果使用 Claude Code，把 expect 改成 claude-code。
npm run agent:check -- --env-file .env --expect codex

# 1. 检查 live env。
node ./bin/polypulse.js env check --mode live --env-file .env

# 2. 抓取当前 Polymarket 真实市场话题；从 topics[] 复制 marketId 或 marketSlug。
node ./bin/polypulse.js market topics --env-file .env --limit 20

# 3. 对真实市场做推荐不下单预测。
node ./bin/polypulse.js predict --env-file .env --market <market-id-or-slug>

# 4. 走 live simulated 一次性验收；不连接真实钱包、不提交真实订单。
node ./bin/polypulse.js trade once --mode live --env-file .env --market <market-id-or-slug> --max-amount 1 --confirm LIVE

# 5. 查看最近 artifact。
find runtime-artifacts -type f | sort | tail -n 30
```

Codex 提示词版本：

```text
0. 请检查 .env 是否启用了 Codex provider；如果我指定 Claude Code，就改为检查 claude-code provider。
1. 请检查 live env，并确认当前是 live simulated、读取真实 Polymarket 市场、不连接真实钱包。
2. 请用 .env 抓取 20 个当前 Polymarket 真实市场 topic，并告诉我可用于后续测试的 marketId 或 marketSlug。
3. 请对选出的真实市场运行 predict，记录实际 provider，输出 action=predict-only，并汇总概率、隐含概率、edge、net_edge、entry_fee_pct、quarter_kelly_pct、monthly_return 和 artifact 路径。
4. 请用同一个真实市场运行 live simulated trade once，max-amount=1，confirm LIVE，确认不会连接真实钱包或提交真实订单，并汇总 DecisionEngine、RiskEngine、broker 和 artifact 结果。
5. 请列出 runtime-artifacts 下最近 30 个文件，并按 markets、predictions、runs、runtime log 分类说明哪些是本次真实市场测试产生的。
```

### Live Real 验收

以下命令会连接真实钱包，并可能在风控允许后提交真实订单。执行前必须确认 `.env` 是 `POLYPULSE_LIVE_WALLET_MODE=real`，并且你接受真实资金风险。

```bash
# 0. 检查 provider 配置；如果使用 Claude Code，把 expect 改成 claude-code。
npm run agent:check -- --env-file .env --expect codex

# 1. 检查 live real env。
node ./bin/polypulse.js env check --mode live --env-file .env

# 2. 查询真实 Polymarket CLOB collateral balance。
node ./bin/polypulse.js account balance --mode live --env-file .env

# 3. 抓取当前 Polymarket 真实市场话题。
node ./bin/polypulse.js market topics --env-file .env --limit 20

# 4. 对真实市场做推荐不下单预测。
node ./bin/polypulse.js predict --env-file .env --market <market-id-or-slug>

# 5. 真实 live 一次性小额下单验收；会在风控允许后提交真实订单。
node ./bin/polypulse.js trade once --mode live --env-file .env --market <market-id-or-slug> --max-amount 1 --confirm LIVE
```

Codex 提示词版本：

```text
0. 请检查 .env 是否启用了 Codex provider；如果我指定 Claude Code，就改为检查 claude-code provider。
1. 请检查 live real env，尤其是 PRIVATE_KEY、FUNDER_ADDRESS、SIGNATURE_TYPE、CHAIN_ID 和 POLYMARKET_HOST。
2. 请查询真实 Polymarket CLOB collateral balance；如果不是 live real wallet，请停止并说明原因。
3. 请抓取 20 个当前 Polymarket 真实市场 topic，并挑选适合小额验收的 marketId 或 marketSlug。
4. 请对选出的真实市场运行 predict，汇总 evidence、概率估算、隐含概率、edge、net_edge、quarter_kelly_pct、monthly_return 和 artifact 路径。
5. 请只在我明确确认接受真实资金风险后，运行真实 live once 小额验收；如果缺少确认或前置检查失败，请停止并说明原因。
```

### Live Simulated Monitor

`.env` 必须是 `POLYPULSE_LIVE_WALLET_MODE=simulated`。该模式持续读取当前 Polymarket 真实市场，走 live preflight、RiskEngine、artifact 和 broker 接口，但不提交真实订单。

```bash
node ./bin/polypulse.js monitor run --mode live --env-file .env --confirm LIVE --loop
```

Codex 提示词版本：

```text
1. 请在 .env 使用 live simulated wallet 时启动 monitor，确认它读取当前 Polymarket 真实市场，走 live preflight、RiskEngine、artifact 和 broker 接口，但不连接真实钱包或提交真实订单。
```

### Live Real Monitor

`.env` 必须是 `POLYPULSE_LIVE_WALLET_MODE=real`，并配置真实钱包。该模式持续读取当前 Polymarket 真实市场，并可能在风控允许后提交真实订单。

```bash
node ./bin/polypulse.js monitor run --mode live --env-file .env --confirm LIVE --loop
```

Codex 提示词版本：

```text
1. 请只在我明确确认真实钱包和真实交易风险后启动 live real monitor；启动前检查 live env、真实余额和 confirm LIVE，启动后汇总服务状态、风控状态、artifact 和日志位置。
```

### 停止和恢复 Monitor

```bash
# 写入 monitor stop 状态，用于暂停持续运行。
node ./bin/polypulse.js monitor stop --env-file .env --reason manual_stop

# 清除 stop 状态，允许 monitor 再次运行。
node ./bin/polypulse.js monitor resume --env-file .env

# 恢复后重新启动 live monitor。
node ./bin/polypulse.js monitor run --mode live --env-file .env --confirm LIVE --loop
```

Codex 提示词版本：

```text
1. 请写入 monitor stop 状态，reason=manual_stop，用于暂停持续运行。
2. 请清除 monitor stop 状态，让 monitor 允许再次运行。
3. 请在恢复后重新启动 live monitor，并确认读取当前 Polymarket 真实市场。
```

### 查看 Monitor 和风险状态

```bash
# 查看 monitor 状态、最近运行和最近错误。
node ./bin/polypulse.js monitor status --env-file .env

# 查看系统级风控状态。
node ./bin/polypulse.js risk status --env-file .env
```

Codex 提示词版本：

```text
1. 请查看 monitor 状态，汇总最近运行、最近错误、暂停状态和 stop/resume 状态。
2. 请查看系统级风控状态，说明当前是否允许继续运行以及阻断原因。
```

### 同步项目到服务器

在 macOS 本机把当前项目文件复制到 `/home/PolyPulse`，同时排除本地 secret、运行产物、依赖目录和 git 元数据。

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

Codex 提示词版本：

```text
1. 请在我的 macOS 本机把当前 PolyPulse 项目同步到 root@43.165.166.171:/home/PolyPulse/，同步时排除 .git、.env、.env.*、runtime-artifacts 和 node_modules，并汇总传输结果。
```

### 服务器安装

```bash
ssh root@43.165.166.171
cd /home/PolyPulse
chmod +x deploy/scripts/*.sh
deploy/scripts/install.sh
```

Codex 提示词版本：

```text
1. 请登录 root@43.165.166.171 这台 Ubuntu 服务器，后续命令都在服务器上执行。
2. 请进入服务器上的 /home/PolyPulse 项目目录，并确认当前目录正确。
3. 请确保 deploy/scripts/*.sh 都有可执行权限。
4. 请运行部署安装脚本，安装 systemd unit、运行目录和日志轮转；安装结束后继续执行当前 Polymarket 真实市场验收。
```

### 检查配置后启动服务

`install.sh` 会创建 `/home/PolyPulse/.env`；启动前必须编辑为 `live simulated` 或 `live real`，并强制权限为 `600`。

```bash
cd /home/PolyPulse
vim /home/PolyPulse/.env
chmod 600 /home/PolyPulse/.env
deploy/scripts/start.sh
deploy/scripts/status.sh
deploy/scripts/healthcheck.sh
```

Codex 提示词版本：

```text
1. 请进入服务器上的 /home/PolyPulse 项目目录，并确认当前目录正确。
2. 请帮助我编辑 /home/PolyPulse/.env；不要在输出中展示真实 secret，必须配置为 live simulated 或 live real，并确认读取当前 Polymarket 真实市场。
3. 请把 /home/PolyPulse/.env 权限强制设置为 600，并确认权限结果。
4. 请启动 systemd monitor 服务，并说明启动命令是否成功。
5. 请查看服务和 PolyPulse monitor 状态，汇总 active 状态、最近运行和最近错误。
6. 请执行部署健康检查，汇总通过项、失败项和需要处理的配置问题。
```

### 部署后验证

```bash
cd /home/PolyPulse
systemctl is-active polypulse-monitor.service
deploy/scripts/status.sh
deploy/scripts/healthcheck.sh
journalctl -u polypulse-monitor.service -n 100 --no-pager
tail -n 100 /home/PolyPulse/logs/polypulse-monitor.log
node ./bin/polypulse.js market topics --env-file .env --limit 20
```

Codex 提示词版本：

```text
1. 请进入服务器上的 /home/PolyPulse 项目目录，并确认当前目录正确。
2. 请确认 polypulse-monitor.service 是否处于 active 状态。
3. 请查看 PolyPulse 聚合状态，汇总服务、monitor 和风险状态。
4. 请再跑一次部署健康检查，确认部署后状态仍然通过。
5. 请查看 polypulse-monitor.service 最近 100 行 systemd journal，并提取错误、警告和关键启动信息。
6. 请查看 /home/PolyPulse/logs/polypulse-monitor.log 最近 100 行，并提取错误、警告和最近交易/monitor 事件。
7. 请用服务器 .env 抓取 20 个当前 Polymarket 真实市场 topic，确认部署后仍读取真实市场。
```

## TODO

对比 `predict-raven` 的 orchestrator + executor 闭环后，PolyPulse `monitor run --loop` 主链仍缺以下能力。优先级按「能否形成开仓-持仓-平仓闭环」排列。

### P0 平仓回路（当前完全缺失）

- [ ] 让 `DecisionEngine.decide` 不再硬编码 `side: "BUY"`，支持基于持仓的 `SELL` 决策。位置：`src/core/decision-engine.js:213`。
- [ ] 在 `LiveBroker.submit` / `LivePolymarketClient.postMarketOrder` 中补 `SELL` 分支：现在余额校验只看 BUY (`src/brokers/live-broker.js:84`)，`postMarketOrder` 也未覆盖卖出 size 推导（参考 predict-raven `services/executor/src/lib/polymarket.ts` + `inferPaperSellAmount`）。
- [ ] 新增 PositionReview 模块，对 `portfolio.positions` 逐仓产出 `hold / reduce / close`，参考 `predict-raven/services/orchestrator/src/review/position-review.ts` 的 5 类规则：
  - 触及 `stop_loss_pct` → close
  - Pulse 反向 → close
  - Pulse 同向但 net edge ≤ -0.05 → close；< 0 → reduce 50%；< 0.05 → hold + humanReviewFlag
  - 无 pulse 且接近 stop → reduce 50%
  - 默认 → hold + humanReviewFlag
- [ ] 在 `Scheduler.runMonitorRound` 中把 PositionReview 的 SELL 决策与新开仓候选合并后再交给 `OrderExecutor`，参考 predict-raven 的 `composePulseDirectDecisions`。

### P0 持仓与账户同步（当前不存在）

- [ ] 新增 portfolio sync 任务：从 Polymarket 拉真实 positions、用 CLOB book 重算 `currentPrice / currentValueUsd / unrealized_pnl_pct`，写回 `portfolio.positions`。`live-broker.sync()` 当前永远返回 `positions: []`（`src/brokers/live-broker.js:112`）。
- [ ] 在 sync 路径里触发 `shouldTriggerStopLoss` 自动 SELL，参考 `predict-raven/services/executor/src/workers/queue-worker.ts:120`。
- [ ] 把 sync 结果喂给 `RiskEngine.highWaterMark / drawdownPct`，让 `drawdownHaltPct` 能真正基于 mark-to-market 触发，而不仅靠 live collateral 余额。
- [ ] 决定 sync 节奏：要么让 monitor loop 每轮先跑 sync 再跑 scan（单进程方案），要么独立一个 systemd timer / 第二条 loop（接近 predict-raven 的 `setInterval(SYNC_INTERVAL_SECONDS=30s)`）。

### P1 结算追踪

- [ ] 新增 resolution sweep：对每个 open position 抓 Polymarket 事件描述、提取外部仲裁 URL、做 SHA-256 内容差分，参考 `predict-raven/services/orchestrator/src/jobs/resolution.ts`（含 `evaluateTrackability` 的 `完全/部分/手动/不可` 分级）。
- [ ] PolyPulse 的 `ResolutionEvidenceAdapter`（`src/adapters/evidence-crawler.js:119`）目前只把 `market.resolutionRules` 字符串塞给 LLM，未做外部源抓取与变更检测，应升级为带快照与 diff 的版本。

### P1 真实证据采集

- [ ] `EvidenceCrawler` 当前两个 adapter 都只复述市场字段，没有真实网页/新闻/赛事数据爬取。考虑接入 predict-raven vendored `polymarket-market-pulse` 报告或独立 web scraper，至少给 `MIN_EVIDENCE_ITEMS` 提供有信息量的来源。
- [ ] 在 evidence 不足时让 `RiskEngine` 的 `insufficient_evidence` 不仅仅是 warning（pulse-direct 默认 `requireEvidenceGuard=false`）。

### P2 可靠性 / 可观测性

- [ ] crash recovery 当前仅在 `inFlightRun` 上记一条 `recovered_after_crash`（`src/state/file-state-store.js:301`），没有做 in-flight 订单对账。补一条「上轮已 submit 但未确认的订单」回放或核对逻辑。
- [ ] 文件状态单点：`runtime-artifacts/state/live-state.json` 同时承载 portfolio / risk / monitor / orders / runs，长期跑容易膨胀。考虑分文件、轮转 `runHistory`，或迁移到嵌入式 KV (sqlite/leveldb)。
- [ ] `flatten` / `cancelOpenOrders` 入口缺失：predict-raven 提供了 `flattenPortfolio` 和 `cancelOpenOrders` 队列任务用于一键全清，PolyPulse 应至少提供 CLI 子命令（即便 v1 是 FOK，也方便手工兜底）。

### P2 决策策略增强

- [ ] PolyPulse 现在只有「pulse-direct」一种决策路径。若要保持与 predict-raven 同步，可补一条 `provider-runtime` 路径让 codex / claude-code agent 直接产出 `TradeDecisionSet`（受同样的 `applyTradeGuards` 裁剪）。

每条 TODO 完成后请同步更新 `docs/KNOWN_LIMITATIONS.md` 与 `docs/ROADMAP.md`，并补对应的 live simulated 验收命令。

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
