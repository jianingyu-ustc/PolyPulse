---
name: polypulse-market-agent
description: "在 PolyPulse 仓库中安全运行或设计预测市场自主交易 Agent。用于用户要求扫描 Polymarket、收集外部证据、估算胜率、生成交易建议、paper 交易、余额查询、下单、持久监控或 live 前置检查时。默认安全模式是 recommend-only / paper；没有显式 live 确认，不允许真实下单。"
---

# PolyPulse Market Agent

PolyPulse 的目标是构建一个预测市场自主交易 Agent：主动抓取 Polymarket 市场与外部证据，独立评估事件发生概率，再根据市场赔率、edge、流动性和风控规则决定是否交易。

## 什么时候触发

使用本 skill，当用户要求：

- 扫描 Polymarket 市场、筛选候选市场或解释某个 market。
- 收集新闻、规则、评论、外部数据等证据。
- 估算 Yes/No 概率、胜率、edge、Kelly 或期望收益。
- 生成交易建议、paper run、recommend-only run。
- 查询钱包、余额、持仓、订单簿或市场流动性。
- 一次性下单、dry-run 下单、live preflight。
- 持久监控市场并在条件满足时建议或执行交易。
- 排查 PolyPulse 运行失败、恢复 checkpoint 或整理归档。

## 默认安全模式

- 默认只允许 `recommend-only` 或 `paper`。
- 默认不读取真实私钥文件，不打印真实 env 值。
- 默认不运行 live 下单命令。
- 任何 live 路径必须先完成 `preflight`，再完成 `dry-run` 或 `recommend-only`，最后拿到用户明确 live 确认。
- 没有显式 live 确认时，只能输出建议、计划、风险报告和可执行验证命令。
- 失败时要 fail-closed：不降级为 mock 交易，不绕过风控，不为了满足最小下单额而放大仓位。

## 命令约定

以下命令是 PolyPulse 应保持的 CLI 意图。若仓库尚未实现对应命令，先记录缺口并创建设计/任务说明；不要编造真实执行结果。

### Paper 模式

生成 paper 推荐：

```bash
POLYPULSE_MODE=paper pnpm polypulse recommend --paper --archive
```

批准最近一次 paper 推荐：

```bash
POLYPULSE_MODE=paper pnpm polypulse approve --latest
```

重置 paper 状态：

```bash
POLYPULSE_MODE=paper pnpm polypulse reset-paper
```

### Live 模式

Live 前置检查：

```bash
POLYPULSE_MODE=live ENV_FILE=<dedicated-env-file> pnpm polypulse preflight
```

Live 只推荐不下单：

```bash
POLYPULSE_MODE=live ENV_FILE=<dedicated-env-file> pnpm polypulse recommend --recommend-only --archive
```

Live dry-run：

```bash
POLYPULSE_MODE=live ENV_FILE=<dedicated-env-file> pnpm polypulse trade --dry-run --archive
```

Live 真实下单必须带确认令牌或 run id：

```bash
POLYPULSE_MODE=live ENV_FILE=<dedicated-env-file> pnpm polypulse trade --execute --confirm-live <run-id>
```

## 市场扫描

推荐入口：

```bash
pnpm polypulse scan --source polymarket --max-candidates 20 --archive
```

常见过滤：

```bash
pnpm polypulse scan --category politics --min-liquidity 5000 --min-prob 0.15 --max-prob 0.85 --archive
pnpm polypulse scan --tag ai --min-liquidity 5000 --archive
```

扫描应至少保存：

- 原始市场数量与过滤后数量。
- 候选市场 JSON。
- 每个候选的 `market_slug`、`event_slug`、`clob_token_ids`、outcomes、prices、liquidity、volume、spread、end date。
- 风险标记：候选不足、过期、缺 token、流动性不足、订单簿不可用。

## 余额查询

推荐入口：

```bash
ENV_FILE=<dedicated-env-file> pnpm polypulse balance --archive
```

输出与归档应包含：

- 使用的 env 文件路径。
- 钱包地址的脱敏显示。
- collateral / pUSD / USDC 可用余额。
- open positions 数量。
- signer 与 funder 是否匹配；不匹配只能 warn，不要打印私钥。

## 胜率预测

单市场预测：

```bash
pnpm polypulse predict --market <market-slug> --archive
```

批量预测：

```bash
pnpm polypulse predict --from-scan <scan-json-path> --archive
```

预测必须输出：

- `market_prob`：市场赔率隐含概率。
- `ai_prob`：Agent 基于证据独立估计的概率。
- `edge = ai_prob - market_prob`。
- 置信度与证据缺口。
- 证据来源 URL、retrieved_at、摘要。
- 是否可交易：流动性、spread、费用、结算规则是否清楚。

如果证据不足，必须输出 no-trade / skip，而不是补写不存在的证据。

## 一次性下单

默认 dry-run：

```bash
POLYPULSE_MODE=paper pnpm polypulse trade-once --market <market-slug> --side YES --amount-usd 5 --dry-run --archive
```

Live 下单前置流程：

```bash
POLYPULSE_MODE=live ENV_FILE=<dedicated-env-file> pnpm polypulse preflight --market <market-slug>
POLYPULSE_MODE=live ENV_FILE=<dedicated-env-file> pnpm polypulse trade-once --market <market-slug> --side YES --amount-usd 5 --dry-run --archive
POLYPULSE_MODE=live ENV_FILE=<dedicated-env-file> pnpm polypulse trade-once --market <market-slug> --side YES --amount-usd 5 --execute --confirm-live <run-id>
```

下单前必须检查：

- token id 来自当前市场快照。
- order book 可用。
- 金额不超过 bankroll、单笔上限、总敞口上限、单事件上限。
- 不低于内部最小单和交易所最小单。
- slippage cap 通过。
- 不是 halted / paused 状态。

## 持久监控与下单

Recommend-only 监控：

```bash
pnpm polypulse monitor --recommend-only --interval 300 --archive
```

Paper 监控：

```bash
POLYPULSE_MODE=paper pnpm polypulse monitor --paper --interval 300 --archive
```

Live 监控必须显式启用，并且仍需每轮 preflight 与 dry-run：

```bash
POLYPULSE_MODE=live ENV_FILE=<dedicated-env-file> pnpm polypulse monitor --live --preflight-each-run --dry-run-first --archive
```

如果未来支持自动 live 执行，必须要求独立配置项，例如 `POLYPULSE_ALLOW_LIVE_EXECUTION=true`，并要求用户在本次会话明确确认。没有确认时只能保留 recommend-only。

## 运行结束应汇报哪些路径

每次运行结束，至少汇报：

- `runId`
- archive directory
- preflight report
- scan JSON / pulse JSON
- evidence report
- prediction report
- recommendation JSON
- risk report
- dry-run report 或 execution summary
- runtime log
- error artifact，如果失败

建议目录结构：

```text
runtime-artifacts/
  scans/YYYY/MM/DD/
  evidence/YYYY/MM/DD/
  predictions/YYYY/MM/DD/
  recommendations/YYYY/MM/DD/
  risk/YYYY/MM/DD/
  runs/<timestamp>-<runId>/
  checkpoints/
  local/paper-state.json
```

## 失败时应保存哪些诊断文件

失败时必须尽量保存：

- `error.json`：失败阶段、错误摘要、下一步命令。
- `preflight.json`：执行模式、env 文件路径、脱敏钱包、余额、关键检查。
- `input-context.json`：市场、持仓、余额、配置摘要，不含 secrets。
- `provider-prompt.txt`：如果调用了 AI provider。
- `provider-output.*`：如果 provider 有输出。
- `schema.json`：本轮期望输出结构。
- `risk-decision.json`：被风控拒绝或裁剪的原因。
- `run-summary.md`：面向人类复盘的摘要。

不要保存：

- 私钥、助记词、API key、cookie、session token。
- 完整 `.env` 文件内容。
- 未脱敏的钱包敏感凭据。

## 汇报格式

执行本项目阶段任务时，屏幕只输出短状态：

```text
[stage] <当前阶段> | [status] <ok/warn/fail> | [artifact] <关键文件路径>
```

长分析、设计权衡、源码阅读笔记、测试观察写入 `docs/memory/POLYPULSE_MEMORY.md`。
