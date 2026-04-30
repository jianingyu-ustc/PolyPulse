# PolyPulse 轻量级服务器部署

本目录提供 systemd 部署方案。目标服务器登陆方式：

```bash
ssh root@43.165.166.171
```

本阶段只写脚本，不执行部署。

## 目录约定

服务器上所有部署文件放在：

```text
/home/PolyPulse
```

运行时文件默认放在：

```text
/home/PolyPulse/runtime-artifacts
/home/PolyPulse/runtime-artifacts/state
/home/PolyPulse/logs
```

真实 env 文件为：

```text
/home/PolyPulse/.env
```

`.env` 必须只保存在服务器本地，权限必须是 `600`，不能提交到 git。

## 文件说明

- `deploy/env.example`：服务器 `.env` 模板，默认 paper。
- `deploy/systemd/polypulse-monitor.service`：systemd 常驻 monitor 服务。
- `deploy/scripts/install.sh`：安装 systemd unit、创建目录、配置日志轮转、执行 paper smoke。
- `deploy/scripts/start.sh`：启动 monitor 服务。
- `deploy/scripts/stop.sh`：停止 monitor 服务并写入 monitor stop 状态。
- `deploy/scripts/status.sh`：查看 systemd、monitor state 和最近日志。
- `deploy/scripts/healthcheck.sh`：检查 Node、env 权限、preflight、paper smoke。

## 初次安装

在本机把仓库同步到服务器：

```bash
rsync -az --delete \
  --exclude '.git' \
  --exclude '.env' \
  --exclude 'runtime-artifacts' \
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
nano /home/PolyPulse/.env
chmod 600 /home/PolyPulse/.env
deploy/scripts/start.sh
```

## Paper Monitor 常驻

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

## Live Monitor 常驻

live 启动需要两层确认。

`.env` 必须显式设置：

```dotenv
POLYPULSE_EXECUTION_MODE=live
POLYPULSE_LIVE_CONFIRM=LIVE
PRIVATE_KEY=<server-only-secret>
FUNDER_ADDRESS=<proxy-or-funder-address>
SIGNATURE_TYPE=<polymarket-signature-type>
CHAIN_ID=137
POLYMARKET_HOST=https://clob.polymarket.com
```

权限必须收紧：

```bash
chmod 600 /home/PolyPulse/.env
```

启动时仍必须传入确认：

```bash
cd /home/PolyPulse
deploy/scripts/start.sh --confirm LIVE
```

没有 `POLYPULSE_LIVE_CONFIRM=LIVE` 或没有 `--confirm LIVE` 时，脚本和 systemd service 都会拒绝 live monitor。

## 常用命令

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

## 日志轮转

服务日志写入：

```text
/home/PolyPulse/logs/polypulse-monitor.log
/home/PolyPulse/logs/polypulse-monitor.err.log
```

`install.sh` 会安装 `/etc/logrotate.d/polypulse-monitor`，默认保留 14 天压缩日志。

## 部署后验证

```bash
systemctl is-active polypulse-monitor.service
deploy/scripts/status.sh
deploy/scripts/healthcheck.sh
journalctl -u polypulse-monitor.service -n 100 --no-pager
tail -n 100 /home/PolyPulse/logs/polypulse-monitor.log
```
