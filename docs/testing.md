# PolyPulse Testing

最后更新：2026-04-30

## 一键命令

本地与 CI 使用同一入口：

```bash
npm test
```

原始 Node test runner：

```bash
npm run test:node
```

CLI smoke：

```bash
npm run smoke
```

`npm run smoke` 会执行 env/account/market/predict/paper once/monitor 的 CLI smoke，并把每条命令的 stdout/stderr 写入：

```text
runtime-artifacts/test-runs/<timestamp>-smoke/
```

手动安全检查：

```bash
git diff --check
rg -n "(PRIVATE_KEY|API_KEY|SECRET|TOKEN|COOKIE|SESSION)[[:space:]]*[:=]" . --glob '!runtime-artifacts/**' --glob '!node_modules/**' --glob '!.git/**'
```

`npm test` 会通过 `scripts/run-tests.js` 调用 `node --test`。失败时详情写入：

```text
runtime-artifacts/test-runs/<timestamp>/
  command.txt
  stdout.log
  stderr.log
  summary.json
```

## 覆盖矩阵

| 范围 | 测试文件 | 重点 |
| --- | --- | --- |
| 环境配置与 secret redaction | `test/env-security.test.js`, `test/broker-account.test.js` | `.env.example` 完整性、live preflight fail-fast、private key 不进入 stdout/artifact/memory |
| Polymarket 账户余额 | `test/broker-account.test.js` | mock client success、API failure、chain/address 错误、balance artifact |
| 市场话题抓取 | `test/market-source.test.js` | pagination、filter、cache、stale cache 标记、低流动性过滤 |
| 胜率预测与决策 | `test/analysis.test.js` | mock evidence、fake AI response、schema、证据不足、低 confidence no-trade |
| Paper once | `test/once-runner.test.js`, `test/broker-account.test.js` | buy、sell/reduce、余额不足、持仓更新、artifact 完整性 |
| Live once | `test/once-runner.test.js`, `test/broker-account.test.js` | 默认拒绝、缺 confirm、mock live success、risk 拒绝后不调用 broker |
| Paper monitor | `test/monitor.test.js` | 单轮、多轮、去重、crash recovery、stop/resume |
| Live monitor | `test/monitor.test.js` | 默认拒绝、缺 confirm、mock live success、halted 禁止 open |
| RiskEngine | `test/risk-engine.test.js` | 单笔/总敞口/单事件上限、最大持仓数、最小交易额、stale market、token mismatch、AI 越权 token |
| 性能/稳定性 | `test/performance-stability.test.js`, `test/monitor.test.js` | 大量市场 mock scan、并发限流、timeout、retry、artifact cleanup |
| CLI smoke | `test/smoke.test.js`, `npm run smoke` | env/account/market/predict/paper once/live blocked/monitor |

## Live 测试边界

自动测试不真实下单。所有 live 测试使用 mock client 或验证 fail-closed 行为：

- 无 `--confirm LIVE` 必须拒绝。
- env/preflight/balance 任一失败必须拒绝。
- RiskEngine 拒绝后 broker submit 不允许被调用。
- halted 状态禁止 open。

真实 live 路径只能在显式人工确认、专用 env、极小金额和独立审计后运行。
