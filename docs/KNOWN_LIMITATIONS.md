# PolyPulse 已知限制

最后更新：2026-04-30

## 交易与 live 路径

- 真实 Polymarket live 下单未执行过；当前 live 自动测试只覆盖 mock client 和 fail-closed。
- `LivePolymarketClient` 是可接 SDK 的适配层，生产前需要用专用测试钱包验证余额、allowance、订单提交、订单状态查询和错误格式。
- live 确认当前是 `--confirm LIVE` 与部署层 `POLYPULSE_LIVE_CONFIRM=LIVE`，尚未绑定 run id、env fingerprint、market、side、amount。
- CLI 尚未提供完整 reduce/close 工作流；PaperBroker 支持 sell，但用户级命令仍偏向 open/buy。

## AI 与证据

- 默认 ProbabilityEstimator 是本地启发式 provider，不是真实 LLM。
- EvidenceCrawler 已有适配器接口、cache、timeout、retry、dedupe，但默认证据主要来自 market metadata 与 resolution rules。
- 外部网页、新闻、官方数据源、社交信号和 AI 搜索适配器尚未接入。
- AI 推理目前是摘要级 artifact，没有接入模型调用审计、prompt token 成本或 provider 级重试策略。

## 市场与执行口径

- market probability 使用 best ask / implied probability 等简化口径，尚未做完整 order book depth weighted fill。
- 多 outcome、neg-risk、跨市场组合风险仍为简化处理。
- 流动性 cap 基于 market liquidity pct，不等同真实可成交深度。

## 状态与并发

- StateStore 是轻量 JSON 文件实现，适合单机单服务；多进程并发写入不作为当前 MVP 目标。
- monitor crash recovery 可恢复 in-flight run state，但 live submit 后按 broker order id 查询并幂等恢复仍需真实 broker 支持。
- monitor 去重以 market/event key 和 portfolio position 为主，尚未实现策略窗口、outcome/side 级更细粒度 dedupe。

## 部署

- 部署脚本已写好但未在 `43.165.166.171` 上执行。
- systemd 是当前唯一部署方案；未提供 Dockerfile。
- healthcheck 是命令式脚本，不是 HTTP endpoint。
- logrotate 配置固定为 `/home/PolyPulse/logs/*.log`，如果改部署目录需要同步调整。

## 安全

- redaction 覆盖常见 secret key 名称和字符串模式，但不能替代人工 secret 管理。
- runtime artifacts 会记录缺失字段名，例如 `PRIVATE_KEY is required`，但不会记录 private key 值。
- 测试代码含 fake secret 字符串，用于验证不进入 stdout/artifact/memory；这些不是生产 secret。
