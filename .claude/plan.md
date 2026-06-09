# Paper/Live 逻辑统一计划

## 需要统一的差异（9 项）

以 paper 分支 (`runSimulatedMonitorRound`) 作为"完整逻辑"基准，补齐 live 分支 (`runMonitorRound`) 缺失的逻辑。

### 1. `suppressProviderRuntimeArtifacts` 移除
- **文件**: `src/scheduler/scheduler.js` 构造函数 (line 483-484)
- **改动**: 去掉 paper 的 suppress，两种模式都正常写 provider runtime artifact

### 2. scan `noCache: true`
- **文件**: `src/scheduler/scheduler.js` live 分支 (line 2246)
- **改动**: `scan(limit == null ? {} : { limit })` → `scan({ ...(limit == null ? {} : { limit }), noCache: true })`

### 3. `applyTopicDiscovery`
- **文件**: `src/scheduler/scheduler.js` live 分支 (after scan, before reviewPositions)
- **改动**: 在 logScan 后加 `await this.applyTopicDiscovery({ accumulator, ledger: loggerAsLedger });`
- 需要构造一个 ledger shim 给 applyTopicDiscovery (它只用 `ledger.log`)

### 4. `predictCandidateNoCache` 替代 `predictCandidate`
- **文件**: `src/scheduler/scheduler.js` live 分支 (line 2269, 2288)
- **改动**: 将 `predictCandidate` 改为 `predictCandidateNoCache`

### 5. `downsideRiskRanker` 排序
- **文件**: `src/scheduler/scheduler.js` live 分支 (line 2305 附近)
- **改动**: 在 `rankPredictionsForExecution` 外面包一层 `downsideRiskRanker.rankWithDownsideRisk`（和 paper 一致）

### 6. `candidate.ranked` 日志 + `predictionTracker.recordPrediction`
- **文件**: `src/scheduler/scheduler.js` live 分支 (在 ranked 之后, order 循环之前)
- **改动**: 加循环记录 ranked 日志和 predictionTracker

### 7. 套利执行 (`_executeArbitrageOpportunities`)
- **文件**: `src/scheduler/scheduler.js` live 分支 (line 2318 附近)
- **改动**: 加 arbitrage 日志 + `_executeArbitrageOpportunities`
- 注意: _executeArbitrageOpportunities 使用 `ledger.openPosition`，live 模式需要走真实下单。需要提供一个 ledger adapter 或直接调用 broker。

### 8. `predictionTracker.shouldEmitReport`/`emitReport`
- **文件**: `src/scheduler/scheduler.js` live 分支 (在 withTimeout 之后, return 之前)
- **改动**: 加 `if (this.predictionTracker.shouldEmitReport()) await this.predictionTracker.emitReport(logger);`

### 9. `recordSkippedCandidate` on blocked orders
- **文件**: `src/scheduler/scheduler.js` live 分支 (order 循环中)
- **改动**: 当 order 未 filled 时记录 skipped candidate（live 版用 logger 记录即可）

---

## 关于 `_executeArbitrageOpportunities` 的适配

该方法使用 `ledger.openPosition()` 模拟下单。在 live 模式中需要：
- 构造一个 `ledgerAdapter` 对象，其 `openPosition` 方法调用真实 broker 下单
- 或者让 `_executeArbitrageOpportunities` 接受一个可选的 `broker` 参数，live 时走真实路径

考虑到套利逻辑比较复杂且当前 live 分支本来就没有执行套利（只检测），我建议先让 live 分支也能调用 `_executeArbitrageOpportunities`，通过传入一个 live-mode 的 ledger adapter。

## 关于 logger/ledger shim

Live 分支已有 `monitorLogger`，但许多 paper 分支的函数需要一个 `ledger` 对象（含 `log`、`recordSkippedCandidate`、`openPosition` 等）。

方案：构造一个统一的 `ledgerShim` 对象给 live 分支使用：
```js
const ledgerShim = {
  log: (msg, f) => logger.log(msg, f),
  recordSkippedCandidate: () => {},
  // openPosition/closePosition: 由真实 broker 处理，不在 shim 中
};
```

## 改动文件汇总

仅 `src/scheduler/scheduler.js` 一个文件的 live 分支部分。
