---
name: polypulse-market-agent
description: "在 PolyPulse 仓库中安全运行或设计 Polymarket 预测市场自主交易 Agent。用于扫描当前 Polymarket 市场、收集证据、调用 AI 估算概率、生成 live simulated 或 live real 交易决策、查询余额、下单、持久监控或 live 前置检查。"
---

# PolyPulse Market Agent

PolyPulse 当前只保留两条路径：

- `live simulated`：读取当前 Polymarket 真实市场，走 live preflight、RiskEngine、artifact 和 broker 接口，但不连接真实钱包、不提交真实订单。
- `live real`：读取当前 Polymarket 真实市场，连接真实钱包，并在风控允许后提交真实订单。

## 什么时候触发

使用本 skill，当用户要求：

- 扫描 Polymarket 当前市场、筛选候选市场或解释某个 market。
- 收集新闻、规则、评论、外部数据等证据。
- 调用 Codex 或 Claude Code 估算 Yes/No 概率、edge、Kelly 或期望收益。
- 查询 live simulated 或 live real 钱包余额、持仓、订单簿或市场流动性。
- 执行一次性 live simulated / live real 验收。
- 持久监控市场并在条件满足时执行 live simulated / live real 路径。
- 排查 PolyPulse 运行失败、恢复 checkpoint 或整理归档。

## 默认安全模式

- 默认读取当前 Polymarket 真实市场。
- 默认不打印真实 env 值、私钥、session token 或 cookie。
- `live simulated` 可以用于演练，但仍必须使用 `--mode live --confirm LIVE`。
- `live real` 会触发真实资金路径；除非用户在本次会话明确确认真实资金风险，否则不要启动真实下单或真实 monitor。
- 失败时要 fail-closed：不绕过风控，不为了满足最小下单额而放大仓位。

## 命令约定

以下命令是当前 PolyPulse CLI 的 live-only 入口。

### Live Preflight

```bash
node ./bin/polypulse.js env check --mode live --env-file .env
```

### Market Topics

```bash
node ./bin/polypulse.js market topics --env-file .env --limit 20 --quick
```

输出中从 `topics[].marketId` 或 `topics[].marketSlug` 复制后续测试用市场标识。

### Account Balance

```bash
node ./bin/polypulse.js account balance --mode live --env-file .env
node ./bin/polypulse.js account audit --mode live --env-file .env
```

`account audit` 必须核对 collateral allowance、已有仓位、远端成交、本地撤单/拒单记录、已平仓胜率、净收益率和最大回撤；如果返回 blocking reasons，停止真实下单。

只有用户明确确认真实授权风险时，才可以运行：

```bash
node ./bin/polypulse.js account approve --mode live --env-file .env --confirm APPROVE
```

### Single-Market Prediction

```bash
node ./bin/polypulse.js predict --env-file .env --market <market-id-or-slug>
```

预测必须输出：

- market implied probability
- AI probability
- edge / net edge
- entry fee pct
- quarter Kelly pct
- monthly return
- confidence
- artifact path

### Live Simulated Once

要求 `.env`：

```bash
POLYPULSE_EXECUTION_MODE=live
POLYPULSE_LIVE_WALLET_MODE=simulated
POLYPULSE_MARKET_SOURCE=polymarket
POLYMARKET_GAMMA_HOST=https://gamma-api.polymarket.com
```

命令：

```bash
node ./bin/polypulse.js trade once --mode live --env-file .env --market <market-id-or-slug> --max-amount 1 --confirm LIVE
```

### Live Real Once

要求 `.env`：

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

命令：

```bash
node ./bin/polypulse.js trade once --mode live --env-file .env --market <market-id-or-slug> --max-amount 1 --confirm LIVE
```

### Live Monitor

```bash
node ./bin/polypulse.js monitor run --mode live --env-file .env --confirm LIVE --loop
```

## 运行结束应汇报哪些路径

每次运行结束，至少汇报：

- `runId`
- artifact directory
- preflight report
- market scan artifact
- evidence report
- prediction report
- risk report
- execution summary
- runtime log
- error artifact，如果失败

建议目录结构：

```text
runtime-artifacts/
  markets/
  evidence/
  predictions/
  runs/
  monitor/
  account/
  state/live-state.json
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
