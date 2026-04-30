# PolyPulse Roadmap

最后更新：2026-04-30

## P0 - Live 前必须完成

- 接入真实 Polymarket SDK / CLOB client，并用专用测试钱包验证：
  - preflight
  - collateral balance
  - allowance
  - order submit
  - order status query
  - cancellation / rejection
- live confirmation 绑定 run id、env fingerprint、market、token、side、amount。
- live submit 后 crash recovery：有 broker order id 时先查状态，禁止重复提交。
- 增加 production allowlist：market category、max amount、daily cap、watchlist、blocklist。
- 建立真实 live 试运行流程：极小金额、人工观察、逐步放量。

## P1 - 证据与 AI

- 接入外部 EvidenceCrawler adapters：
  - 官方网站
  - 新闻搜索
  - 公开数据 API
  - resolution source 抓取
  - social / announcement source
- 接入真实 AI provider 或 `AI_COMMAND` subprocess。
- 对 AI 输出做更严格 schema validation：
  - evidence id 引用必须存在
  - 概率范围与多 outcome 概率口径
  - 禁止无证据编造
- 为每次估算记录 provider、model、latency、cost、fallback reason。

## P2 - 市场与风控增强

- 完整 order book depth pricing 和 slippage 模拟。
- 多 outcome / neg-risk 风险模型。
- reduce / close / rebalance 工作流。
- 更细粒度 dedupe：market + outcome + side + strategy window。
- 风控扩展：
  - daily loss
  - realized/unrealized PnL
  - correlated event exposure
  - event resolution proximity
  - market manipulation / thin book flags

## P3 - 运维与可观测性

- HTTP health server：
  - `/health`
  - `/runs/:id`
  - `/artifacts`
  - `/trigger`
- Notifier / Reporter：
  - email
  - Telegram
  - Slack / Discord webhook
- Artifact index 与压缩归档。
- Dashboard 或 TUI，查看 monitor status、positions、risk blocks、recent decisions。

## P4 - 部署与扩展

- Dockerfile 与 docker-compose。
- 可选 SQLite StateStore。
- 可选 Postgres/Redis backend。
- 多策略隔离与多账户配置。
- 云端定时备份 runtime artifacts 与 state。
