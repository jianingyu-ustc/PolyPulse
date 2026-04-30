# PolyPulse 从 Predict-Raven 学到什么，不复制什么

本阶段只阅读 Predict-Raven，不实现 PolyPulse 交易逻辑。结论面向后续开发：PolyPulse 应学习其安全边界、可审计性和模块拆分，但不要复制它的默认 live 行为、账户习惯或具体技术栈。

## 应学习的设计

### 1. 四层交易链路

Predict-Raven 的主链路很清晰：

```text
Market Pulse / Research
  -> Decision Runtime
  -> Execution Planning / Risk
  -> State / Archive / UI
```

PolyPulse 应沿用这种职责拆分。市场抓取、证据收集、概率预测、交易决策、风控裁剪、真实执行和归档展示应该是不同模块，不能混在一个脚本里。

### 2. 风控是代码规则，不是提示词

Predict-Raven 的关键经验是：Agent 可以负责研究和提出判断，但最终执行必须经过服务层硬规则。PolyPulse 后续至少要保留这些 guardrails：

- 系统状态 `running / paused / halted`，非 running 禁止新开仓。
- 单笔、总敞口、单事件敞口、最大持仓数、最小单、slippage cap。
- open 的 token 必须来自当前 market snapshot。
- close/reduce 的 token 必须来自当前持仓。
- 风控只向下裁剪，不能为了满足最小单而放大仓位。

### 3. 推荐、dry-run、live 分层

Predict-Raven 已有 `recommend-only`、paper awaiting approval、live preflight 等阶段。PolyPulse 应把这个思想作为默认产品行为：

- 默认 recommend-only 或 paper。
- live 必须 preflight。
- live execute 必须有显式确认。
- 每个阶段都要有归档，而不是只在真实下单后才记录。

### 4. 强契约输出

`TradeDecisionSet` 这种 schema 很值得学习。PolyPulse 应先定义自己的共享契约：

- market snapshot
- evidence bundle
- probability estimate
- trade decision set
- risk-adjusted execution plan
- execution result
- run artifact

这样后续无论用 TypeScript、Python，还是多语言服务，都可以围绕接口演进。

### 5. pulse-direct 思路

Predict-Raven 的 `pulse-direct` 把外部 AI 输出从“直接下单决策”降级为“研究报告输入”，再由代码解析、排序、重算 Kelly、复审持仓、合并决策。这比让 provider-runtime 直接输出交易 JSON 更可测试。

PolyPulse 应优先学习这个方向：AI 负责证据和概率判断，代码负责 sizing、排序、风控和执行边界。

### 6. 失败可追溯

Predict-Raven 对运行产物和失败诊断很重视：

- Pulse Markdown / JSON
- runtime log
- recommendation.json
- preflight.json
- execution-summary.json
- error.json
- checkpoint
- run-summary.md

PolyPulse 后续也要让每一次 no-trade、blocked trade、dry-run、live execution 都能复盘。

## 不应复制的实现

### 1. 不复制默认 live 行为

Predict-Raven 的 `daily:pulse` / `pulse:live` 默认可能真实下单，这是源项目的选择。PolyPulse 项目安全要求不同：默认必须 safe，不允许 skill 或命令默认实盘。

PolyPulse 的 live 命令必须是显式 opt-in：

```text
preflight -> recommend-only / dry-run -> explicit live confirmation -> execute
```

### 2. 不复制账户和 env 习惯

不要复制 `.env.pizza`、真实钱包默认值、活跃账户命名或任何源仓库私有运行习惯。PolyPulse 文档和 skill 只能写变量名、占位符和专用 env 文件要求。

### 3. 不复制技术栈绑定

Predict-Raven 是 pnpm monorepo、TypeScript、Drizzle、BullMQ、Postgres、Redis、Vercel/Hostinger 组合。PolyPulse 现在不应过早绑定这些选择。

后续应先定义模块边界和性能目标，再根据需求选择实现：

- market data provider
- evidence collector
- probability estimator
- decision planner
- risk engine
- execution adapter
- artifact store

### 4. 不复制文档与代码漂移

阅读中发现 Predict-Raven 的 README、风险文档和代码默认阈值存在不一致。PolyPulse 应从第一天就建立单一配置事实源，并用测试或文档生成避免漂移。

### 5. 不复制 provider 过宽权限

Predict-Raven 的 provider-runtime 通过外部 CLI 运行，需要大量约束才能安全。PolyPulse 如果支持 provider，应该默认只给最小输入：market snapshot、evidence bundle、risk docs、schema，不让 provider 扫描无关仓库文件。

### 6. 不复制 fallback 交易启发式

源仓库曾有 deterministic fallback 报告函数，但当前 full pulse 渲染失败会直接 throw。PolyPulse 应采用这个更安全的方向：证据不足或报告失败时 no-trade，而不是用启发式凑出开仓建议。

## PolyPulse 的开发原则

1. 先接口，后实现。
2. AI 负责证据和概率，代码负责风控和执行。
3. 默认安全，不默认 live。
4. 每轮运行都有归档。
5. 不把 secrets 写入日志、memory、测试快照或 git。
6. paper 与 live 共享同一套 decision/risk 逻辑。
7. live adapter 必须 fail-closed。

## 本阶段验证

本阶段只创建文档与 skill，未实现业务功能。验证命令：

```bash
git diff --check -- docs/memory/POLYPULSE_MEMORY.md skills/polypulse-market-agent/SKILL.md docs/learned-from-predict-raven.md
test -s docs/memory/POLYPULSE_MEMORY.md
test -s skills/polypulse-market-agent/SKILL.md
test -s docs/learned-from-predict-raven.md
```
