function asNumber(value, fallback = null) {
  if (value == null || value === "") {
    return fallback;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function asDateMs(value) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  const time = date.getTime();
  return Number.isNaN(time) ? null : time;
}

function asBooleanFilter(value) {
  if (value == null || value === "") {
    return null;
  }
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  return Boolean(value);
}

function normalizedWords(value) {
  return String(value ?? "")
    .toLowerCase()
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function matchesCategory(market, categoryKeyword) {
  const words = normalizedWords(categoryKeyword);
  if (words.length === 0) {
    return true;
  }
  const haystack = [
    market.category,
    market.marketSlug,
    market.eventSlug,
    market.question,
    ...(market.tags ?? [])
  ].filter(Boolean).join(" ").toLowerCase();
  return words.some((word) => haystack.includes(word));
}

function matchesTradable(market, tradableOnly) {
  if (tradableOnly == null) {
    return true;
  }
  return Boolean(market.tradable) === Boolean(tradableOnly);
}

function matchesActive(market, activeOnly) {
  if (activeOnly == null) {
    return true;
  }
  return Boolean(market.active) === Boolean(activeOnly);
}

function matchesClosed(market, closedOnly) {
  if (closedOnly == null) {
    return true;
  }
  return Boolean(market.closed) === Boolean(closedOnly);
}

function matchesEndRange(market, endsAfter, endsBefore) {
  const endMs = asDateMs(market.endDate);
  if (endMs == null) {
    return endsAfter == null && endsBefore == null;
  }
  if (endsAfter != null && endMs < endsAfter) {
    return false;
  }
  if (endsBefore != null && endMs > endsBefore) {
    return false;
  }
  return true;
}

export function normalizeMarketFilters(input = {}) {
  const tradable = input.tradableOnly ?? input.tradable;
  const active = input.activeOnly ?? input.active;
  const closed = input.closedOnly ?? input.closed;
  return {
    minLiquidityUsd: asNumber(input.minLiquidityUsd ?? input.minLiquidity, null),
    minVolumeUsd: asNumber(input.minVolumeUsd ?? input.minVolume, null),
    categoryKeyword: input.categoryKeyword ?? input.category ?? null,
    endsAfter: asDateMs(input.endsAfter ?? input.endAfter ?? null),
    endsBefore: asDateMs(input.endsBefore ?? input.endBefore ?? null),
    tradableOnly: asBooleanFilter(tradable),
    activeOnly: asBooleanFilter(active),
    closedOnly: asBooleanFilter(closed)
  };
}

export function applyMarketFilters(markets, input = {}) {
  const filters = normalizeMarketFilters(input);
  return markets.filter((market) => {
    if (filters.minLiquidityUsd != null && market.liquidityUsd < filters.minLiquidityUsd) {
      return false;
    }
    const marketVolume = Math.max(market.volumeUsd ?? 0, market.volume24hUsd ?? 0);
    if (filters.minVolumeUsd != null && marketVolume < filters.minVolumeUsd) {
      return false;
    }
    return matchesCategory(market, filters.categoryKeyword)
      && matchesEndRange(market, filters.endsAfter, filters.endsBefore)
      && matchesTradable(market, filters.tradableOnly)
      && matchesActive(market, filters.activeOnly)
      && matchesClosed(market, filters.closedOnly);
  });
}

export function describeMarketFilters(input = {}) {
  const filters = normalizeMarketFilters(input);
  return {
    minLiquidityUsd: filters.minLiquidityUsd,
    minVolumeUsd: filters.minVolumeUsd,
    categoryKeyword: filters.categoryKeyword,
    endsAfter: filters.endsAfter == null ? null : new Date(filters.endsAfter).toISOString(),
    endsBefore: filters.endsBefore == null ? null : new Date(filters.endsBefore).toISOString(),
    tradableOnly: filters.tradableOnly,
    activeOnly: filters.activeOnly,
    closedOnly: filters.closedOnly
  };
}
