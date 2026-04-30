# PolyPulse 测试计划

最后更新：2026-04-30

## 1. 测试目标

测试要证明 PolyPulse 在默认安全模式下可用，在 live 路径上 fail-closed，并且在大量市场、外部 API 波动、crash recovery 和高频轮询场景下不会重复误下单。

本阶段只写测试计划，不实现测试。

## 2. 测试分层

### 2.1 单元测试

覆盖纯逻辑：

- 市场隐含概率计算。
- edge / net edge 计算。
- fee 和 slippage 估算。
- 流动性过滤。
- Kelly 或 sizing 策略。
- RiskEngine 裁剪。
- dedupe key 生成。
- secret redaction。
- artifact retention policy。

### 2.2 契约测试

覆盖接口 schema：

- MarketSource 输出 MarketScanResult。
- EvidenceCrawler 输出 EvidenceBundle。
- ProbabilityEstimator 输出 ProbabilityEstimate。
- DecisionEngine 输出 TradeDecisionSet。
- RiskEngine 输出 RiskAdjustedPlan。
- Broker 输出 OrderResult。
- StateStore checkpoint 可序列化与可恢复。

### 2.3 集成测试

覆盖模块组合：

- scan -> evidence -> estimate -> decide -> risk -> artifact。
- paper once。
- paper monitor。
- live preflight failure。
- live dry-run。
- live confirmation mismatch。
- broker submit 后 crash recovery。

### 2.4 端到端测试

使用 mock MarketSource、mock EvidenceCrawler、mock ProbabilityEstimator、PaperBroker：

- 从大量 mock 市场中筛选候选。
- 对部分候选生成证据失败。
- 对有 edge 的市场生成 paper order。
- 重启后恢复 monitor 并确认不会重复下单。

Live E2E 只能使用 sandbox、专用测试钱包、极小金额和 allowlist；默认不在 CI 执行真实下单。

## 3. 功能测试矩阵

### 3.1 Polymarket 账户余额查询

用例：

- env 缺失 -> fail-fast。
- env 存在但 secret 不打印。
- broker 返回余额 -> 写 preflight artifact。
- broker timeout -> live blocked，paper 不受影响。

### 3.2 当前市场话题抓取

用例：

- 分页扫描 10,000 个 mock 市场。
- 过滤缺 token 市场。
- 过滤低流动性市场。
- 标记 stale snapshot。
- 高频轮询命中 cache，避免重复抓取。

性能断言：

- scan 支持 batch / cursor。
- 单页失败可重试。
- partial result 必须标记 incomplete。

### 3.3 AI 抓取外部证据

用例：

- 多 source 并发抓取。
- 单 source 429 后 backoff。
- 部分 source 失败进入 evidence gaps。
- 重复 URL 命中 cache。
- stale evidence 降低 confidence。

### 3.4 AI 估算胜率 / 发生概率

用例：

- schema 合法概率通过。
- 概率越界被拒绝。
- 缺 evidence 返回 no-estimate。
- 引用不存在 evidence id 被拒绝。
- 多 outcome 概率口径明确。

### 3.5 市场隐含概率与 edge 计算

用例：

- best ask 计算 BUY marketProbability。
- order book 缺失 -> unavailable。
- grossEdge 正确。
- fee/slippage 后 netEdge 正确。
- netEdge 低于阈值 -> skip。

### 3.6 流动性过滤

用例：

- liquidity 低于阈值 -> skip。
- spread 超阈值 -> skip 或 low confidence。
- slippage cap 裁剪 notional。
- 裁剪后低于最小单 -> skip。
- 不允许放大订单满足最小单。

### 3.7 Paper 模拟盘一次性下单

用例：

- 默认 paper broker。
- open 更新 cash、position、trade。
- reduce / close 更新 position。
- paper order 写 artifact。
- 风控失败不更新状态。

### 3.8 Live 实盘一次性下单

用例：

- 未确认 -> blocked。
- confirm run id 不匹配 -> blocked。
- env fingerprint 变化 -> blocked。
- preflight fail -> blocked。
- RiskEngine pass + confirmation pass -> 调用 LiveBroker mock submit。
- LiveBroker submit 后写 execution summary。

### 3.9 Paper 持久监控与自动下单

用例：

- monitor 周期扫描。
- 新市场产生 paper order。
- 同一市场重复轮询不重复下单。
- crash 后从 checkpoint 恢复。
- 恢复后继续 cursor。

### 3.10 Live 持久监控与自动下单

用例：

- 默认 recommend-only，不 submit。
- allowLiveExecution=false 时 blocked。
- allowLiveExecution=true 但无本轮确认 -> blocked。
- dedupe lock 已存在 -> blocked。
- broker order id 已存在且状态 unknown -> manual review。

### 3.11 交易决策归档

用例：

- 每个 run 写 scan/evidence/prediction/decision/risk/execution summary。
- no-trade 也写 reason。
- error path 写 error artifact。
- secret pattern redaction 生效。

### 3.12 可恢复运行状态

用例：

- crash before broker submit -> 可重新评估。
- crash after broker submit -> 查询 order id，不重复提交。
- checkpoint corruption -> fail-safe manual review。
- StateStore unavailable -> 不执行 live。

### 3.13 轻量级服务器部署

用例：

- health 返回 MarketSource、StateStore、ArtifactWriter 状态。
- trigger runOnce。
- 查询 run status。
- 查询 artifact index。
- scheduler heartbeat 超时告警。

## 4. 性能测试

### 4.1 大量市场扫描

目标：

- mock 10,000 到 50,000 个市场。
- 验证分页、过滤、候选截断和内存占用。
- 验证 scan 不把所有后续阶段串行阻塞。

指标：

- scan latency。
- per-page retry count。
- memory peak。
- candidate throughput。

### 4.2 并发与限流

目标：

- EvidenceCrawler 并发抓取不同 source。
- ProbabilityEstimator 并发估算候选。
- Broker submit 同账户串行。

断言：

- 全局并发上限生效。
- host-level rate limit 生效。
- timeout 后写 failure artifact。

### 4.3 高频轮询去重

目标：

- 每 30 秒轮询同一批市场。
- 未变化 market 不重复抓 evidence。
- 已下单 market 不重复下单。

指标：

- cache hit rate。
- duplicate prevented count。
- unnecessary fetch count。

### 4.4 Artifact 与 memory 膨胀

目标：

- 连续运行 1,000 个 mock runs。
- 验证 retention policy。
- 验证索引可查询，旧 artifact 可压缩或清理。

断言：

- runtime-artifacts 不无限增长。
- memory 不追加原始大对象。
- 清理后 run summary 和关键审计记录仍存在。

## 5. 安全测试

- secret redaction：构造含 secret 的错误与 provider 输出，确认 artifact 不写入。
- env fail-fast：live 缺字段、字段非法、env file 不存在。
- prompt injection：证据文本要求绕过风控时，AI 输出不能越过 RiskEngine。
- schema injection：AI 输出额外字段或非法 action 被拒绝。
- live confirmation replay：旧确认不能复用。
- duplicate order：并发两个 worker 抢同一 decision，只有一个成功。

## 6. 恢复测试

每个关键 stage 都要模拟 crash：

- after scan。
- after evidence。
- after probability estimate。
- after decision。
- after risk plan。
- before broker submit。
- after broker submit before recordOrder。
- after recordOrder before artifact summary。

预期：

- paper 可恢复或标记 failed。
- live 在 broker submit 状态不明时进入 manual review。
- 不重复 live submit。

## 7. 建议验证命令

当前阶段只有文档，验证命令：

```bash
git diff --check -- docs/specs/product-requirements.md docs/specs/architecture.md docs/specs/risk-controls.md docs/specs/testing-plan.md docs/memory/POLYPULSE_MEMORY.md
test -s docs/specs/product-requirements.md
test -s docs/specs/architecture.md
test -s docs/specs/risk-controls.md
test -s docs/specs/testing-plan.md
rg -n "(PRIVATE_KEY|API_KEY|SECRET|TOKEN|COOKIE|SESSION)[[:space:]]*[:=]" docs/specs docs/memory/POLYPULSE_MEMORY.md
```

后续实现阶段建议增加：

```bash
pnpm test
pnpm typecheck
pnpm polypulse scan --dry-run --limit 1000
POLYPULSE_MODE=paper pnpm polypulse monitor --paper --once --archive
POLYPULSE_MODE=live ENV_FILE=<dedicated-env-file> pnpm polypulse preflight
```
