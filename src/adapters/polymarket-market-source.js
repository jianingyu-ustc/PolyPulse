import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { maskAddress } from "../config/env.js";
import { applyMarketFilters, describeMarketFilters } from "./market-filters.js";
import { normalizePolymarketMarket } from "./market-normalizer.js";
import { applyPulseMarketSelection, isPulseDirectStrategy } from "../core/pulse-strategy.js";

function cacheKey(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

function asArrayPayload(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload && typeof payload === "object") {
    for (const key of ["markets", "data", "results"]) {
      if (Array.isArray(payload[key])) {
        return payload[key];
      }
    }
  }
  throw new Error("Polymarket markets payload is not an array.");
}

function errorSummary(error) {
  return error instanceof Error ? error.message : String(error);
}

function clampLimit(value, fallback) {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) ? Math.max(1, Math.floor(number)) : fallback;
}

function parseOffset(cursor) {
  const number = Number(cursor ?? 0);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function retryableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function withQuery(base, params) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

export class PolymarketMarketSource {
  constructor(config, stateStore = null, options = {}) {
    this.config = config;
    this.stateStore = stateStore;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.lastRequestAt = 0;
    this.cachePath = path.join(config.stateDir, "market-cache.json");
  }

  async scan(request = {}) {
    const pulseCompatible = request.pulseCompatible ?? isPulseDirectStrategy(this.config);
    const requestedLimit = clampLimit(request.limit, this.config.scan.marketScanLimit);
    const fetchTarget = pulseCompatible
      ? Math.max(requestedLimit, this.config.scan.minFetchedMarkets ?? requestedLimit)
      : requestedLimit;
    const fetchLimit = clampLimit(fetchTarget, this.config.scan.marketScanLimit);
    const pageSize = Math.min(this.config.scan.pageSize, fetchLimit);
    const startOffset = parseOffset(request.cursor ?? request.offset);
    const filters = describeMarketFilters({
      ...request,
      minLiquidityUsd: request.minLiquidityUsd ?? request.minLiquidity ?? (pulseCompatible ? this.config.pulse?.minLiquidityUsd : null),
      activeOnly: request.activeOnly ?? request.active ?? true,
      closedOnly: request.closedOnly ?? request.closed ?? false,
      tradableOnly: request.tradableOnly ?? request.tradable ?? true
    });
    const key = cacheKey({
      host: this.config.polymarketGammaHost,
      requestedLimit,
      fetchLimit,
      pageSize,
      startOffset,
      filters,
      pulseCompatible
    });
    const cached = await this.readCache(key);
    if (cached?.fresh) {
      return {
        ...cached.entry.scan,
        source: "polymarket-gamma-cache",
        fromCache: true,
        fallback: false,
        riskFlags: [...new Set([...(cached.entry.scan.riskFlags ?? []), "market_scan_cache_hit"])]
      };
    }

    const fetchedAt = new Date().toISOString();
    const rawRows = [];
    const errors = [];
    let offset = startOffset;
    let exhausted = false;

    for (let page = 0; page < this.config.scan.maxPages && rawRows.length < fetchLimit; page += 1) {
      try {
        const rows = await this.fetchMarketPage({ limit: pageSize, offset, filters });
        rawRows.push(...rows);
        offset += rows.length;
        if (rows.length < pageSize) {
          exhausted = true;
          break;
        }
      } catch (error) {
        errors.push(errorSummary(error));
        break;
      }
    }

    if (rawRows.length === 0 && errors.length > 0) {
      return this.fallbackScan({ cached, key, requestedLimit, filters, fetchedAt, errors });
    }

    const normalized = rawRows
      .filter((row) => row && typeof row === "object")
      .map((row) => normalizePolymarketMarket(row, { fetchedAt }));
    const filterPool = applyMarketFilters(normalized, filters);
    const pulseSelection = pulseCompatible
      ? applyPulseMarketSelection(filterPool, {
        maxCandidates: requestedLimit,
        minLiquidityUsd: filters.minLiquidityUsd ?? this.config.pulse?.minLiquidityUsd ?? 0
      })
      : null;
    const filtered = pulseSelection ? pulseSelection.markets : filterPool.slice(0, requestedLimit);
    const riskFlags = this.scanRiskFlags({ normalized, filtered, errors, requestedLimit, pulseSelection });
    const scan = {
      source: "polymarket-gamma",
      fetchedAt,
      fromCache: false,
      fallback: errors.length > 0,
      totalFetched: rawRows.length,
      totalNormalized: normalized.length,
      filteredOut: Math.max(0, normalized.length - filtered.length),
      totalReturned: filtered.length,
      cursor: exhausted ? null : String(offset),
      filters,
      pulse: pulseCompatible ? {
        strategy: "pulse-direct",
        dimensions: this.config.pulse?.fetchDimensions ?? pulseSelection?.dimensions ?? [],
        minLiquidityUsd: filters.minLiquidityUsd ?? null,
        preFilterCount: pulseSelection?.preFilterCount ?? filterPool.length,
        postFilterCount: pulseSelection?.postFilterCount ?? filtered.length,
        removed: pulseSelection?.removed ?? {}
      } : null,
      paging: {
        pageSize,
        startOffset,
        nextOffset: exhausted ? null : offset,
        maxPages: this.config.scan.maxPages
      },
      markets: filtered,
      riskFlags,
      errors
    };
    await this.writeCache(key, scan);
    return scan;
  }

  async getMarket(marketIdOrSlug) {
    const cached = await this.readAnyCachedMarkets();
    const cachedMatch = cached.find((market) =>
      market.marketId === marketIdOrSlug || market.marketSlug === marketIdOrSlug
    );
    if (cachedMatch) {
      return cachedMatch;
    }

    const fetchedAt = new Date().toISOString();
    try {
      const url = withQuery(`${this.config.polymarketGammaHost}/markets`, { slug: marketIdOrSlug });
      const payload = await this.fetchJson(url);
      const markets = asArrayPayload(payload).map((row) => normalizePolymarketMarket(row, { fetchedAt }));
      return markets.find((market) =>
        market.marketId === marketIdOrSlug || market.marketSlug === marketIdOrSlug
      ) ?? markets[0] ?? null;
    } catch {
      const scan = await this.scan({ limit: this.config.scan.marketScanLimit, tradableOnly: null });
      return scan.markets.find((market) =>
        market.marketId === marketIdOrSlug || market.marketSlug === marketIdOrSlug
      ) ?? null;
    }
  }

  async getOrderBook(tokenId) {
    const host = this.config.polymarketHost || "https://clob.polymarket.com";
    try {
      const payload = await this.fetchJson(withQuery(`${host.replace(/\/+$/, "")}/book`, { token_id: tokenId }));
      const bids = Array.isArray(payload?.bids) ? payload.bids : [];
      const asks = Array.isArray(payload?.asks) ? payload.asks : [];
      const bestBid = bids.length > 0 ? Math.max(...bids.map((item) => Number(item.price)).filter(Number.isFinite)) : null;
      const bestAsk = asks.length > 0 ? Math.min(...asks.map((item) => Number(item.price)).filter(Number.isFinite)) : null;
      return {
        tokenId,
        bestBid: Number.isFinite(bestBid) ? bestBid : null,
        bestAsk: Number.isFinite(bestAsk) ? bestAsk : null,
        minOrderSize: Number(payload?.min_order_size ?? payload?.minOrderSize ?? 1),
        asks,
        bids
      };
    } catch {
      return null;
    }
  }

  async getAccountBalance() {
    const portfolio = this.stateStore ? await this.stateStore.getPortfolio() : null;
    return {
      accountId: maskAddress(this.config.funderAddress),
      mode: this.config.executionMode,
      availableUsd: portfolio?.cashUsd ?? 0,
      totalEquityUsd: portfolio?.totalEquityUsd ?? 0,
      openPositions: portfolio?.positions.length ?? 0,
      source: this.config.executionMode === "paper" ? "paper-state" : "offline-preflight",
      updatedAt: new Date().toISOString()
    };
  }

  async getOpenPositions() {
    const portfolio = this.stateStore ? await this.stateStore.getPortfolio() : null;
    return portfolio?.positions ?? [];
  }

  async fetchMarketPage({ limit, offset, filters }) {
    const url = withQuery(`${this.config.polymarketGammaHost}/markets`, {
      limit,
      offset,
      active: filters.activeOnly,
      closed: filters.closedOnly,
      order: "liquidity",
      ascending: "false"
    });
    const payload = await this.fetchJson(url);
    return asArrayPayload(payload);
  }

  async fetchJson(url) {
    let lastError = null;
    for (let attempt = 0; attempt <= this.config.scan.requestRetries; attempt += 1) {
      await this.rateLimit();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.scan.requestTimeoutMs);
      try {
        const response = await this.fetchImpl(url, {
          signal: controller.signal,
          headers: { "user-agent": "PolyPulse/0.1 market-scan" }
        });
        if (!response.ok) {
          const error = new Error(`Polymarket request failed: ${response.status}`);
          error.status = response.status;
          throw error;
        }
        return await response.json();
      } catch (error) {
        lastError = error;
        const status = typeof error === "object" && error != null ? error.status : null;
        if (attempt >= this.config.scan.requestRetries || (status && !retryableStatus(status))) {
          throw error;
        }
        await sleep(150 * (attempt + 1));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError ?? new Error("Polymarket request failed.");
  }

  async rateLimit() {
    const waitMs = this.config.scan.rateLimitMs - (Date.now() - this.lastRequestAt);
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    this.lastRequestAt = Date.now();
  }

  scanRiskFlags({ normalized, filtered, errors, requestedLimit, pulseSelection = null }) {
    const flags = [];
    if (errors.length > 0) {
      flags.push("market_source_partial_failure");
    }
    const minimumFetched = pulseSelection
      ? this.config.scan.minFetchedMarkets
      : Math.min(requestedLimit, this.config.scan.minFetchedMarkets);
    if (normalized.length < minimumFetched) {
      flags.push("market_scan_result_below_minimum");
    }
    if (filtered.length === 0) {
      flags.push("market_scan_empty");
    }
    if (normalized.some((market) => market.riskFlags.length > 0)) {
      flags.push("market_rows_have_risk_flags");
    }
    if (pulseSelection) {
      if (pulseSelection.removed.missingClobTokenIds > 0) flags.push("pulse_missing_clob_token_filtered");
      if (pulseSelection.removed.lowLiquidity > 0) flags.push("pulse_low_liquidity_filtered");
      if (pulseSelection.removed.shortTermPrice > 0) flags.push("pulse_short_term_price_filtered");
      if (pulseSelection.postFilterCount < requestedLimit) flags.push("pulse_candidate_pool_below_requested_limit");
    }
    return flags;
  }

  async fallbackScan({ cached, requestedLimit, filters, fetchedAt, errors }) {
    if (cached?.entry?.scan?.markets?.length) {
      const markets = applyMarketFilters(cached.entry.scan.markets, filters).slice(0, requestedLimit);
      return {
        ...cached.entry.scan,
        source: "polymarket-gamma-cache",
        fetchedAt,
        fromCache: true,
        fallback: true,
        totalReturned: markets.length,
        markets,
        riskFlags: [...new Set([...(cached.entry.scan.riskFlags ?? []), "market_source_fetch_failed", "stale_market_cache_used"])],
        errors
      };
    }
    return {
      source: "polymarket-gamma-error",
      fetchedAt,
      fromCache: false,
      fallback: true,
      totalFetched: 0,
      totalNormalized: 0,
      filteredOut: 0,
      totalReturned: 0,
      cursor: null,
      filters,
      paging: null,
      markets: [],
      riskFlags: ["market_source_fetch_failed", "market_scan_empty"],
      errors
    };
  }

  async readCache(key) {
    const store = await this.readCacheStore();
    const entry = store.entries?.[key] ?? null;
    if (!entry) {
      return null;
    }
    const ageMs = Date.now() - Date.parse(entry.cachedAt);
    return {
      entry,
      fresh: this.config.scan.cacheTtlSeconds > 0 && ageMs >= 0 && ageMs <= this.config.scan.cacheTtlSeconds * 1000
    };
  }

  async readAnyCachedMarkets() {
    const store = await this.readCacheStore();
    return Object.values(store.entries ?? {}).flatMap((entry) => entry.scan?.markets ?? []);
  }

  async readCacheStore() {
    try {
      const parsed = JSON.parse(await readFile(this.cachePath, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : { version: 1, entries: {} };
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { version: 1, entries: {} };
      }
      throw error;
    }
  }

  async writeCache(key, scan) {
    if (this.config.scan.cacheTtlSeconds <= 0) {
      return;
    }
    const store = await this.readCacheStore();
    const entries = Object.fromEntries(Object.entries(store.entries ?? {}).slice(-20));
    entries[key] = {
      cachedAt: new Date().toISOString(),
      scan
    };
    await mkdir(path.dirname(this.cachePath), { recursive: true });
    await writeFile(this.cachePath, JSON.stringify({ version: 1, entries }, null, 2), "utf8");
  }
}
