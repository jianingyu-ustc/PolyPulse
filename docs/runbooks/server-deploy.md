# PolyPulse 服务器部署 Runbook

本 runbook 面向轻量级 VPS。目标服务器：

```bash
ssh root@43.165.166.171
```

本阶段不要直接部署；只在需要上线时按以下步骤执行。

## 1. 本地准备

确认本地测试通过：

```bash
cd /Users/jianingyu/PolyPulse
npm test
npm run smoke
git diff --check
```

不要同步本地 `.env`、`runtime-artifacts` 或任何 secret。

## 2. 同步代码

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

## 3. 服务器安装

```bash
ssh root@43.165.166.171
cd /home/PolyPulse
chmod +x deploy/scripts/*.sh
deploy/scripts/install.sh
```

安装脚本会：

- 检查 Node.js 版本，要求 `>=20`。
- 创建 `/home/PolyPulse/.env`，默认 paper。
- 创建 runtime/state/log 目录。
- 安装 `polypulse-monitor.service`。
- 安装 logrotate 规则。
- 执行 paper smoke test。

如果服务器没有 Node.js 20+，先安装 Node.js，再重新执行安装脚本。

## 4. Paper 常驻启动

确认 `/home/PolyPulse/.env`：

```dotenv
POLYPULSE_EXECUTION_MODE=paper
STATE_DIR=/home/PolyPulse/runtime-artifacts/state
ARTIFACT_DIR=/home/PolyPulse/runtime-artifacts
```

权限检查：

```bash
chmod 600 /home/PolyPulse/.env
deploy/scripts/healthcheck.sh --preflight
```

启动：

```bash
deploy/scripts/start.sh
```

验证：

```bash
systemctl is-active polypulse-monitor.service
deploy/scripts/status.sh
tail -n 100 /home/PolyPulse/logs/polypulse-monitor.log
find /home/PolyPulse/runtime-artifacts/monitor -type f | sort | tail -n 20
```

## 5. Live 常驻启动

先完成 `docs/runbooks/live-trading-checklist.md`。

live `.env` 必须只在服务器编辑：

```bash
nano /home/PolyPulse/.env
chmod 600 /home/PolyPulse/.env
```

必须设置：

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

如果要在 live 部署流程中先使用模拟钱包演练，不接真实钱包、不发真实订单，设置：

```dotenv
POLYPULSE_EXECUTION_MODE=live
POLYPULSE_LIVE_CONFIRM=LIVE
POLYPULSE_LIVE_WALLET_MODE=simulated
SIMULATED_WALLET_ADDRESS=
SIMULATED_WALLET_BALANCE_USD=100
```

模拟钱包仍会走 live preflight、RiskEngine 和 live broker 接口，但 broker 使用 `simulated-live-wallet`，不会连接 Polymarket SDK。

启动：

```bash
deploy/scripts/healthcheck.sh --preflight
deploy/scripts/start.sh --wallet real --confirm LIVE
```

缺少 `POLYPULSE_LIVE_CONFIRM=LIVE` 或 `--confirm LIVE` 都会拒绝 live 服务启动。

## 6. 运维命令

手动跑一次预测：

```bash
cd /home/PolyPulse
node ./bin/polypulse.js predict --env-file /home/PolyPulse/.env --market <market-id-or-slug>
```

`<market-id-or-slug>` 的取值来自市场扫描结果：

```bash
node ./bin/polypulse.js market topics --env-file /home/PolyPulse/.env --limit 20
```

从返回的 `topics[]` 里复制 `marketId` 或 `marketSlug`；mock 源示例是 `market-001` 或 `fed-cut-before-july`。

手动查余额：

```bash
cd /home/PolyPulse
node ./bin/polypulse.js account balance --env-file /home/PolyPulse/.env
```

查看最近 artifact：

```bash
cd /home/PolyPulse
find runtime-artifacts -type f | sort | tail -n 50
```

停止 monitor：

```bash
cd /home/PolyPulse
deploy/scripts/stop.sh
```

恢复 monitor 状态：

```bash
cd /home/PolyPulse
node ./bin/polypulse.js monitor resume --env-file /home/PolyPulse/.env
deploy/scripts/start.sh
```

live 模式恢复启动：

```bash
deploy/scripts/start.sh --confirm LIVE
```

## 7. 故障排查

查看 systemd：

```bash
systemctl --no-pager --full status polypulse-monitor.service
journalctl -u polypulse-monitor.service -n 200 --no-pager
```

查看文件日志：

```bash
tail -n 200 /home/PolyPulse/logs/polypulse-monitor.log
tail -n 200 /home/PolyPulse/logs/polypulse-monitor.err.log
```

检查 env 权限：

```bash
stat -c "%a %n" /home/PolyPulse/.env
chmod 600 /home/PolyPulse/.env
```

检查运行状态：

```bash
cd /home/PolyPulse
node ./bin/polypulse.js monitor status --env-file /home/PolyPulse/.env
node ./bin/polypulse.js risk status --env-file /home/PolyPulse/.env
```

如果 live 进入 halted，必须人工确认原因后显式恢复：

```bash
node ./bin/polypulse.js risk resume --env-file /home/PolyPulse/.env
node ./bin/polypulse.js monitor resume --env-file /home/PolyPulse/.env
deploy/scripts/start.sh --confirm LIVE
```
