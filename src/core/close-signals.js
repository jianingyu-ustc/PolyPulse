export function closeSignal(position, config) {
  if (position.marketClosed) return "market_closed";
  if (config.monitor?.holdUntilSettlement) return null;
  if (position.currentPrice >= 0.99) return "near_full_value";
  if (position.currentPrice <= 0.01) return "near_zero_value";
  const lossPct = position.costUsd > 0
    ? (position.costUsd - position.currentValueUsd) / position.costUsd
    : 0;
  if (lossPct >= config.risk.maxPositionLossPct) return "stop_loss";
  return null;
}
