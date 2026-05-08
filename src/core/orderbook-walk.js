export function walkAskBook(asks, maxImpactPct = 0.04) {
  if (!Array.isArray(asks) || asks.length === 0) {
    return { maxNotionalUsd: Infinity, depthShares: 0, depthLevels: 0, impactPct: 0 };
  }
  const sorted = [...asks]
    .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
    .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.price > 0 && l.size > 0)
    .sort((a, b) => a.price - b.price);

  if (sorted.length === 0) {
    return { maxNotionalUsd: Infinity, depthShares: 0, depthLevels: 0, impactPct: 0 };
  }

  const bestAsk = sorted[0].price;
  const ceiling = bestAsk * (1 + maxImpactPct);
  let totalShares = 0;
  let totalNotional = 0;
  let levelsConsumed = 0;
  let lastPrice = bestAsk;

  for (const level of sorted) {
    if (level.price > ceiling) break;
    totalShares += level.size;
    totalNotional += level.price * level.size;
    levelsConsumed += 1;
    lastPrice = level.price;
  }

  const impactPct = bestAsk > 0 ? (lastPrice - bestAsk) / bestAsk : 0;

  return {
    maxNotionalUsd: Number(totalNotional.toFixed(4)),
    depthShares: Number(totalShares.toFixed(4)),
    depthLevels: levelsConsumed,
    impactPct: Number(impactPct.toFixed(6))
  };
}

export function validateMinOrderSize({ amountUsd, bestAsk, minOrderSize }) {
  if (!Number.isFinite(bestAsk) || bestAsk <= 0) {
    return { valid: true, sharesAtBestAsk: 0, minRequired: minOrderSize, reason: null };
  }
  const shares = amountUsd / bestAsk;
  const valid = shares >= minOrderSize;
  return {
    valid,
    sharesAtBestAsk: Number(shares.toFixed(4)),
    minRequired: minOrderSize,
    reason: valid ? null : "below_exchange_minimum_order_size"
  };
}
