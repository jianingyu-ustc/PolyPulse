# PolyPulse 风控规格

最后更新：2026-04-30

## 1. 风控目标

PolyPulse 的风控目标是防止 Agent、模型、外部 API、调度器或执行器的错误直接造成真实资金损失。风控必须在服务层强制执行，不能只依赖 prompt、系统消息或模型自律。

## 2. 安全默认值

- 默认模式：paper。
- 默认 broker：PaperBroker。
- 默认 live execution：关闭。
- 默认持久 monitor：recommend-only 或 paper。
- 默认缺失证据：no-trade。
- 默认状态异常：fail-closed。

任何真实下单都必须满足：

1. live mode 显式启用。
2. env preflight 通过。
3. 余额和持仓读取通过。
4. market snapshot 与 order book 可用。
5. RiskEngine 通过。
6. 用户对本次 run 显式确认。

## 3. Secret 与 env 风控

### 3.1 禁止项

- 不把私钥、钱包助记词、API key、cookie、session token 写入日志、memory、artifact、测试快照或 git。
- 不打印完整 env。
- 不在错误对象中透传 secret。
- 不把 provider prompt 中的 secret 写给 AI。

### 3.2 Env preflight

Env 校验必须 fail-fast：

- 缺少 live 必需字段：fail。
- 字段格式非法：fail。
- chain / host / broker kind 不符合运行模式：fail。
- env file 不存在或权限异常：fail。
- signer / funder 不一致：至少 warn；如果策略要求一致则 fail。

Preflight artifact 只能记录：

- env 文件路径。
- 脱敏账户地址。
- 配置摘要。
- 检查项 pass/fail。
- 不记录变量值和 secret。

## 4. AI 输出边界

AI 可以输出：

- 证据摘要。
- 概率估计。
- 置信度。
- 交易建议。
- no-trade 理由。

AI 不可以直接决定：

- 是否绕过风控。
- 是否使用 live broker。
- 是否忽略 env 失败。
- 是否放大订单来满足最小下单额。
- 是否复用旧订单确认。

所有 AI 输出必须：

- 通过 schema 校验。
- 保留证据引用。
- 经过 DecisionEngine 转换。
- 经过 RiskEngine 裁剪。
- 经过 Broker preflight。

## 5. 市场与证据风控

MarketSource 风控：

- 市场必须有 token id。
- 市场必须有可解释的 resolution rules 或被标记为 manual risk。
- 市场 snapshot 必须未过期。
- 价格必须在合理区间。
- 对多 outcome 市场必须明确概率口径。

EvidenceCrawler 风控：

- 抓取失败必须进入 evidence gaps。
- stale evidence 只能用于低置信度判断，不能直接 live execute。
- 来源冲突时必须记录冲突，不得只保留支持交易的一侧。

ProbabilityEstimator 风控：

- 概率必须在 `[0, 1]`。
- 低证据覆盖率时降低 confidence。
- 无法估计时输出 no-estimate。
- 禁止把 market price 原样当作 AI 概率。

## 6. 交易风控

### 6.1 系统级

- `paused`：禁止新开仓，允许同步、报告、人工 close。
- `halted`：禁止新开仓，live 下单默认全部 blocked，恢复需要管理员确认。
- 最大日亏损、最大回撤、最大连续失败 run 数应作为配置项。

### 6.2 仓位级

- 单市场最大仓位。
- 单事件最大敞口。
- 单 outcome 最大敞口。
- 最大并发持仓数。
- 单仓止损阈值。
- 接近止损时可 reduce 或 require human review。

### 6.3 订单级

- 单笔最大 notional。
- 最小内部交易额。
- 交易所最小单。
- slippage cap。
- spread cap。
- order book depth cap。
- fee-adjusted net edge threshold。

### 6.4 Sizing 规则

Sizing 可采用 Kelly、固定比例、分层仓位或策略自定义方法，但 RiskEngine 必须满足：

- 只向下裁剪。
- 不为满足最小单而放大。
- 不超过 liquidity cap。
- 不超过 order book slippage cap。
- 不超过 bankroll 和 exposure caps。

## 7. Live 确认规则

Live confirmation 必须绑定：

- run id。
- account ref 或 env fingerprint。
- market id。
- token id。
- side。
- action。
- max amount。
- risk plan hash。
- generated_at 与 expires_at。

确认过期、字段不匹配、plan hash 变化、market snapshot 过期时必须重新 dry-run。

## 8. 持久监控风控

Paper monitor：

- 可自动执行 paper order。
- 必须持久保存 cursor、dedupe key、run stage。
- 崩溃恢复后不得重复 paper order，除非策略明确允许加仓且新 dedupe key 不同。

Live monitor：

- 默认 recommend-only。
- 自动 live 必须显式配置并由用户确认。
- 每轮 live 执行前必须重新 preflight。
- 必须有 allowlist 或 max risk envelope。
- 必须获取 dedupe lock。
- 必须先写 dry-run artifact。

## 9. 去重与重复误下单防护

同一个市场/事件不能重复误下单。系统必须使用两层防护：

1. Decision dedupe：同一 strategy/event/market/token/side/action/timeWindow 只生成一次可执行决策。
2. Broker idempotency：同一 run/decision/account 只提交一次 broker order。

恢复逻辑：

- 如果没有 broker order id，可重新执行 RiskEngine。
- 如果已有 broker order id，必须查询 broker 状态。
- 状态未知时进入 manual review，不重复提交。

## 10. 外部 API 失败处理

可重试：

- 网络 timeout。
- 429。
- 临时 5xx。
- provider schema retry。

不可重试：

- env 缺失。
- live 未确认。
- 余额不足。
- token 不在 snapshot。
- order book 缺失。
- dedupe lock 已存在。

降级规则：

- MarketSource 失败：本轮 scan failed 或使用明确标记的 stale snapshot 仅 recommend-only。
- EvidenceCrawler 失败：记录 evidence gaps，降低 confidence 或 no-trade。
- ProbabilityEstimator 失败：no-estimate / no-trade。
- Broker 失败：live fail-fast，paper 可记录 rejected。

## 11. Artifact 与 memory 风控

- ArtifactWriter 写入前执行 secret redaction。
- runtime artifacts 有保留期。
- 大体积原始抓取内容可压缩或摘要化。
- memory 只写阶段结论、设计权衡、失败原因和验证观察，不写无限增长的原始输出。
- 清理策略必须保留 run summary、decision、risk result、execution result 的索引。

## 12. 风控验收清单

- 默认 paper。
- live 没有确认时 blocked。
- AI 输出越权字段时被 schema 或 RiskEngine 拒绝。
- env 缺失 fail-fast。
- 低流动性订单被 skip。
- 裁剪后低于最小单被 skip。
- duplicate lock 生效。
- crash recovery 不重复 live submit。
- artifact 不含 secret。
- 风控阈值有单一配置事实源。
