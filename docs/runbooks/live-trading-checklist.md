# PolyPulse Live Trading Checklist

live 模式有真实资金风险。未完成本清单前，不要启动 live monitor。

## 1. 代码与测试

- 本地 `npm test` 通过。
- 本地 `npm run smoke` 通过。
- `git diff --check` 通过。
- secret scan 没有发现非空 secret：

```bash
rg -n "(PRIVATE_KEY|API_KEY|SECRET|TOKEN|COOKIE|SESSION)[[:space:]]*[:=]" . --glob '!runtime-artifacts/**' --glob '!node_modules/**' --glob '!.git/**'
```

## 2. 服务器文件

- 代码位于 `/home/PolyPulse`。
- `/home/PolyPulse/.env` 只存在于服务器。
- `.env` 权限为 `600`：

```bash
stat -c "%a %n" /home/PolyPulse/.env
chmod 600 /home/PolyPulse/.env
```

- `STATE_DIR` 和 `ARTIFACT_DIR` 指向服务器本地目录：

```dotenv
STATE_DIR=/home/PolyPulse/runtime-artifacts/state
ARTIFACT_DIR=/home/PolyPulse/runtime-artifacts
```

## 3. Live Env

必须显式设置：

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

钱包模式选择：

- `POLYPULSE_LIVE_WALLET_MODE=simulated`：只演练 live 命令、preflight、RiskEngine、artifact 与 broker 接口，不连接真实钱包、不发真实订单。
- `POLYPULSE_LIVE_WALLET_MODE=real`：连接真实 Polymarket 钱包，必须配置 server-only secret。

模拟 live 钱包配置：

```dotenv
POLYPULSE_LIVE_WALLET_MODE=simulated
SIMULATED_WALLET_ADDRESS=
SIMULATED_WALLET_BALANCE_USD=100
```

不得把 `PRIVATE_KEY`、助记词、API key、cookie 或 session token 写入：

- git
- docs
- memory
- runtime artifact
- shell history
- issue / PR / chat

## 4. 风控参数

上线前确认：

```dotenv
MAX_TRADE_PCT=0.05
MAX_TOTAL_EXPOSURE_PCT=0.5
MAX_EVENT_EXPOSURE_PCT=0.2
MAX_POSITION_COUNT=20
MIN_TRADE_USD=1
MONITOR_MAX_TRADES_PER_ROUND=2
MONITOR_MAX_DAILY_TRADE_USD=20
MONITOR_CONCURRENCY=2
```

低配 VPS 建议先降低：

```dotenv
MARKET_SCAN_LIMIT=200
MONITOR_INTERVAL_SECONDS=300
MONITOR_CONCURRENCY=1
MONITOR_MAX_TRADES_PER_ROUND=1
MONITOR_MAX_DAILY_TRADE_USD=5
```

## 5. Preflight

运行：

```bash
cd /home/PolyPulse
deploy/scripts/healthcheck.sh --preflight
node ./bin/polypulse.js env check --mode live --env-file /home/PolyPulse/.env
node ./bin/polypulse.js account balance --mode live --env-file /home/PolyPulse/.env
```

检查输出：

- env file path 正确。
- chain id 是 `137`。
- funder address 只脱敏显示。
- private key 没有打印。
- collateral balance 合理。

## 6. Recommend / Paper 最后一轮

在 live 前先跑 paper monitor：

```bash
cd /home/PolyPulse
POLYPULSE_EXECUTION_MODE=paper node ./bin/polypulse.js monitor run --mode paper --env-file /home/PolyPulse/.env --rounds 1 --limit 20
```

检查最近 artifact：

```bash
find /home/PolyPulse/runtime-artifacts/monitor -type f | sort | tail -n 30
```

确认：

- 市场 question 正常。
- evidence 数量足够。
- no-trade reason 可解释。
- risk blocked reason 合理。
- 没有重复下单迹象。

## 7. Live 启动

只有完成以上检查后才启动：

```bash
cd /home/PolyPulse
deploy/scripts/start.sh --wallet real --confirm LIVE
```

模拟 live 钱包演练启动：

```bash
deploy/scripts/start.sh --wallet simulated --confirm LIVE
```

启动后立即验证：

```bash
systemctl is-active polypulse-monitor.service
deploy/scripts/status.sh
tail -n 100 /home/PolyPulse/logs/polypulse-monitor.log
find /home/PolyPulse/runtime-artifacts/monitor -type f | sort | tail -n 30
```

## 8. 停止与恢复

停止 monitor：

```bash
cd /home/PolyPulse
deploy/scripts/stop.sh
```

恢复 monitor 状态：

```bash
node ./bin/polypulse.js monitor resume --env-file /home/PolyPulse/.env
deploy/scripts/start.sh --confirm LIVE
```

如果 RiskEngine halted：

```bash
node ./bin/polypulse.js risk status --env-file /home/PolyPulse/.env
```

确认 halted 原因后才允许：

```bash
node ./bin/polypulse.js risk resume --env-file /home/PolyPulse/.env
deploy/scripts/start.sh --confirm LIVE
```

## 9. 事故处理

如果发现异常：

```bash
cd /home/PolyPulse
deploy/scripts/stop.sh
node ./bin/polypulse.js risk halt --reason manual_incident --env-file /home/PolyPulse/.env
```

归档排查材料：

```bash
systemctl --no-pager --full status polypulse-monitor.service
journalctl -u polypulse-monitor.service -n 500 --no-pager
tail -n 500 /home/PolyPulse/logs/polypulse-monitor.log
find /home/PolyPulse/runtime-artifacts -type f | sort | tail -n 100
```

不要把 secret 内容复制进事故报告。
